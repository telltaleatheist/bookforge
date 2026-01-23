import { Component, inject, signal, computed, HostListener, ViewChild, ElementRef, effect, DestroyRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService, Chapter } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction, BlockEdit } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
import { ExportService, DeletedHighlight } from './services/export.service';
import { PageRenderService } from './services/page-render.service';
import { OcrPostProcessorService } from './services/ocr-post-processor.service';
import { DesktopThemeService, UiSize } from '../../creamsicle-desktop/services/theme.service';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { PdfViewerComponent, CropRect } from './components/pdf-viewer/pdf-viewer.component';
import { CategoriesPanelComponent } from './components/categories-panel/categories-panel.component';
import { FilePickerComponent } from './components/file-picker/file-picker.component';
import { CropPanelComponent } from './components/crop-panel/crop-panel.component';
import { SplitPanelComponent, SplitConfig } from './components/split-panel/split-panel.component';
import { ChaptersPanelComponent } from './components/chapters-panel/chapters-panel.component';
import { LibraryViewComponent, ProjectFile } from './components/library-view/library-view.component';
import { TabBarComponent, DocumentTab } from './components/tab-bar/tab-bar.component';
import { OcrSettingsModalComponent, OcrSettings, OcrPageResult, OcrCompletionEvent } from './components/ocr-settings-modal/ocr-settings-modal.component';
import { InlineTextEditorComponent, TextEditResult } from './components/inline-text-editor/inline-text-editor.component';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, ExportFormat } from './components/export-settings-modal/export-settings-modal.component';
import { BackgroundProgressComponent, BackgroundJob } from './components/background-progress/background-progress.component';
import { OcrJobService, OcrJob } from './services/ocr-job.service';

interface OpenDocument {
  id: string;
  path: string;           // Original path (for display)
  libraryPath: string;    // Path to file in library (used for actual operations)
  fileHash: string;       // SHA256 hash of the file
  name: string;
  blocks: TextBlock[];
  categories: Record<string, Category>;
  pageDimensions: PageDimension[];
  totalPages: number;
  deletedBlockIds: Set<string>;
  deletedPages: Set<number>;  // Pages excluded from export
  selectedBlockIds: string[];
  pageOrder: number[]; // Custom page order for organize mode
  pageImages: Map<number, string>;
  hasUnsavedChanges: boolean;
  projectPath: string | null;
  undoStack: HistoryAction[];
  redoStack: HistoryAction[];
  lightweightMode?: boolean;  // Process without rendering pages
}


// Serializable custom category for project persistence
interface CustomCategoryData {
  category: {
    id: string;
    name: string;
    description: string;
    color: string;
    block_count: number;
    char_count: number;
    font_size: number;
    region: string;
    sample_text: string;
  };
  highlights: Record<number, Array<{ page: number; x: number; y: number; w: number; h: number; text: string }>>;
}

// Serializable block edit for project persistence
interface BlockEditData {
  text?: string;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
}

// Metadata for EPUB export
export interface BookMetadata {
  title?: string;
  author?: string;
  authorFileAs?: string;  // "Last, First" format for sorting
  year?: string;
  language?: string;
  publisher?: string;
  description?: string;
  coverImage?: string;  // Base64 data URL for cover image
}

interface BookForgeProject {
  version: number;
  source_path: string;    // Original path
  source_name: string;
  library_path?: string;  // Path to copy in library
  file_hash?: string;     // SHA256 hash for duplicate detection
  deleted_block_ids: string[];
  deleted_highlight_ids?: string[];  // Deleted custom category highlights
  page_order?: number[];  // Custom page order for organize mode
  custom_categories?: CustomCategoryData[];  // User-created categories with regex/sample matches
  block_edits?: Record<string, BlockEditData>;  // All block edits: text, position, size
  text_corrections?: Record<string, string>;  // Legacy: OCR corrections only
  undo_stack?: HistoryAction[];  // Persisted undo history
  redo_stack?: HistoryAction[];  // Persisted redo history
  remove_backgrounds?: boolean;  // Background removal state
  ocr_blocks?: TextBlock[];  // OCR-generated blocks (independent from PDF analysis)
  ocr_categories?: Record<string, Category>;  // Categories matching OCR block categorization
  chapters?: Chapter[];  // Chapter markers for export
  chapters_source?: 'toc' | 'heuristic' | 'manual' | 'mixed';  // How chapters were determined
  deleted_pages?: number[];  // Pages to exclude from export (0-indexed)
  metadata?: BookMetadata;  // Book metadata for EPUB export
  created_at: string;
  modified_at: string;
}

// Lightweight match rectangle for custom category highlights
// (~40 bytes vs ~200 for full TextBlock)
interface MatchRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

// Custom category highlights stored by category ID, then by page for O(1) lookup
type CategoryHighlights = Map<string, Record<number, MatchRect[]>>;

// Editor modes
type EditorMode = 'select' | 'edit' | 'crop' | 'organize' | 'split' | 'ocr' | 'chapters';

interface ModeInfo {
  id: EditorMode;
  icon: string;
  label: string;
  tooltip: string;
}

// Alert modal
interface AlertModal {
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

@Component({
  selector: 'app-pdf-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    DesktopButtonComponent,
    PdfViewerComponent,
    CategoriesPanelComponent,
    FilePickerComponent,
    CropPanelComponent,
    SplitPanelComponent,
    ChaptersPanelComponent,
    LibraryViewComponent,
    TabBarComponent,
    OcrSettingsModalComponent,
    InlineTextEditorComponent,
    ExportSettingsModalComponent,
    BackgroundProgressComponent,
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
      (dropdownItemClicked)="onDropdownItemClicked($event)"
    >
    </desktop-toolbar>

    <!-- Search Bar -->
    @if (showSearch()) {
      <div class="search-bar">
        <div class="search-input-container">
          <span class="search-icon">🔍</span>
          <input
            #searchInput
            type="text"
            class="search-input"
            placeholder="Search text..."
            [value]="searchQuery()"
            (input)="onSearchInput($event)"
            (keydown.enter)="goToNextResult()"
            (keydown.shift.enter)="goToPrevResult()"
          />
          @if (searchQuery()) {
            <button class="search-clear" (click)="clearSearch()" title="Clear">×</button>
          }
        </div>
        <div class="search-controls">
          <button
            class="search-nav-btn"
            [disabled]="searchResults().length === 0"
            (click)="goToPrevResult()"
            title="Previous (Shift+Enter)"
          >▲</button>
          <button
            class="search-nav-btn"
            [disabled]="searchResults().length === 0"
            (click)="goToNextResult()"
            title="Next (Enter)"
          >▼</button>
          <span class="search-count">
            @if (searchResults().length > 0) {
              {{ currentSearchIndex() + 1 }} / {{ searchResults().length }}
            } @else if (searchQuery()) {
              No results
            }
          </span>
        </div>
        <button class="search-close" (click)="closeSearch()" title="Close (Esc)">×</button>
      </div>
    }

    <!-- Tab Bar for open documents -->
    <app-tab-bar
      [tabs]="documentTabs()"
      [activeTabId]="activeTabId()"
      (tabSelected)="onTabSelected($event)"
      (tabClosed)="onTabClosed($event)"
      (newTab)="showFilePicker.set(true)"
    />

    <!-- Main Layout -->
    @if (pdfLoaded()) {
      <desktop-split-pane
        direction="horizontal"
        [primarySize]="splitSize()"
        [minSize]="400"
        [maxSize]="3000"
        (sizeChanged)="onSplitSizeChanged($event)"
      >
        <!-- PDF Viewer (Primary) with Left Tools Sidebar -->
        <div pane-primary class="viewer-pane-container">
          <!-- Left Tools Sidebar -->
          <div
            class="tools-sidebar"
            [style.width.px]="toolsSidebarWidth()"
          >
            <div class="tools-section">
              <div class="tools-label">Tools</div>
              @for (mode of modes; track mode.id) {
                <button
                  class="menu-item"
                  [class.active]="currentMode() === mode.id"
                  [class.disabled]="lightweightMode() && mode.id !== 'ocr'"
                  [title]="lightweightMode() && mode.id !== 'ocr' ? 'Not available in lightweight mode' : mode.tooltip"
                  [disabled]="lightweightMode() && mode.id !== 'ocr'"
                  (click)="setMode(mode.id)"
                >
                  <span class="menu-icon">{{ mode.icon }}</span>
                  <span class="menu-text">{{ mode.label }}</span>
                </button>
              }
            </div>

            <div class="tools-divider"></div>

            <div class="tools-section">
              <div class="tools-label">Rendering</div>
              <button
                class="menu-item"
                [class.active]="removeBackgrounds()"
                title="Remove background images (yellowed paper)"
                (click)="toggleRemoveBackgrounds()"
              >
                <span class="menu-icon">🖼️</span>
                <span class="menu-text">Remove Backgrounds</span>
              </button>
              <button
                class="menu-item"
                [class.disabled]="lightweightMode()"
                [disabled]="lightweightMode()"
                [title]="lightweightMode() ? 'Not available in lightweight mode' : 'Re-render all pages'"
                (click)="reRenderPages()"
              >
                <span class="menu-icon">🔄</span>
                <span class="menu-text">Re-render Pages</span>
              </button>
            </div>

            <!-- Resize Handle -->
            <div
              class="sidebar-resize-handle"
              (mousedown)="onSidebarResizeStart($event)"
            ></div>
          </div>

          <!-- Viewer + Timeline wrapper (stacked vertically) -->
          <div class="viewer-timeline-wrapper">
            <!-- Viewer -->
            <div class="viewer-pane">
              @if (lightweightMode()) {
                <div class="lightweight-placeholder">
                  <div class="placeholder-content">
                    <span class="placeholder-icon">⚡</span>
                    <h2>Processing Without Rendering</h2>
                    <p>Pages are not rendered to save memory for large files.</p>
                    <p>Available actions:</p>
                    <ul>
                      <li>• OCR text extraction</li>
                      <li>• Remove backgrounds</li>
                      <li>• Export to various formats</li>
                    </ul>
                  </div>
                </div>
              } @else {
                <app-pdf-viewer
                [blocks]="blocks()"
                [categories]="categoriesWithPreview()"
              [categoryHighlights]="combinedHighlights()"
              [deletedHighlightIds]="deletedHighlightIds()"
              [correctedBlockIds]="correctedBlockIds()"
              [blockOffsets]="blockOffsets()"
              [textCorrections]="textCorrections()"
              [blockSizes]="blockSizes()"
              [pageDimensions]="pageDimensions()"
              [totalPages]="totalPages()"
              [zoom]="zoom()"
              [layout]="layout()"
              [selectedBlockIds]="selectedBlockIds()"
              [deletedBlockIds]="deletedBlockIds()"
              [pdfLoaded]="pdfLoaded()"
              [cropMode]="cropMode()"
              [cropCurrentPage]="cropCurrentPage()"
              [editorMode]="currentMode()"
              [pageOrder]="pageOrder()"
              [splitMode]="splitMode()"
              [splitEnabled]="splitConfig().enabled"
              [splitPositionFn]="getSplitPositionForPage.bind(this)"
              [skippedPages]="splitConfig().skippedPages"
              [sampleMode]="sampleMode()"
              [sampleRects]="sampleRects()"
              [sampleCurrentRect]="sampleDrawingRect()"
              [regexSearchMode]="regexPanelExpanded()"
              [removeBackgrounds]="removeBackgrounds()"
              [blankedPages]="blankedPages()"
              [pageImages]="pageImages()"
              [chapters]="chapters()"
              [chaptersMode]="chaptersMode()"
              [deletedPages]="deletedPages()"
              [selectedPages]="selectedPageNumbers()"
              [organizeMode]="organizeMode()"
              (blockClick)="onBlockClick($event)"
              (chapterClick)="onChapterClick($event)"
              (chapterPlacement)="onChapterPlacement($event)"
              (chapterDrag)="onChapterDrag($event)"
              (chapterDelete)="removeChapter($event)"
              (pageDeleteToggle)="togglePageDeleted($event)"
              (pageSelect)="onPageSelect($event)"
              (deleteSelectedPages)="onDeleteSelectedPages($event)"
              (blockDoubleClick)="onBlockDoubleClick($event)"
              (blockHover)="onBlockHover($event)"
              (selectLikeThis)="selectLikeThis($event)"
              (deleteLikeThis)="deleteLikeThis($event)"
              (deleteBlock)="deleteBlock($event)"
              (highlightClick)="onHighlightClick($event)"
              (revertBlock)="revertBlockText($event)"
              (zoomChange)="onZoomChange($event)"
              (selectAllOnPage)="selectAllOnPage($event)"
              (deselectAllOnPage)="deselectAllOnPage($event)"
              (cropComplete)="onCropComplete($event)"
              (marqueeSelect)="onMarqueeSelect($event)"
              (pageReorder)="onPageReorder($event)"
              (splitPositionChange)="onSplitPositionChange($event)"
              (splitPageToggle)="onSplitPageToggle($event)"
              (sampleMouseDown)="onSampleMouseDown($event.event, $event.page, $event.pageX, $event.pageY)"
              (sampleMouseMove)="onSampleMouseMove($event.pageX, $event.pageY)"
              (sampleMouseUp)="onSampleMouseUp()"
              (blockMoved)="onBlockMoved($event)"
              (blockDragEnd)="onBlockDragEnd($event)"
              [getPageImageUrl]="getPageImageUrl.bind(this)"
            />
              }
            </div>

            <!-- Page Timeline (bottom of viewer) -->
            <div class="page-timeline">
              <div class="timeline-header">
                <span class="timeline-label">
                  {{ totalPages() }} pages
                  @if (pagesLoaded() < totalPages()) {
                    · <span class="loading-status"><span class="mini-spinner"></span> Loading {{ pagesLoaded() }}/{{ totalPages() }}</span>
                  }
                  @if (selectedBlockIds().length > 0) {
                    · {{ selectedBlockIds().length }} selected on {{ pagesWithSelections().size }} pages
                  }
                </span>
              </div>
              <div class="timeline-scroll">
                @for (pageNum of pageNumbers(); track pageNum) {
                  <button
                    class="timeline-thumb"
                    [class.has-selection]="timelineHighlights().has(pageNum)"
                    [class.regex-match]="regexPanelExpanded() && timelineHighlights().has(pageNum)"
                    [title]="'Page ' + (pageNum + 1) + (timelineHighlights().get(pageNum) ? ' (' + timelineHighlights().get(pageNum) + (regexPanelExpanded() ? ' matches' : ' selected') + ')' : '')"
                    (click)="scrollToPage(pageNum)"
                  >
                    @if (getPageImageUrl(pageNum) && getPageImageUrl(pageNum) !== 'loading') {
                      <img [src]="getPageImageUrl(pageNum)" alt="Page {{ pageNum + 1 }}" />
                    }
                    <span class="thumb-label">{{ pageNum + 1 }}</span>
                    @if (timelineHighlights().get(pageNum)) {
                      <span class="thumb-count">{{ timelineHighlights().get(pageNum) }}</span>
                    }
                  </button>
                }
              </div>
            </div>

          </div>
        </div>

        <!-- Side Panel (Secondary) -->
        @if (cropMode()) {
          <app-crop-panel
            pane-secondary
            [currentPage]="cropCurrentPage()"
            [totalPages]="totalPages()"
            [cropRect]="currentCropRect()"
            (prevPage)="cropPrevPage()"
            (nextPage)="cropNextPage()"
            (cancel)="cancelCrop()"
            (apply)="applyCropFromPanel($event)"
          />
        } @else if (splitMode()) {
          <app-split-panel
            pane-secondary
            [config]="splitConfig()"
            [currentPage]="splitPreviewPage()"
            [totalPages]="totalPages()"
            [deskewing]="deskewing()"
            [lastDeskewAngle]="lastDeskewAngle()"
            (prevPage)="splitPrevPage()"
            (nextPage)="splitNextPage()"
            (cancel)="cancelSplitMode()"
            (apply)="applySplit()"
            (configChange)="onSplitConfigChange($event)"
            (deskewCurrentPage)="deskewCurrentPage()"
            (deskewAllPages)="deskewAllPages()"
          />
        } @else if (chaptersMode()) {
          <app-chapters-panel
            pane-secondary
            [chapters]="chapters()"
            [chaptersSource]="chaptersSource()"
            [detecting]="detectingChapters()"
            [finalizing]="finalizingChapters()"
            [selectedChapterId]="selectedChapterId()"
            [metadata]="metadata()"
            [sourceName]="pdfName()"
            (cancel)="exitChaptersMode()"
            (autoDetect)="autoDetectChapters()"
            (clearChapters)="clearAllChapters()"
            (selectChapter)="selectChapter($event)"
            (removeChapter)="removeChapter($event)"
            (renameChapter)="renameChapter($event)"
            (finalizeChapters)="finalizeChapters()"
            (metadataChange)="onMetadataChange($event)"
            (saveMetadata)="onSaveMetadata()"
          />
        } @else {
          <app-categories-panel
            pane-secondary
            [categories]="categoriesArray()"
            [blocks]="blocks()"
            [selectedBlockIds]="selectedBlockIds()"
            [includedChars]="includedChars()"
            [excludedChars]="excludedChars()"
            [regexName]="regexCategoryName()"
            [regexPattern]="regexPattern()"
            [regexColor]="regexCategoryColor()"
            [regexMinFontSize]="regexMinFontSize()"
            [regexMaxFontSize]="regexMaxFontSize()"
            [regexMinBaseline]="regexMinBaseline()"
            [regexMaxBaseline]="regexMaxBaseline()"
            [regexCaseSensitive]="regexCaseSensitive()"
            [regexLiteralMode]="regexLiteralMode()"
            [regexCategoryFilter]="regexCategoryFilter()"
            [regexPageFilterType]="regexPageFilterType()"
            [regexPageRangeStart]="regexPageRangeStart()"
            [regexPageRangeEnd]="regexPageRangeEnd()"
            [regexSpecificPages]="regexSpecificPages()"
            [regexMatches]="regexMatches()"
            [regexMatchCount]="regexMatchCount()"
            [isEditing]="!!editingCategoryId()"
            (selectCategory)="selectAllOfCategory($event)"
            (selectInverse)="selectInverseOfCategory($event)"
            (selectAll)="selectAllBlocks()"
            (deselectAll)="clearSelection()"
            (enterSampleMode)="enterSampleMode()"
            (deleteCategory)="deleteCustomCategory($event)"
            (editCategory)="editCustomCategory($event)"
            (toggleCategory)="toggleCategoryEnabled($event)"
            (regexNameChange)="regexCategoryName.set($event)"
            (regexPatternChange)="onRegexPatternChange($event)"
            (regexColorChange)="regexCategoryColor.set($event)"
            (regexMinFontSizeChange)="onMinFontSizeChange($event)"
            (regexMaxFontSizeChange)="onMaxFontSizeChange($event)"
            (regexMinBaselineChange)="onMinBaselineChange($event?.toString() ?? '')"
            (regexMaxBaselineChange)="onMaxBaselineChange($event?.toString() ?? '')"
            (regexCaseSensitiveChange)="onCaseSensitiveChange($event)"
            (regexLiteralModeChange)="onLiteralModeChange($event)"
            (regexCategoryFilterChange)="onCategoryFilterChange($event)"
            (regexPageFilterTypeChange)="onPageFilterTypeChange($event)"
            (regexPageRangeStartChange)="onPageRangeStartChange($event)"
            (regexPageRangeEndChange)="onPageRangeEndChange($event)"
            (regexSpecificPagesChange)="onSpecificPagesChange($event)"
            (createRegexCategory)="createRegexCategory()"
            (regexExpandedChange)="onRegexExpandedChange($event)"
          />
        }
      </desktop-split-pane>
    } @else {
      <!-- Library View when no PDF loaded -->
      <div class="library-container">
        <app-library-view
          (openFile)="showFilePicker.set(true)"
          (fileSelected)="loadPdf($event)"
          (projectSelected)="loadProjectFromPath($event)"
          (projectsSelected)="onLibraryProjectsSelected($event)"
          (clearCache)="onClearCache($event)"
          (projectsDeleted)="onProjectsDeleted($event)"
          (error)="onLibraryError($event)"
          (transferToAudiobook)="onTransferToAudiobook($event)"
          (processWithoutRendering)="onProcessWithoutRendering($event)"
        />

      </div>
    }

    <!-- Background Progress Indicator (fixed position, always visible) -->
    <app-background-progress
      [jobs]="backgroundJobs()"
      (dismiss)="onDismissBackgroundJob($event)"
      (cancel)="onCancelBackgroundJob($event)"
    />

    <!-- File Picker Modal -->
    @if (showFilePicker()) {
      <app-file-picker
        (fileSelected)="loadPdf($event)"
        (close)="showFilePicker.set(false)"
      />
    }

    <!-- Loading Overlay (only for initial analysis, not page rendering) -->
    @if (loading() && !pdfLoaded()) {
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <p>{{ loadingText() }}</p>
      </div>
    }

    <!-- Non-blocking page render progress (shown while browsing) -->
    @if (pageRenderService.isLoading() && pdfLoaded()) {
      <div class="render-progress-bar">
        <div class="render-progress-fill" [style.width.%]="renderProgressPercent()"></div>
        <span class="render-progress-text">
          Rendering {{ pageRenderService.loadingProgress().current }} / {{ pageRenderService.loadingProgress().total }}
        </span>
      </div>
    }

    <!-- Text Editor Modal -->
    @if (showTextEditor()) {
      <div class="modal-overlay" (click)="cancelTextEdit()">
        <div class="text-editor-modal" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3>Edit Block Text</h3>
            <div class="editor-meta">
              @if (editingBlock()) {
                <span class="meta-item">Page {{ editingBlock()!.page + 1 }}</span>
                <span class="meta-item">{{ editingBlock()!.font_size }}pt</span>
                <span
                  class="meta-category"
                  [style.background]="categories()[editingBlock()!.category_id]?.color"
                >
                  {{ categories()[editingBlock()!.category_id]?.name }}
                </span>
              }
            </div>
            <button class="close-btn" (click)="cancelTextEdit()">×</button>
          </div>

          <div class="modal-body">
            <textarea
              class="text-editor-input"
              [value]="editedText()"
              (input)="editedText.set($any($event.target).value)"
              placeholder="Enter block text..."
              rows="10"
            ></textarea>
            <div class="char-count">
              {{ editedText().length }} characters
              @if (editingBlock() && editedText() !== editingBlock()!.text) {
                <span class="modified-indicator">· Modified</span>
              }
            </div>
          </div>

          <div class="modal-footer">
            <desktop-button variant="ghost" (click)="cancelTextEdit()">Cancel</desktop-button>
            <desktop-button
              variant="primary"
              [disabled]="!editingBlock() || editedText() === editingBlock()!.text"
              (click)="saveTextEdit()"
            >
              Save Changes
            </desktop-button>
          </div>
        </div>
      </div>
    }

    <!-- Inline Text Editor (for OCR corrections) -->
    @if (showInlineEditor() && inlineEditorBlock()) {
      <app-inline-text-editor
        [blockId]="inlineEditorBlock()!.id"
        [originalText]="inlineEditorBlock()!.text"
        [correctedText]="editorState.textCorrections().get(inlineEditorBlock()!.id) ?? null"
        [x]="inlineEditorX()"
        [y]="inlineEditorY()"
        [width]="inlineEditorWidth()"
        [height]="inlineEditorHeight()"
        [fontSize]="inlineEditorFontSize()"
        (editComplete)="onInlineEditComplete($event)"
      />
    }

    <!-- Alert Modal -->
    @if (alertModal()) {
      <div class="modal-overlay" (click)="closeAlert()">
        <div class="alert-modal" [class]="'alert-' + alertModal()!.type" (click)="$event.stopPropagation()">
          <div class="alert-icon">
            @switch (alertModal()!.type) {
              @case ('success') { <span>✓</span> }
              @case ('error') { <span>✕</span> }
              @case ('warning') { <span>⚠</span> }
              @default { <span>ℹ</span> }
            }
          </div>
          <div class="alert-content">
            <h3 class="alert-title">{{ alertModal()!.title }}</h3>
            <p class="alert-message">{{ alertModal()!.message }}</p>
          </div>
          <div class="alert-actions">
            @if (alertModal()!.cancelText) {
              <desktop-button variant="ghost" (click)="onAlertCancel()">
                {{ alertModal()!.cancelText }}
              </desktop-button>
            }
            <desktop-button
              [variant]="alertModal()!.type === 'error' ? 'danger' : 'primary'"
              (click)="onAlertConfirm()"
            >
              {{ alertModal()!.confirmText || 'OK' }}
            </desktop-button>
          </div>
        </div>
      </div>
    }

    <!-- OCR Modal -->
    @if (showOcrSettings()) {
      <app-ocr-settings-modal
        [currentSettings]="ocrSettings()"
        [totalPages]="totalPages()"
        [currentPage]="splitPreviewPage()"
        [getPageImage]="getPageImageForOcr.bind(this)"
        [documentId]="activeDocumentId() || 'unknown'"
        [documentName]="pdfName()"
        [lightweightMode]="lightweightMode()"
        [pdfPath]="effectivePath()"
        (close)="showOcrSettings.set(false)"
        (ocrCompleted)="onOcrCompleted($event)"
        (backgroundJobStarted)="onBackgroundOcrStarted($event)"
      />
    }

    <!-- Export Settings Modal -->
    @if (showExportSettings()) {
      <app-export-settings-modal
        [pdfName]="pdfName()"
        [totalPages]="totalPages()"
        [removeBackgrounds]="removeBackgrounds()"
        (result)="onExportSettingsResult($event)"
      />
    }

    <!-- Sample Mode Floating Toolbar -->
    @if (sampleMode()) {
      <div class="sample-mode-toolbar">
        <div class="sample-toolbar-content">
          <div class="sample-toolbar-header">
            <span class="sample-icon">🎯</span>
            <span class="sample-title">Create Custom Category</span>
          </div>
          <p class="sample-instructions">
            Draw boxes around examples of text you want to find. The more samples you provide, the better the detection.
          </p>
          <div class="sample-form">
            <div class="form-group">
              <label>Category Name</label>
              <input
                type="text"
                [value]="sampleCategoryName()"
                (input)="sampleCategoryName.set($any($event.target).value)"
                placeholder="e.g., Footnotes, Citations"
              />
            </div>
            <div class="form-group">
              <label>Color</label>
              <input
                type="color"
                [value]="sampleCategoryColor()"
                (input)="sampleCategoryColor.set($any($event.target).value)"
              />
            </div>
          </div>
          <div class="sample-rects-list">
            <div class="rects-header">
              <span>Samples: {{ sampleRects().length }}</span>
            </div>
            @if (sampleRects().length > 0) {
              <div class="rects-items">
                @for (rect of sampleRects(); track $index; let i = $index) {
                  <div class="rect-item">
                    <span>Page {{ rect.page + 1 }} ({{ rect.width | number:'1.0-0' }}×{{ rect.height | number:'1.0-0' }})</span>
                    <button class="remove-rect-btn" (click)="removeSampleRect(i)" title="Remove">×</button>
                  </div>
                }
              </div>
            } @else {
              <p class="no-samples-hint">No samples yet. Draw boxes on the PDF.</p>
            }
          </div>
          <div class="sample-toolbar-actions">
            <desktop-button variant="ghost" (click)="exitSampleMode()">Cancel</desktop-button>
            <desktop-button
              variant="primary"
              [disabled]="sampleRects().length === 0"
              (click)="analyzeSamplesAndCreateCategory()"
            >
              Create Category
            </desktop-button>
          </div>
        </div>
      </div>
    }

  `,
  styles: [`
    @use '../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    /* Toolbar should not shrink */
    desktop-toolbar {
      flex-shrink: 0;
    }

    /* Search bar */
    .search-bar {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .search-input-container {
      display: flex;
      align-items: center;
      flex: 1;
      max-width: 400px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      padding: 0 var(--ui-spacing-sm);

      &:focus-within {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.2);
      }
    }

    .search-icon {
      font-size: var(--ui-font-sm);
      opacity: 0.6;
      margin-right: var(--ui-spacing-xs);
    }

    .search-input {
      flex: 1;
      border: none;
      background: transparent;
      padding: var(--ui-spacing-sm) 0;
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      outline: none;

      &::placeholder {
        color: var(--text-tertiary);
      }
    }

    .search-clear {
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 2px 4px;

      &:hover {
        color: var(--text-primary);
      }
    }

    .search-controls {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
    }

    .search-nav-btn {
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: $radius-sm;
      font-size: 10px;
      line-height: 1;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    .search-count {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      min-width: 80px;
      text-align: center;
    }

    .search-close {
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px 8px;
      border-radius: $radius-sm;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    /* Ensure split-pane takes remaining space and doesn't overflow */
    desktop-split-pane {
      flex: 1;
      min-height: 0; /* Critical for flex children to respect parent bounds */
      overflow: hidden;
    }

    .pdf-name {
      color: var(--text-secondary);
      font-size: $font-size-sm;
      margin-left: $spacing-2;
    }

    .page-timeline {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-subtle);
      flex-shrink: 0;
      min-height: var(--ui-thumb-height);
      max-height: calc(var(--ui-thumb-height) + 40px);
    }

    .timeline-header {
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);
    }

    .timeline-label {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .loading-status {
      color: var(--accent);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .mini-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid var(--border-subtle);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .timeline-scroll {
      display: flex;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      overflow-x: auto;
      overflow-y: hidden;

      &::-webkit-scrollbar {
        height: 6px;
      }

      &::-webkit-scrollbar-track {
        background: var(--bg-surface);
      }

      &::-webkit-scrollbar-thumb {
        background: var(--border-default);
        border-radius: 3px;
      }
    }

    .timeline-thumb {
      position: relative;
      flex-shrink: 0;
      width: var(--ui-thumb-width);
      height: var(--ui-thumb-height);
      border: 2px solid var(--border-subtle);
      border-radius: $radius-sm;
      background: var(--bg-surface);
      cursor: pointer;
      overflow: hidden;
      transition: all $duration-fast $ease-out;
      padding: 0;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0.8;
      }

      .thumb-label {
        position: absolute;
        bottom: 2px;
        left: 2px;
        font-size: var(--ui-font-xs);
        color: var(--text-secondary);
        background: rgba(0,0,0,0.6);
        padding: 1px 4px;
        border-radius: 2px;
      }

      .thumb-count {
        position: absolute;
        top: 2px;
        right: 2px;
        font-size: var(--ui-font-xs);
        font-weight: $font-weight-bold;
        color: white;
        background: var(--accent);
        padding: 1px 5px;
        border-radius: 8px;
        min-width: 16px;
        text-align: center;
      }

      &:hover {
        border-color: var(--border-default);
        transform: scale(1.05);

        img { opacity: 1; }
      }

      &.has-selection {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px var(--accent);
      }

      &.regex-match {
        border-color: #E91E63;
        box-shadow: 0 0 0 2px #E91E63;

        .thumb-count {
          background: #E91E63;
        }
      }
    }

    .viewer-pane-container {
      display: flex;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      position: relative;  /* For absolute positioning of progress indicator */
    }

    .library-container {
      flex: 1;
      min-height: 0;
      position: relative;  /* For absolute positioning of progress indicator */
      display: flex;
      flex-direction: column;
    }

    .viewer-timeline-wrapper {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .tools-sidebar {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-subtle);
      padding: var(--ui-spacing-md);
      gap: var(--ui-spacing-xs);
      flex-shrink: 0;
      min-width: 150px;
      max-width: 400px;
      overflow-y: auto;
      position: relative;
    }

    .sidebar-resize-handle {
      position: absolute;
      top: 0;
      right: 0;
      width: 4px;
      height: 100%;
      cursor: ew-resize;
      background: transparent;
      transition: background $duration-fast $ease-out;

      &:hover {
        background: var(--accent);
      }
    }

    .tools-section {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .tools-label {
      font-size: 11px;
      font-weight: $font-weight-semibold;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      margin-bottom: 4px;
    }

    .tools-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: var(--ui-spacing-md) 0;
    }

    .menu-item {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-sm);
      border: 1px solid transparent;
      border-radius: $radius-md;
      background: transparent;
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      width: 100%;
      text-align: left;

      .menu-icon {
        font-size: 16px;
        width: 24px;
        text-align: center;
        flex-shrink: 0;
      }

      .menu-text {
        font-size: var(--ui-font-sm);
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      &:hover {
        background: var(--hover-bg);
      }

      &.active {
        background: var(--accent-subtle);
        border-color: var(--accent);

        .menu-text {
          color: var(--accent);
          font-weight: $font-weight-medium;
        }
      }
    }

    .viewer-pane {
      flex: 1;
      height: 100%;
      min-height: 0; /* Allow flex child to shrink */
      overflow: auto;
      background: var(--bg-sunken);
      position: relative;
    }

    /* Library view takes full space when no PDF loaded */
    app-library-view {
      flex: 1;
      min-height: 0;
    }

    .loading-overlay {
      position: absolute;
      inset: 0;
      background: var(--bg-overlay);
      backdrop-filter: blur(4px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 100;
      animation: overlayFadeIn $duration-fast $ease-out forwards;
    }

    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: $spacing-4;
    }

    .progress-container {
      margin-top: $spacing-4;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: $spacing-2;
      width: 300px;
    }

    .progress-bar {
      width: 100%;
      height: 8px;
      background: var(--bg-raised);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.2s ease-out;
    }

    .progress-text {
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @keyframes overlayFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Non-blocking page render progress bar */
    .render-progress-bar {
      position: fixed;
      bottom: 0;
      left: 100px; /* Account for nav rail */
      right: 0;
      height: 24px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      z-index: 50;
      display: flex;
      align-items: center;
      padding: 0 $spacing-4;
    }

    .render-progress-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      transition: width 0.15s ease-out;
    }

    .render-progress-text {
      position: relative;
      z-index: 1;
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
      animation: overlayFadeIn $duration-fast $ease-out forwards;
    }

    @keyframes modalSlideIn {
      from {
        opacity: 0;
        transform: translateY(-20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: $spacing-4;
      border-bottom: 1px solid var(--border-subtle);

      h3 {
        margin: 0;
        font-size: $font-size-lg;
        color: var(--text-primary);
      }

      .close-btn {
        background: none;
        border: none;
        font-size: 1.5rem;
        color: var(--text-tertiary);
        cursor: pointer;
        padding: 0;
        line-height: 1;

        &:hover { color: var(--text-primary); }
      }
    }

    .modal-body {
      padding: $spacing-4;
      overflow-y: auto;
      flex: 1;
    }

    .form-group {
      margin-bottom: $spacing-3;

      label {
        display: block;
        font-size: $font-size-sm;
        font-weight: $font-weight-medium;
        color: var(--text-secondary);
        margin-bottom: $spacing-1;
      }

      input[type="text"],
      input[type="number"] {
        width: 100%;
        padding: $spacing-2 $spacing-3;
        border: 1px solid var(--border-default);
        border-radius: $radius-md;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: $font-size-sm;

        &:focus {
          outline: none;
          border-color: var(--accent);
        }

        &::placeholder {
          color: var(--text-tertiary);
        }
      }

      input[type="color"] {
        width: 60px;
        height: 32px;
        border: 1px solid var(--border-default);
        border-radius: $radius-sm;
        cursor: pointer;
      }

      .hint {
        display: block;
        font-size: $font-size-xs;
        color: var(--text-tertiary);
        margin-top: $spacing-1;
      }

      .checkbox-label {
        display: flex;
        align-items: center;
        gap: $spacing-2;
        cursor: pointer;

        input[type="checkbox"] {
          width: 16px;
          height: 16px;
        }
      }

      .sub-option {
        display: flex;
        align-items: center;
        gap: $spacing-2;
        margin-top: $spacing-2;
        margin-left: $spacing-5;
        font-size: $font-size-sm;
        color: var(--text-secondary);

        input {
          width: 60px;
        }
      }
    }

    .form-row {
      display: flex;
      gap: $spacing-3;

      .half { flex: 1; }
    }

    .preview-section {
      margin-top: $spacing-4;
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      overflow: hidden;
    }

    .preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: $spacing-2 $spacing-3;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      font-size: $font-size-sm;
      color: var(--text-secondary);

      .preview-select {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font-size: $font-size-xs;

        &:hover { text-decoration: underline; }
      }
    }

    .preview-list {
      max-height: 150px;
      overflow-y: auto;
    }

    .preview-item {
      display: flex;
      gap: $spacing-2;
      padding: $spacing-2 $spacing-3;
      border-bottom: 1px solid var(--border-subtle);
      font-size: $font-size-xs;

      &:last-child { border-bottom: none; }

      .preview-page {
        color: #ff7b54;
        font-weight: 600;
        flex-shrink: 0;
        width: 40px;
      }

      .preview-text {
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .preview-more, .preview-empty {
      padding: $spacing-2 $spacing-3;
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      font-style: italic;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: $spacing-2;
      padding: $spacing-4;
      border-top: 1px solid var(--border-subtle);
    }

    // Text Editor Modal
    .text-editor-modal {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      width: 600px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn $duration-normal $ease-out forwards;

      .modal-header {
        flex-wrap: wrap;
        gap: $spacing-2;
      }

      .editor-meta {
        display: flex;
        align-items: center;
        gap: $spacing-2;
        flex: 1;
        justify-content: center;

        .meta-item {
          font-size: $font-size-xs;
          color: var(--text-tertiary);
        }

        .meta-category {
          font-size: $font-size-xs;
          padding: 2px 8px;
          border-radius: $radius-sm;
          color: white;
        }
      }
    }

    .text-editor-input {
      width: 100%;
      min-height: 200px;
      padding: $spacing-3;
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: $font-size-sm;
      font-family: $font-body;
      line-height: 1.6;
      resize: vertical;

      &:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: var(--focus-ring);
      }

      &::placeholder {
        color: var(--text-tertiary);
      }
    }

    .char-count {
      margin-top: $spacing-2;
      font-size: $font-size-xs;
      color: var(--text-tertiary);
      text-align: right;

      .modified-indicator {
        color: var(--accent);
        font-weight: $font-weight-medium;
      }
    }

    // Alert Modal
    .alert-modal {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      width: 400px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn $duration-normal $ease-out forwards;
      overflow: hidden;

      .alert-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: $spacing-6 $spacing-4 $spacing-2;
        font-size: 2.5rem;

        span {
          width: 60px;
          height: 60px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: var(--bg-surface);
        }
      }

      .alert-content {
        padding: $spacing-2 $spacing-6 $spacing-4;
        text-align: center;
      }

      .alert-title {
        margin: 0 0 $spacing-2;
        font-size: $font-size-lg;
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .alert-message {
        margin: 0;
        font-size: $font-size-sm;
        color: var(--text-secondary);
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .alert-actions {
        display: flex;
        justify-content: center;
        gap: $spacing-2;
        padding: $spacing-4;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
      }

      &.alert-success .alert-icon span {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      &.alert-error .alert-icon span {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      &.alert-warning .alert-icon span {
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
      }

      &.alert-info .alert-icon span {
        background: var(--accent-subtle);
        color: var(--accent);
      }
    }

    // Sample Mode Floating Toolbar
    .sample-mode-toolbar {
      position: fixed;
      top: calc(var(--ui-toolbar) + var(--ui-panel-header) + 20px);
      right: 20px;
      z-index: 1000;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      width: 320px;
      animation: slideInFromRight $duration-normal $ease-out;

      @keyframes slideInFromRight {
        from {
          opacity: 0;
          transform: translateX(20px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
    }

    .sample-toolbar-content {
      padding: var(--ui-spacing-lg);
    }

    .sample-toolbar-header {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-sm);

      .sample-icon {
        font-size: 20px;
      }

      .sample-title {
        font-size: var(--ui-font-lg);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }
    }

    .sample-instructions {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      margin: 0 0 var(--ui-spacing-md);
      line-height: 1.4;
    }

    .sample-form {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
      margin-bottom: var(--ui-spacing-md);
      padding-bottom: var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);

      .form-group {
        display: flex;
        flex-direction: column;
        gap: var(--ui-spacing-xs);

        label {
          font-size: var(--ui-font-sm);
          color: var(--text-secondary);
        }

        input[type="text"] {
          padding: var(--ui-spacing-sm) var(--ui-spacing-md);
          background: var(--bg-surface);
          border: 1px solid var(--border-subtle);
          border-radius: $radius-md;
          color: var(--text-primary);
          font-size: var(--ui-font-base);

          &:focus {
            outline: none;
            border-color: var(--accent);
          }
        }

        input[type="color"] {
          width: 100%;
          height: 32px;
          border: 1px solid var(--border-subtle);
          border-radius: $radius-md;
          cursor: pointer;
        }
      }
    }

    .sample-rects-list {
      margin-bottom: var(--ui-spacing-md);

      .rects-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ui-spacing-sm);

        span {
          font-size: var(--ui-font-sm);
          font-weight: $font-weight-medium;
          color: var(--text-primary);
        }
      }

      .rects-items {
        display: flex;
        flex-direction: column;
        gap: var(--ui-spacing-xs);
        max-height: 150px;
        overflow-y: auto;
      }

      .rect-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
        background: var(--bg-surface);
        border-radius: $radius-sm;
        font-size: var(--ui-font-sm);
        color: var(--text-secondary);

        .remove-rect-btn {
          background: none;
          border: none;
          color: var(--text-tertiary);
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 2px 6px;
          border-radius: $radius-sm;

          &:hover {
            background: var(--hover-bg);
            color: var(--text-primary);
          }
        }
      }

      .no-samples-hint {
        font-size: var(--ui-font-sm);
        color: var(--text-tertiary);
        text-align: center;
        padding: var(--ui-spacing-md);
        margin: 0;
      }
    }

    .sample-toolbar-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-spacing-sm);
    }

    .menu-item.disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .lightweight-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      width: 100%;
      background: var(--bg-sunken);
      color: var(--text-secondary);

      .placeholder-content {
        text-align: center;
        max-width: 400px;
        padding: var(--ui-spacing-xl);

        .placeholder-icon {
          font-size: 48px;
          margin-bottom: var(--ui-spacing-lg);
          display: block;
          opacity: 0.6;
        }

        h2 {
          margin: 0 0 var(--ui-spacing-md) 0;
          font-size: var(--ui-font-xl);
          font-weight: $font-weight-semibold;
          color: var(--text-primary);
        }

        p {
          margin: 0 0 var(--ui-spacing-md) 0;
          font-size: var(--ui-font-base);
        }

        ul {
          list-style: none;
          padding: 0;
          margin: 0;
          text-align: left;

          li {
            padding: var(--ui-spacing-xs) 0;
            font-size: var(--ui-font-base);
          }
        }
      }
    }

  `],
})
export class PdfPickerComponent {
  private readonly pdfService = inject(PdfService);
  private readonly electronService = inject(ElectronService);
  private readonly exportService = inject(ExportService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly pageRenderService = inject(PageRenderService);
  private readonly ocrPostProcessor = inject(OcrPostProcessorService);
  private readonly ocrJobService = inject(OcrJobService);
  readonly themeService = inject(DesktopThemeService);
  private readonly destroyRef = inject(DestroyRef);

  // Injected services for state management
  readonly editorState = inject(PdfEditorStateService);
  readonly projectService = inject(ProjectService);

  // Auto-save effect - watches for unsaved changes and triggers save (auto-creates project if needed)
  private readonly autoSaveEffect = effect(() => {
    if (this.hasUnsavedChanges() && this.pdfLoaded()) {
      this.scheduleAutoSave();
    }
  });

  // Tab persistence - localStorage keys
  private readonly OPEN_TABS_KEY = 'bookforge-open-tabs';
  private readonly ACTIVE_TAB_KEY = 'bookforge-active-tab';

  // Tab persistence - save open document paths to localStorage
  private readonly tabPersistenceEffect = effect(() => {
    const docs = this.openDocuments();
    const activeId = this.activeDocumentId();

    // Save project paths for documents that have a project file
    const projectPaths = docs
      .filter(d => d.projectPath)
      .map(d => d.projectPath as string);

    try {
      if (projectPaths.length > 0) {
        localStorage.setItem(this.OPEN_TABS_KEY, JSON.stringify(projectPaths));
        if (activeId) {
          const activeDoc = docs.find(d => d.id === activeId);
          if (activeDoc?.projectPath) {
            localStorage.setItem(this.ACTIVE_TAB_KEY, activeDoc.projectPath);
          }
        }
      } else {
        localStorage.removeItem(this.OPEN_TABS_KEY);
        localStorage.removeItem(this.ACTIVE_TAB_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  });

  // Tab restoration - restore open documents from localStorage on init
  private readonly tabRestoration = (() => {
    // Use setTimeout to ensure this runs after component is fully initialized
    setTimeout(() => this.restoreOpenTabs(), 0);
  })();

  // Nav-rail "home" button handler - when clicking library while already on library
  private readonly navHomeHandler = (() => {
    this.route.queryParams.subscribe(params => {
      if (params['home'] && this.pdfLoaded()) {
        // Clicking library button while on library - show library view but keep tabs
        this.showLibraryView();
        // Clear the query param to avoid re-triggering
        this.router.navigate([], { queryParams: {}, replaceUrl: true });
      }
    });
  })();

  // Register global OCR job completion handler
  private readonly ocrJobCompletionHandler = (() => {
    this.ocrJobService.onJobComplete((job) => {
      // Convert OcrJobResult to OcrPageResult and process (including layoutBlocks)
      // Cast layoutBlocks to LayoutBlock[] since PluginLayoutBlock.label is string but LayoutBlock.label is a union type
      const results: OcrPageResult[] = job.results.map(r => ({
        page: r.page,
        text: r.text,
        confidence: r.confidence,
        textLines: r.textLines,
        layoutBlocks: r.layoutBlocks as OcrPageResult['layoutBlocks']
      }));
      if (results.length > 0) {
        this.onOcrCompleted(results);
      }
    });
  })();

  @ViewChild(PdfViewerComponent) pdfViewer!: PdfViewerComponent;
  @ViewChild(CategoriesPanelComponent) categoriesPanel?: CategoriesPanelComponent;
  @ViewChild('searchInput') searchInputRef?: ElementRef<HTMLInputElement>;

  // Fixed sidebar width - doesn't change with window size
  private readonly SIDEBAR_WIDTH = 320;

  // Delegate core state to editorState service (aliased for template compatibility)
  get blocks() { return this.editorState.blocks; }
  get categories() { return this.editorState.categories; }
  get pageDimensions() { return this.editorState.pageDimensions; }
  get totalPages() { return this.editorState.totalPages; }
  get pdfName() { return this.editorState.pdfName; }
  get pdfPath() { return this.editorState.pdfPath; }
  get libraryPath() { return this.editorState.libraryPath; }
  get effectivePath() { return this.editorState.effectivePath; }
  get fileHash() { return this.editorState.fileHash; }
  get pdfLoaded() { return this.editorState.pdfLoaded; }
  get deletedBlockIds() { return this.editorState.deletedBlockIds; }
  get selectedBlockIds() { return this.editorState.selectedBlockIds; }
  get pageOrder() { return this.editorState.pageOrder; }
  get textCorrections() { return this.editorState.textCorrections; }
  // Computed: Set of block IDs that have text corrections (for visual indicator)
  readonly correctedBlockIds = computed(() => new Set(this.textCorrections().keys()));
  // Computed: Map of block IDs to their position offsets (for drag/drop visualization)
  readonly blockOffsets = computed(() => {
    const edits = this.editorState.blockEdits();
    const offsets = new Map<string, { offsetX: number; offsetY: number }>();
    edits.forEach((edit, blockId) => {
      if (edit.offsetX !== undefined || edit.offsetY !== undefined) {
        offsets.set(blockId, {
          offsetX: edit.offsetX ?? 0,
          offsetY: edit.offsetY ?? 0
        });
      }
    });
    return offsets;
  });
  // Computed: Map of block IDs to their size overrides
  readonly blockSizes = computed(() => {
    const edits = this.editorState.blockEdits();
    const sizes = new Map<string, { width: number; height: number }>();
    edits.forEach((edit, blockId) => {
      if (edit.width !== undefined && edit.height !== undefined) {
        sizes.set(blockId, {
          width: edit.width,
          height: edit.height
        });
      }
    });
    return sizes;
  });
  get hasUnsavedChanges() { return this.editorState.hasUnsavedChanges; }
  get canUndo() { return this.editorState.canUndo; }
  get canRedo() { return this.editorState.canRedo; }

  // Delegate project state to projectService
  get projectPath() { return this.projectService.projectPath; }

  readonly zoom = signal(50); // Default 50% for grid mode
  readonly layout = signal<'vertical' | 'grid'>('grid');
  // Remove backgrounds state is managed by editor state service for undo/redo
  readonly removeBackgrounds = computed(() => this.editorState.removeBackgrounds());
  // Pages that have been explicitly rendered as blank (due to image deletion)
  readonly blankedPages = signal<Set<number>>(new Set());
  // Split size = window width minus sidebar width (keeps sidebar fixed)
  readonly splitSize = signal(Math.max(400, window.innerWidth - this.SIDEBAR_WIDTH));
  private userResizedSplit = false; // Track if user manually resized
  private userAdjustedZoom = false; // Track if user manually zoomed

  // Tools sidebar resizing
  readonly toolsSidebarWidth = signal(220); // Default width in px
  private isResizingSidebar = false;
  private sidebarResizeStartX = 0;
  private sidebarResizeStartWidth = 0;

  // Grid layout constants
  private readonly GRID_THUMBNAIL_BASE_WIDTH = 200; // Base width in px at 100% zoom
  private readonly GRID_GAP = 16; // Gap between thumbnails in px
  private readonly GRID_PADDING = 32; // Padding around grid container
  private readonly DEFAULT_PAGES_ACROSS = 4; // Target pages across in grid

  /**
   * Calculate optimal zoom level to fit N pages across in grid mode
   * @param pagesAcross Number of pages to fit horizontally (default: 4)
   * @returns Zoom percentage that fits the requested pages
   */
  calculateZoomForGridPages(pagesAcross: number = this.DEFAULT_PAGES_ACROSS): number {
    const viewportWidth = this.splitSize();
    // Account for gaps between pages and padding
    const totalGaps = (pagesAcross - 1) * this.GRID_GAP;
    const availableWidth = viewportWidth - this.GRID_PADDING - totalGaps;
    const pageWidth = availableWidth / pagesAcross;
    // Calculate zoom: pageWidth = GRID_THUMBNAIL_BASE_WIDTH * (zoom / 100)
    const zoom = (pageWidth / this.GRID_THUMBNAIL_BASE_WIDTH) * 100;
    // Clamp to reasonable bounds
    return Math.max(20, Math.min(200, Math.round(zoom)));
  }

  /**
   * Auto-zoom to fit 4 pages across when in grid mode
   */
  autoZoomForGrid(): void {
    if (this.layout() === 'grid' && !this.userAdjustedZoom) {
      const optimalZoom = this.calculateZoomForGridPages(this.DEFAULT_PAGES_ACROSS);
      this.zoom.set(optimalZoom);
    }
  }

  // Keep sidebar fixed width on window resize (unless user manually resized)
  @HostListener('window:resize')
  onWindowResize(): void {
    if (!this.userResizedSplit) {
      this.splitSize.set(Math.max(400, window.innerWidth - this.SIDEBAR_WIDTH));
    }
    // Recalculate grid zoom on resize if user hasn't manually zoomed
    this.autoZoomForGrid();
  }

  // Keyboard shortcuts
  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Inline text editor is open - let it handle its own shortcuts
    if (this.showInlineEditor()) {
      return;
    }

    // Text editor modal shortcuts
    if (this.showTextEditor()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelTextEdit();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        this.saveTextEdit();
        return;
      }
      return;
    }

    // Delete/Backspace to delete selected blocks, pages, or custom category highlights
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Don't capture if focused on an input element
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Check for selected pages first (works in select, edit, and organize modes)
      if (this.selectedPageNumbers().size > 0) {
        event.preventDefault();
        this.onDeleteSelectedPages(this.selectedPageNumbers());
        return;
      }

      // Try to delete/restore selected blocks (toggles deletion state)
      if (this.selectedBlockIds().length > 0) {
        event.preventDefault();
        this.deleteSelectedBlocks();
        return;
      }
      // If no blocks selected, try to clear highlights from focused custom category
      const focusedCat = this.focusedCategoryId();
      if (focusedCat && focusedCat.startsWith('custom_')) {
        event.preventDefault();
        this.clearCustomCategoryHighlights(focusedCat);
        return;
      }
    }

    // Ctrl/Cmd + Z for undo
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    }

    // Ctrl/Cmd + Shift + Z for redo
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'z') {
      event.preventDefault();
      this.redo();
    }

    // Ctrl/Cmd + Y for redo (alternative)
    if ((event.metaKey || event.ctrlKey) && event.key === 'y') {
      event.preventDefault();
      this.redo();
    }

    // Ctrl/Cmd + O to show library view
    if ((event.metaKey || event.ctrlKey) && event.key === 'o') {
      event.preventDefault();
      this.showLibraryView();
    }

    // Ctrl/Cmd + W to close current tab or hide window
    if ((event.metaKey || event.ctrlKey) && event.key === 'w') {
      event.preventDefault();
      this.closeCurrentTabOrHideWindow();
    }

    // Ctrl/Cmd + E for export
    if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
      event.preventDefault();
      if (this.pdfLoaded()) {
        this.showExportSettings.set(true);
      }
    }

    // Ctrl/Cmd + F for search
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      if (this.pdfLoaded()) {
        this.toggleSearch();
      }
    }

    // Escape to close search
    if (event.key === 'Escape' && this.showSearch()) {
      event.preventDefault();
      this.closeSearch();
      return;
    }

    // Mode shortcuts (single keys, no modifiers)
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      switch (event.key.toLowerCase()) {
        case 's':
          // Only if not in an input field
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('select');
          }
          break;
        case 'e':
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('edit');
          }
          break;
        case 'c':
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('crop');
          }
          break;
        case 'p': // P for page split
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('split');
          }
          break;
        case 'h': // H for chapters/headings
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('chapters');
          }
          break;
      }
    }
  }

  onSplitSizeChanged(size: number): void {
    this.splitSize.set(size);
    this.userResizedSplit = true; // User manually adjusted, stop auto-resizing
  }

  // Tools sidebar resize handlers
  onSidebarResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizingSidebar = true;
    this.sidebarResizeStartX = event.clientX;
    this.sidebarResizeStartWidth = this.toolsSidebarWidth();

    // Add document-level listeners for smooth dragging
    document.addEventListener('mousemove', this.onSidebarResizeMove);
    document.addEventListener('mouseup', this.onSidebarResizeEnd);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  private onSidebarResizeMove = (event: MouseEvent): void => {
    if (!this.isResizingSidebar) return;

    const delta = event.clientX - this.sidebarResizeStartX;
    const newWidth = Math.max(150, Math.min(400, this.sidebarResizeStartWidth + delta));
    this.toolsSidebarWidth.set(newWidth);
  };

  private onSidebarResizeEnd = (): void => {
    this.isResizingSidebar = false;
    document.removeEventListener('mousemove', this.onSidebarResizeMove);
    document.removeEventListener('mouseup', this.onSidebarResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  readonly showFilePicker = signal(false);
  readonly showExportSettings = signal(false);
  readonly loading = signal(false);
  readonly loadingText = signal('Loading...');
  readonly lightweightMode = signal(false);  // Process without rendering pages

  // Search state
  readonly showSearch = signal(false);
  readonly searchQuery = signal('');
  readonly searchResults = signal<{ blockId: string; page: number; text: string; matchStart: number; matchEnd: number }[]>([]);
  readonly currentSearchIndex = signal(-1);
  readonly searchCaseSensitive = signal(false);
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Render progress from PageRenderService
  readonly renderProgress = computed(() => this.pageRenderService.loadingProgress());
  readonly renderProgressPercent = computed(() => {
    const { current, total } = this.renderProgress();
    if (total === 0) return 0;
    return Math.round((current / total) * 100);
  });

  // Regex category panel state (in categories sidebar)
  readonly regexPanelExpanded = signal(false);
  readonly regexPattern = signal('');
  readonly regexCategoryName = signal('');
  readonly regexCategoryColor = signal('#FF5722');
  readonly editingCategoryId = signal<string | null>(null);  // ID of category being edited, null = creating new
  readonly focusedCategoryId = signal<string | null>(null);  // Last clicked custom category (for keyboard delete)
  readonly regexMinFontSize = signal(0);
  readonly regexMaxFontSize = signal(0);  // 0 means "no max filter"
  readonly regexNearLineEnd = signal(false);
  readonly regexLineEndChars = signal(3);
  readonly regexMinBaseline = signal<number | null>(null);
  readonly regexMaxBaseline = signal<number | null>(null);
  readonly regexCaseSensitive = signal(false);  // Default: case-insensitive
  readonly regexLiteralMode = signal(false);    // Default: regex mode (no escaping)
  readonly regexCategoryFilter = signal<string[]>([]);  // Empty = all categories
  readonly regexPageFilterType = signal<'all' | 'range' | 'even' | 'odd' | 'specific'>('all');
  readonly regexPageRangeStart = signal(1);
  readonly regexPageRangeEnd = signal(1);
  readonly regexSpecificPages = signal('');
  readonly regexMatches = signal<MatchRect[]>([]);
  readonly regexMatchCount = signal(0);
  private regexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Inline text editor state (for OCR corrections)
  readonly showInlineEditor = signal(false);
  readonly inlineEditorBlock = signal<TextBlock | null>(null);
  readonly inlineEditorX = signal(0);
  readonly inlineEditorY = signal(0);
  readonly inlineEditorWidth = signal(200);
  readonly inlineEditorHeight = signal(50);
  // Pre-calculated font size set when opening the editor (matches visible text exactly)
  readonly inlineEditorCalculatedFontSize = signal(14);
  // Use the pre-calculated font size
  readonly inlineEditorFontSize = computed(() => this.inlineEditorCalculatedFontSize());

  // Legacy text editor modal state (kept for compatibility, may be removed later)
  readonly showTextEditor = signal(false);
  readonly editingBlock = signal<TextBlock | null>(null);
  readonly editedText = signal('');

  // Alert modal state
  readonly alertModal = signal<AlertModal | null>(null);

  // OCR settings state
  readonly showOcrSettings = signal(false);
  readonly ocrSettings = signal<OcrSettings>({
    engine: 'tesseract',
    language: 'eng',
    tesseractPsm: 3
  });

  // Background OCR jobs - convert OcrJob[] to BackgroundJob[] for the progress component
  readonly backgroundJobs = computed<BackgroundJob[]>(() => {
    return this.ocrJobService.jobs().map(job => {
      // Map OcrJob status to BackgroundJob status
      let status: BackgroundJob['status'];
      switch (job.status) {
        case 'queued':
        case 'pending':
          status = 'queued';
          break;
        case 'running':
          status = 'running';
          break;
        case 'completed':
          status = 'completed';
          break;
        case 'cancelled':
          status = 'cancelled';
          break;
        case 'error':
        default:
          status = 'error';
          break;
      }

      return {
        id: job.id,
        type: 'ocr' as const,
        title: `OCR: ${job.documentName}`,
        progress: job.progress,
        current: job.processedCount,
        total: job.totalPages,
        status,
        error: job.error,
        queuePosition: job.queuePosition
      };
    });
  });

  // Sample mode state (for creating custom categories by drawing boxes)
  readonly sampleMode = signal(false);
  readonly sampleRects = signal<Array<{ page: number; x: number; y: number; width: number; height: number }>>([]);
  readonly sampleCategoryName = signal('');
  readonly sampleCategoryColor = signal('#E91E63');
  private sampleCurrentRect: { page: number; startX: number; startY: number; currentX: number; currentY: number } | null = null;
  // Signal to pass to pdf-viewer for drawing rect visualization
  readonly sampleDrawingRect = signal<{ page: number; x: number; y: number; width: number; height: number } | null>(null);

  // Custom category highlights - stored by category ID, then by page for O(1) lookup
  // This avoids creating heavy TextBlock objects for pattern matches
  readonly categoryHighlights = signal<CategoryHighlights>(new Map());

  // Deleted highlight IDs - tracks which custom category highlights have been "deleted" (show X)
  // ID format: "categoryId:page:x:y" for unique identification
  readonly deletedHighlightIds = signal<Set<string>>(new Set());

  // Helper to generate a unique ID for a highlight
  private getHighlightId(categoryId: string, page: number, x: number, y: number): string {
    return `${categoryId}:${page}:${Math.round(x)}:${Math.round(y)}`;
  }

  /**
   * Get deleted highlights with their coordinates for coordinate-based EPUB export.
   * Returns highlights that have been marked for deletion.
   */
  private getDeletedHighlights(): DeletedHighlight[] {
    const deletedIds = this.deletedHighlightIds();
    if (deletedIds.size === 0) return [];

    const result: DeletedHighlight[] = [];
    const highlights = this.categoryHighlights();

    for (const [categoryId, pageMap] of highlights) {
      // Only process custom categories
      if (!categoryId.startsWith('custom_')) continue;

      for (const [pageStr, rects] of Object.entries(pageMap)) {
        const page = parseInt(pageStr);
        for (const rect of rects) {
          const highlightId = this.getHighlightId(categoryId, page, rect.x, rect.y);
          if (deletedIds.has(highlightId) && rect.text) {
            result.push({
              page,
              x: rect.x,
              y: rect.y,
              w: rect.w,
              h: rect.h,
              text: rect.text
            });
          }
        }
      }
    }

    return result;
  }

  // Combined highlights: when regex panel is open, ONLY show regex preview (hide others)
  // Also filters out highlights for disabled categories
  readonly combinedHighlights = computed<CategoryHighlights>(() => {
    const base = this.categoryHighlights();
    const categories = this.categories();

    // If regex panel is open, show ONLY regex preview matches
    if (this.regexPanelExpanded()) {
      const matches = this.regexMatches();
      if (matches.length === 0) {
        // Panel is open but no matches - return empty (hide all highlights)
        return new Map();
      }

      // Group matches by page
      const previewByPage: Record<number, MatchRect[]> = {};
      for (const match of matches) {
        if (!previewByPage[match.page]) {
          previewByPage[match.page] = [];
        }
        previewByPage[match.page].push(match);
      }

      // Return ONLY the preview highlights (not merged with base)
      const previewOnly = new Map<string, Record<number, MatchRect[]>>();
      previewOnly.set('__regex_preview__', previewByPage);

      return previewOnly;
    }

    // Filter out highlights for disabled categories
    const filtered = new Map<string, Record<number, MatchRect[]>>();
    for (const [categoryId, pageHighlights] of base) {
      const cat = categories[categoryId];
      // Only include if category exists and is enabled
      if (cat && cat.enabled !== false) {
        filtered.set(categoryId, pageHighlights);
      }
    }

    return filtered;
  });

  // Categories extended with preview category (for pdf-viewer when regex modal is open)
  readonly categoriesWithPreview = computed<Record<string, Category>>(() => {
    const base = this.categories();

    // If regex modal isn't open, just return base categories
    if (!this.regexPanelExpanded() || this.regexMatches().length === 0) {
      return base;
    }

    // Add the preview category
    return {
      ...base,
      '__regex_preview__': {
        id: '__regex_preview__',
        name: 'Regex Preview',
        description: 'Live preview of regex matches',
        color: this.regexCategoryColor(),
        block_count: this.regexMatchCount(),
        char_count: 0,
        font_size: 0,
        region: '',
        sample_text: '',
        enabled: true
      }
    };
  });

  // Editor mode state
  readonly currentMode = signal<EditorMode>('select');
  readonly modes: ModeInfo[] = [
    { id: 'select', icon: '🎯', label: 'Select', tooltip: 'Select and delete blocks (S)' },
    { id: 'edit', icon: '✏️', label: 'Edit', tooltip: 'Edit text, reorder/delete pages (E)' },
    { id: 'crop', icon: '✂️', label: 'Crop', tooltip: 'Draw rectangle to crop (C)' },
    { id: 'split', icon: '📖', label: 'Split', tooltip: 'Split scanned pages (P)' },
    { id: 'ocr', icon: '👁️', label: 'OCR', tooltip: 'OCR scanned pages (O)' },
    { id: 'chapters', icon: '📚', label: 'Chapters & Metadata', tooltip: 'Chapters and book metadata (H)' }
  ];

  // Crop mode state (derived from currentMode)
  readonly cropMode = computed(() => this.currentMode() === 'crop');
  readonly cropCurrentPage = signal(0);
  readonly currentCropRect = signal<CropRect | null>(null);
  private previousLayout: 'vertical' | 'grid' = 'grid';

  // Split mode state (for scanned book pages)
  readonly splitMode = computed(() => this.currentMode() === 'split');
  readonly splitConfig = signal<SplitConfig>({
    enabled: false,
    oddPageSplit: 0.5,
    evenPageSplit: 0.5,
    pageOverrides: {},
    skippedPages: new Set<number>(),
    readingOrder: 'left-to-right'
  });
  readonly splitPreviewPage = signal(0);  // Page being previewed in split mode
  readonly isDraggingSplit = signal(false);
  readonly deskewing = signal(false);
  readonly lastDeskewAngle = signal<number | null>(null);

  // Chapters mode state
  readonly chaptersMode = computed(() => this.currentMode() === 'chapters');
  readonly chapters = signal<Chapter[]>([]);
  readonly chaptersSource = signal<'toc' | 'heuristic' | 'manual' | 'mixed'>('manual');
  readonly detectingChapters = signal(false);
  readonly finalizingChapters = signal(false);
  readonly selectedChapterId = signal<string | null>(null);

  // Book metadata for EPUB export
  readonly metadata = signal<BookMetadata>({});

  // Page deletion - delegate to editor state (has undo/redo support)
  get deletedPages() { return this.editorState.deletedPages; }

  // Organize mode state
  // Select and Edit modes include organize functionality (page selection, deletion, reordering)
  readonly organizeMode = computed(() => this.currentMode() === 'select' || this.currentMode() === 'edit' || this.currentMode() === 'organize');
  readonly selectedPageNumbers = signal<Set<number>>(new Set());  // Selected pages for bulk operations
  private lastSelectedPage: number | null = null;  // For shift-click range selection

  // Page image cache - maps page number to data URL
  // Delegate to PageRenderService
  get pageImages() { return this.pageRenderService.pageImages; }

  // Multi-document support
  readonly openDocuments = signal<OpenDocument[]>([]);
  readonly activeDocumentId = signal<string | null>(null);

  // Computed: active tab ID for tab bar
  readonly activeTabId = computed(() => this.activeDocumentId());

  // Computed: tabs for tab bar (open documents only)
  readonly documentTabs = computed<DocumentTab[]>(() => {
    return this.openDocuments().map(doc => ({
      id: doc.id,
      name: doc.name,
      path: doc.path,
      hasUnsavedChanges: doc.hasUnsavedChanges,
      closable: true
    }));
  });

  // Toolbar items (computed based on state)
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const pdfIsOpen = this.pdfLoaded();
    const lightweight = this.lightweightMode();

    // Base items always shown
    const baseItems: ToolbarItem[] = [
      { id: 'open', type: 'button', icon: '📂', label: 'Open File', tooltip: 'Open PDF file' },
    ];

    // Items only shown when PDF is open
    if (pdfIsOpen) {
      return [
        ...baseItems,
        {
          id: 'export',
          type: 'button',
          icon: '📤',
          label: 'Export',
          tooltip: 'Export document (Ctrl+E)'
        },
        {
          id: 'search',
          type: 'button',
          icon: '🔍',
          label: 'Search',
          tooltip: lightweight ? 'Not available in lightweight mode' : 'Search text (Ctrl+F)',
          disabled: lightweight
        },
        { id: 'divider1', type: 'divider' },
        { id: 'undo', type: 'button', icon: '↩', tooltip: lightweight ? 'Not available in lightweight mode' : 'Undo (Ctrl+Z)', disabled: lightweight || !this.canUndo() },
        { id: 'redo', type: 'button', icon: '↪', tooltip: lightweight ? 'Not available in lightweight mode' : 'Redo (Ctrl+Shift+Z)', disabled: lightweight || !this.canRedo() },
        { id: 'spacer', type: 'spacer' },
        { id: 'divider2', type: 'divider' },
        {
          id: 'layout',
          type: 'toggle',
          icon: this.layout() === 'grid' ? '☰' : '⊞',
          label: this.layout() === 'grid' ? 'List' : 'Grid',
          tooltip: lightweight ? 'Not available in lightweight mode' : 'Toggle layout',
          active: this.layout() === 'grid',
          disabled: lightweight
        },
        { id: 'zoom-out', type: 'button', icon: '−', tooltip: lightweight ? 'Not available in lightweight mode' : 'Zoom out', disabled: lightweight },
        { id: 'zoom-level', type: 'button', label: `${this.zoom()}%`, disabled: true },
        { id: 'zoom-in', type: 'button', icon: '+', tooltip: lightweight ? 'Not available in lightweight mode' : 'Zoom in', disabled: lightweight },
        { id: 'zoom-reset', type: 'button', label: 'Reset', tooltip: lightweight ? 'Not available in lightweight mode' : 'Reset zoom', disabled: lightweight }
      ];
    }

    // When no PDF is open, show minimal toolbar
    return [
      ...baseItems,
      { id: 'spacer', type: 'spacer' }
    ];
  });

  // Computed values
  readonly visibleBlocks = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks().filter(b => !deleted.has(b.id));
  });

  readonly categoriesArray = computed(() => {
    return Object.values(this.categories()).sort((a, b) => b.char_count - a.char_count);
  });

  readonly includedChars = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks()
      .filter(b => !deleted.has(b.id))
      .reduce((sum, b) => sum + b.char_count, 0);
  });

  readonly excludedChars = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks()
      .filter(b => deleted.has(b.id))
      .reduce((sum, b) => sum + b.char_count, 0);
  });

  // Array of all page numbers (for timeline and viewer)
  readonly pageNumbers = computed(() => {
    const order = this.pageOrder();
    if (order && order.length > 0) {
      return order;
    }
    return Array.from({ length: this.totalPages() }, (_, i) => i);
  });

  // Map of page number -> selection count (for timeline highlighting)
  readonly pagesWithSelections = computed(() => {
    const selectedIds = new Set(this.selectedBlockIds());
    const pageCounts = new Map<number, number>();

    for (const block of this.blocks()) {
      if (selectedIds.has(block.id)) {
        pageCounts.set(block.page, (pageCounts.get(block.page) || 0) + 1);
      }
    }

    return pageCounts;
  });

  // Timeline highlights - shows selections normally, regex matches when searching
  readonly timelineHighlights = computed(() => {
    // When regex panel is expanded, show pages with regex matches instead of selections
    if (this.regexPanelExpanded()) {
      const matches = this.regexMatches();
      const pageCounts = new Map<number, number>();

      for (const match of matches) {
        pageCounts.set(match.page, (pageCounts.get(match.page) || 0) + 1);
      }

      return pageCounts;
    }

    // Otherwise show normal selections
    return this.pagesWithSelections();
  });

  // Count of pages that have finished loading (for progress indicator)
  readonly pagesLoaded = computed(() => {
    const images = this.pageImages();
    let loaded = 0;
    for (const [_, value] of images) {
      if (value && value !== 'loading' && value !== 'failed') {
        loaded++;
      }
    }
    return loaded;
  });

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'open':
        this.openPdfWithNativeDialog();
        break;
      case 'export':
        this.showExportSettings.set(true);
        break;
      case 'search':
        this.toggleSearch();
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case 'layout':
        this.layout.update(l => {
          const newLayout = l === 'vertical' ? 'grid' : 'vertical';
          // When switching to grid, auto-zoom and reset pagination
          if (newLayout === 'grid') {
            this.userAdjustedZoom = false;
            setTimeout(() => {
              this.autoZoomForGrid();
              this.pdfViewer?.resetGridPagination();
            }, 0);
          }
          return newLayout;
        });
        break;
      case 'remove-backgrounds':
        this.toggleRemoveBackgrounds();
        break;
      case 'zoom-in':
        // 50% jumps - use scroll wheel or type for precision
        this.userAdjustedZoom = true;
        this.zoom.update(z => Math.min(Math.round(z * 1.5), 2000));
        break;
      case 'zoom-out':
        // 50% jumps - use scroll wheel or type for precision
        this.userAdjustedZoom = true;
        this.zoom.update(z => Math.max(Math.round(z / 1.5), 10));
        break;
      case 'zoom-reset':
        this.userAdjustedZoom = true;
        this.zoom.set(100);
        break;
    }
  }

  onDropdownItemClicked(event: { parent: ToolbarItem; item: { id: string; label: string } }): void {
    if (event.parent.id === 'ui-size') {
      switch (event.item.id) {
        case 'ui-small':
          this.themeService.setUiSize('small');
          break;
        case 'ui-medium':
          this.themeService.setUiSize('medium');
          break;
        case 'ui-large':
          this.themeService.setUiSize('large');
          break;
      }
    }
  }

  /**
   * Toggle remove backgrounds mode
   * Intelligently detects and removes background images (yellowed paper, etc.)
   * - Identifies backgrounds: images that fill >85% of page AND page has text
   * - Also removes matching full-page images on blank pages (same background)
   * - Excludes first and last pages (covers)
   * - Keeps actual photos/illustrations (different from background pattern)
   */
  async toggleRemoveBackgrounds(): Promise<void> {
    const isCurrentlyEnabled = this.editorState.removeBackgrounds();

    if (!isCurrentlyEnabled) {
      // Enable: Find and delete background images
      const backgroundImageIds = this.detectBackgroundImages();

      if (backgroundImageIds.length > 0) {
        // Get affected pages before deleting
        const affectedPages = new Set(
          this.blocks()
            .filter(b => backgroundImageIds.includes(b.id))
            .map(b => b.page)
        );

        // Delete background images (this adds to undo stack)
        this.editorState.deleteBlocks(backgroundImageIds);

        // Re-render affected pages with fill regions
        this.loading.set(true);
        try {
          let count = 0;
          for (const pageNum of affectedPages) {
            count++;
            this.loadingText.set(`Removing backgrounds... (${count}/${affectedPages.size})`);
            await this.rerenderPageWithEdits(pageNum);
          }
        } finally {
          this.loading.set(false);
          this.loadingText.set('');
        }
      }

      // Set the flag (for UI indicator)
      this.editorState.removeBackgrounds.set(true);
    } else {
      // Disable: Restore background images that were deleted by this feature
      // We restore all image blocks that are currently deleted
      const deletedIds = this.deletedBlockIds();
      const imageBlockIds = this.blocks()
        .filter(b => b.is_image && deletedIds.has(b.id))
        .map(b => b.id);

      if (imageBlockIds.length > 0) {
        // Restore images (this adds to undo stack)
        this.editorState.restoreBlocks(imageBlockIds);

        // Reload original pages
        this.loading.set(true);
        this.loadingText.set('Restoring original pages...');

        try {
          this.pageRenderService.clear();
          await this.pageRenderService.loadAllPageImages(this.totalPages());
        } finally {
          this.loading.set(false);
          this.loadingText.set('');
        }
      }

      // Clear the flag
      this.editorState.removeBackgrounds.set(false);
    }
  }

  /**
   * Detect background images based on smart heuristics:
   * 1. Find "confirmed backgrounds": images filling >85% of page that also have text
   * 2. Find "matching backgrounds": full-page images on text-less pages that match
   *    the position/size of confirmed backgrounds (blank yellowed pages)
   * 3. Exclude cover pages (first and last)
   */
  private detectBackgroundImages(): string[] {
    const blocks = this.blocks();
    const pageDims = this.pageDimensions();
    const totalPages = this.totalPages();
    const backgroundIds: string[] = [];

    // Skip if we don't have page dimensions
    if (pageDims.length === 0) return [];

    // Group blocks by page
    const blocksByPage = new Map<number, typeof blocks>();
    for (const block of blocks) {
      if (!blocksByPage.has(block.page)) {
        blocksByPage.set(block.page, []);
      }
      blocksByPage.get(block.page)!.push(block);
    }

    // Track confirmed background image characteristics for matching
    const confirmedBackgroundPatterns: Array<{
      relativeX: number;      // x / pageWidth
      relativeY: number;      // y / pageHeight
      relativeCoverage: number; // (w*h) / (pageW*pageH)
    }> = [];

    // First pass: Find confirmed backgrounds (large image + text on same page)
    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      // Skip cover pages (first and last)
      if (pageNum === 0 || pageNum === totalPages - 1) continue;

      const pageBlocks = blocksByPage.get(pageNum) || [];
      const dims = pageDims[pageNum];
      if (!dims) continue;

      const pageArea = dims.width * dims.height;
      const imageBlocks = pageBlocks.filter(b => b.is_image);
      const textBlocks = pageBlocks.filter(b => !b.is_image);

      for (const img of imageBlocks) {
        const imgArea = img.width * img.height;
        const coverage = imgArea / pageArea;

        // Check if image fills most of the page (>85%)
        if (coverage > 0.85) {
          // If page also has text, this is definitely a background image
          if (textBlocks.length > 0) {
            backgroundIds.push(img.id);

            // Record the pattern for matching blank pages
            confirmedBackgroundPatterns.push({
              relativeX: img.x / dims.width,
              relativeY: img.y / dims.height,
              relativeCoverage: coverage
            });
          }
        }
      }
    }

    // Second pass: Find full-page images on blank pages that match confirmed backgrounds
    if (confirmedBackgroundPatterns.length > 0) {
      for (let pageNum = 0; pageNum < totalPages; pageNum++) {
        // Skip cover pages
        if (pageNum === 0 || pageNum === totalPages - 1) continue;

        const pageBlocks = blocksByPage.get(pageNum) || [];
        const dims = pageDims[pageNum];
        if (!dims) continue;

        const pageArea = dims.width * dims.height;
        const imageBlocks = pageBlocks.filter(b => b.is_image);
        const textBlocks = pageBlocks.filter(b => !b.is_image);

        // Only check pages with no text (potential blank background pages)
        if (textBlocks.length > 0) continue;

        for (const img of imageBlocks) {
          // Skip if already identified
          if (backgroundIds.includes(img.id)) continue;

          const imgArea = img.width * img.height;
          const coverage = imgArea / pageArea;

          // Check if it's a full-page image
          if (coverage > 0.85) {
            const relX = img.x / dims.width;
            const relY = img.y / dims.height;

            // Check if it matches any confirmed background pattern
            const matchesBackground = confirmedBackgroundPatterns.some(pattern => {
              const xDiff = Math.abs(relX - pattern.relativeX);
              const yDiff = Math.abs(relY - pattern.relativeY);
              const coverageDiff = Math.abs(coverage - pattern.relativeCoverage);

              // Consider it a match if position and size are very similar
              return xDiff < 0.05 && yDiff < 0.05 && coverageDiff < 0.1;
            });

            if (matchesBackground) {
              backgroundIds.push(img.id);
            }
          }
        }
      }
    }

    return backgroundIds;
  }

  /**
   * Apply the remove backgrounds state (for restoring from saved projects)
   */
  private async applyRemoveBackgrounds(enabled: boolean): Promise<void> {
    if (enabled) {
      // Re-render all pages that have deleted images
      this.loading.set(true);
      const deletedIds = this.deletedBlockIds();
      const affectedPages = new Set(
        this.blocks()
          .filter(b => b.is_image && deletedIds.has(b.id))
          .map(b => b.page)
      );

      try {
        let count = 0;
        for (const pageNum of affectedPages) {
          count++;
          this.loadingText.set(`Removing backgrounds... (${count}/${affectedPages.size})`);
          await this.rerenderPageWithEdits(pageNum);
        }
      } finally {
        this.loading.set(false);
        this.loadingText.set('');
      }
    } else {
      // Reload original pages
      this.loading.set(true);
      this.loadingText.set('Restoring original pages...');

      try {
        // Clear the render cache and reload pages
        this.pageRenderService.clear();
        await this.pageRenderService.loadAllPageImages(this.totalPages());
      } finally {
        this.loading.set(false);
        this.loadingText.set('');
      }
    }
  }

  /**
   * Re-render all pages (clears cache and re-renders fresh)
   */
  async reRenderPages(): Promise<void> {
    this.loading.set(true);
    this.loadingText.set('Re-rendering pages...');

    try {
      // Clear the current file's cache
      const fileHash = this.fileHash();
      if (fileHash) {
        // Truncate hash to 16 chars to match cache directory naming
        const truncatedHash = fileHash.substring(0, 16);
        await this.electronService.clearCache(truncatedHash);
      }

      // Clear blankedPages state (fresh render = no blanked pages)
      this.blankedPages.set(new Set());

      // Clear local state and reload
      this.pageRenderService.clear();
      await this.pageRenderService.loadAllPageImages(this.totalPages());
    } finally {
      this.loading.set(false);
      this.loadingText.set('');
    }
  }

  onZoomChange(direction: 'in' | 'out'): void {
    // Reuse toolbar zoom logic
    if (direction === 'in') {
      this.onToolbarAction({ id: 'zoom-in', type: 'button' });
    } else {
      this.onToolbarAction({ id: 'zoom-out', type: 'button' });
    }
  }

  // Delegate to PageRenderService
  getPageImageUrl(pageNum: number): string {
    return this.pageRenderService.getPageImageUrl(pageNum);
  }

  private getRenderScale(pageCount: number): number {
    return this.pageRenderService.getRenderScale(pageCount);
  }

  async openPdfWithNativeDialog(): Promise<void> {
    const result = await this.electronService.openPdfDialog();
    if (result.success && result.filePath) {
      this.loadPdf(result.filePath);
    }
  }

  showLibraryView(): void {
    // Save current document state and show library view
    this.saveCurrentDocumentState();
    this.activeDocumentId.set(null);
    this.pdfLoaded.set(false);
  }

  async onLibraryProjectsSelected(paths: string[]): Promise<void> {
    if (paths.length === 0) return;

    // Open each project in a new tab
    for (const path of paths) {
      await this.loadProjectFromPath(path);
    }
  }

  /**
   * Clear rendered data (cache) for selected projects
   * If a cleared file is currently open, it will revert to low-quality previews
   */
  async onClearCache(fileHashes: string[]): Promise<void> {
    if (fileHashes.length === 0) return;

    for (const hash of fileHashes) {
      // Truncate hash to 16 chars to match cache directory naming
      // (project stores full 64-char hash, cache uses truncated 16-char)
      const truncatedHash = hash.substring(0, 16);
      await this.electronService.clearCache(truncatedHash);
    }

    // If current document's cache was cleared, invalidate the render service
    const activeDoc = this.openDocuments().find(d => d.id === this.activeDocumentId());
    if (activeDoc && fileHashes.includes(activeDoc.fileHash)) {
      // Clear local render state - will reload previews on next render
      this.pageRenderService.clear();
      // Reload pages from scratch
      await this.pageRenderService.loadAllPageImages(this.totalPages());
    }

    this.showAlert({
      title: 'Cache Cleared',
      message: `Cleared rendered data for ${fileHashes.length} file${fileHashes.length > 1 ? 's' : ''}.`,
      type: 'success'
    });
  }

  /**
   * Handle projects being deleted from the library.
   * Close any open tabs for deleted projects and clear state completely.
   */
  onProjectsDeleted(deletedPaths: string[]): void {
    if (deletedPaths.length === 0) return;

    const deletedSet = new Set(deletedPaths);

    // Find any open documents that match deleted projects
    const docs = this.openDocuments();
    const docsToClose = docs.filter(d => d.projectPath && deletedSet.has(d.projectPath));

    if (docsToClose.length === 0) return;

    // Check if the active document is being deleted
    const activeDoc = docs.find(d => d.id === this.activeDocumentId());
    const activeIsDeleted = activeDoc && docsToClose.some(d => d.id === activeDoc.id);

    // Close the deleted tabs
    for (const doc of docsToClose) {
      this.openDocuments.update(all => all.filter(d => d.id !== doc.id));
    }

    // If the active document was deleted, clear the editor state completely
    if (activeIsDeleted) {
      this.editorState.reset();
      this.projectService.reset();
      this.pageRenderService.clear();
      this.blankedPages.set(new Set());

      // Switch to another tab if available, or back to library
      const remainingDocs = this.openDocuments();
      if (remainingDocs.length > 0) {
        this.restoreDocumentState(remainingDocs[0].id);
      } else {
        this.activeDocumentId.set(null);
        this.pdfLoaded.set(false);
      }
    }
  }

  /**
   * Handle errors from the library view.
   */
  onLibraryError(message: string): void {
    this.alertModal.set({
      title: 'Error',
      message,
      type: 'error'
    });
  }

  /**
   * Handle transfer to audiobook from library view.
   * For EPUB sources, copies directly to the audiobook queue.
   * For PDF sources, needs to be opened first to export.
   */
  async onTransferToAudiobook(projects: ProjectFile[]): Promise<void> {
    if (projects.length === 0) return;

    const epubProjects = projects.filter(p => p.sourceName.toLowerCase().endsWith('.epub'));
    const pdfProjects = projects.filter(p => !p.sourceName.toLowerCase().endsWith('.epub'));

    // Handle PDFs - they need to be opened first to export
    if (pdfProjects.length > 0 && epubProjects.length === 0) {
      this.alertModal.set({
        title: 'Open Project First',
        message: 'PDF projects need to be opened first before transferring to audiobook. Open the project and use Export → Audiobook from the toolbar.',
        type: 'info'
      });
      return;
    }

    // Warn about PDFs if mixed selection
    if (pdfProjects.length > 0) {
      this.alertModal.set({
        title: 'Partial Transfer',
        message: `${pdfProjects.length} PDF project(s) skipped. Only EPUB projects can be transferred directly. Open PDF projects and use Export → Audiobook from the toolbar.`,
        type: 'info'
      });
    }

    // Copy EPUB files to audiobook queue
    let successCount = 0;
    const errors: string[] = [];

    for (const project of epubProjects) {
      try {
        const result = await this.electronService.copyToAudiobookQueue(
          project.sourcePath,
          project.sourceName
        );
        if (result.success) {
          successCount++;
        } else {
          errors.push(`${project.sourceName}: ${result.error || 'Unknown error'}`);
        }
      } catch (err) {
        errors.push(`${project.sourceName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    if (successCount > 0) {
      this.alertModal.set({
        title: 'Transferred to Audiobook',
        message: `${successCount} EPUB${successCount > 1 ? 's' : ''} added to Audiobook Producer.${errors.length > 0 ? `\n\nFailed: ${errors.join(', ')}` : ''}`,
        type: 'success'
      });
      // Navigate to audiobook producer
      this.router.navigate(['/audiobook']);
    } else if (errors.length > 0) {
      this.alertModal.set({
        title: 'Transfer Failed',
        message: errors.join('\n'),
        type: 'error'
      });
    }
  }

  /**
   * Handle "Process without rendering" from library view.
   * Opens the file in lightweight mode without rendering pages.
   */
  async onProcessWithoutRendering(projects: ProjectFile[]): Promise<void> {
    if (projects.length === 0) return;

    // For now, just handle the first project
    const project = projects[0];

    // Load the project in lightweight mode
    await this.loadProjectFromPath(project.path, true);
  }

  private closePdf(): void {
    // Reset all state to show library view
    this.pdfLoaded.set(false);
    this.blocks.set([]);
    // Reset editor state via service
    this.editorState.reset();
    this.pageRenderService.clear();
    this.projectService.reset();

    // Clear blanked pages tracking
    this.blankedPages.set(new Set());

    // Clear crop mode
    this.currentMode.set('select');
    this.currentCropRect.set(null);
  }

  async loadPdf(path: string, lightweight: boolean = false): Promise<void> {
    this.showFilePicker.set(false);

    const lowerPath = path.toLowerCase();
    let effectivePath = path;

    // Check if file needs conversion (AZW3, MOBI, KFX, PRC, FB2, etc.)
    // EPUBs and PDFs are native formats - no conversion needed
    if (!lowerPath.endsWith('.epub') && !lowerPath.endsWith('.pdf')) {
      const formatInfo = await this.electronService.isEbookConvertible(path);
      if (formatInfo.convertible && !formatInfo.native) {
        // Check if ebook-convert is available
        const available = await this.electronService.isEbookConvertAvailable();
        if (available) {
          this.loading.set(true);
          this.loadingText.set('Converting to EPUB...');
          console.log('[PdfPicker] Converting', path, 'to EPUB...');
          const convResult = await this.electronService.convertEbookToLibrary(path);
          if (convResult.success && convResult.outputPath) {
            console.log('[PdfPicker] Conversion successful:', convResult.outputPath);
            effectivePath = convResult.outputPath;
            this.loading.set(false);
          } else {
            console.error('[PdfPicker] Conversion failed:', convResult.error);
            this.loading.set(false);
            return; // Can't proceed without conversion
          }
        } else {
          console.log('[PdfPicker] ebook-convert not available, cannot open', path);
          this.loading.set(false);
          return; // Silently ignore unsupported format
        }
      }
    }

    // At this point, we have a PDF or EPUB (native or converted)

    // Check if this document is already open (by original path or library path)
    const existingDoc = this.openDocuments().find(d => d.path === effectivePath || d.libraryPath === effectivePath);
    if (existingDoc) {
      // Switch to existing tab
      this.saveCurrentDocumentState();
      this.restoreDocumentState(existingDoc.id);
      return;
    }

    // Save current document state before loading new one
    this.saveCurrentDocumentState();

    this.loading.set(true);
    this.loadingText.set('Importing to library...');

    try {
      // Import file to library (copies file and deduplicates by hash)
      const importResult = await this.electronService.libraryImportFile(effectivePath);
      if (!importResult.success || !importResult.libraryPath) {
        throw new Error(importResult.error || 'Failed to import file to library');
      }

      const libraryPath = importResult.libraryPath;
      const fileHash = importResult.hash || '';

      // Check if already open by hash (same file, different path)
      const existingByHash = this.openDocuments().find(d => d.fileHash === fileHash && fileHash);
      if (existingByHash) {
        this.saveCurrentDocumentState();
        this.restoreDocumentState(existingByHash.id);
        this.loading.set(false);
        return;
      }

      this.loadingText.set('Analyzing PDF...');
      const result = await this.pdfService.analyzePdf(libraryPath);

      // Create new document
      const docId = this.generateDocumentId();
      const newDoc: OpenDocument = {
        id: docId,
        path: path,           // Original path for display
        libraryPath: libraryPath,  // Library path for operations
        fileHash: fileHash,
        name: result.pdf_name,
        blocks: result.blocks,
        categories: result.categories,
        pageDimensions: result.page_dimensions,
        totalPages: result.page_count,
        deletedBlockIds: new Set(),
        deletedPages: new Set(),
        selectedBlockIds: [],
        pageOrder: [],
        pageImages: new Map(),
        hasUnsavedChanges: false,
        projectPath: null,
        undoStack: [],
        redoStack: [],
        lightweightMode: lightweight
      };

      // Add to open documents
      this.openDocuments.update(docs => [...docs, newDoc]);
      this.activeDocumentId.set(docId);

      // Set current state via service
      this.editorState.loadDocument({
        blocks: result.blocks,
        categories: result.categories,
        pageDimensions: result.page_dimensions,
        totalPages: result.page_count,
        pdfName: result.pdf_name,
        pdfPath: path,
        libraryPath: libraryPath,
        fileHash: fileHash
      });
      this.pageRenderService.clear();
      this.projectService.reset();
      this.blankedPages.set(new Set());  // Clear blanked pages for new document
      this.metadata.set({});  // Clear metadata for new document

      this.saveRecentFile(path, result.pdf_name);

      // Set lightweight mode
      this.lightweightMode.set(lightweight);

      // Always initialize page rendering (so OCR can work)
      // But only load pages if NOT in lightweight mode
      this.pageRenderService.initialize(this.effectivePath(), result.page_count);

      // Show document immediately - pages will load progressively
      this.pdfLoaded.set(true);

      // Reset zoom tracking for new document and auto-zoom for grid
      this.userAdjustedZoom = false;
      if (!lightweight) {
        this.autoZoomForGrid();
      }

      // Reset grid pagination for efficient initial render
      if (!lightweight) {
        this.pdfViewer?.resetGridPagination();
      }

      // Auto-create project file for this document
      await this.autoCreateProject(path, result.pdf_name);

      // Start page rendering in background (non-blocking)
      // Pages will appear as they complete via the pageRenderService signals
      if (!lightweight) {
        this.pageRenderService.loadAllPageImages(result.page_count);
      }
    } catch (err) {
      console.error('Failed to load PDF:', err);
      this.showAlert({
        title: 'Error Loading PDF',
        message: (err as Error).message,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  onBlockClick(event: { block: TextBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
    const { block, shiftKey, metaKey, ctrlKey } = event;
    const isCmdOrCtrl = metaKey || ctrlKey;

    // Clear page selection when selecting blocks (mutually exclusive)
    if (this.selectedPageNumbers().size > 0) {
      this.selectedPageNumbers.set(new Set());
    }

    if (isCmdOrCtrl && !shiftKey) {
      // Cmd/Ctrl+click (without shift): deselect if selected, otherwise add to selection
      const selected = [...this.selectedBlockIds()];
      const idx = selected.indexOf(block.id);
      if (idx >= 0) {
        // Already selected - deselect it
        selected.splice(idx, 1);
        this.selectedBlockIds.set(selected);
      } else {
        // Not selected - add to selection (additive)
        selected.push(block.id);
        this.selectedBlockIds.set(selected);
      }
    } else if (shiftKey) {
      // Shift+click: add to selection (always additive, never removes)
      const selected = [...this.selectedBlockIds()];
      if (!selected.includes(block.id)) {
        selected.push(block.id);
      }
      this.selectedBlockIds.set(selected);
    } else {
      // Single click (no modifiers): select just this block
      // This is the cycling behavior - each click highlights the next overlapping block
      this.selectedBlockIds.set([block.id]);
    }
  }

  onBlockDoubleClick(event: {
    block: TextBlock;
    metaKey: boolean;
    ctrlKey: boolean;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
  }): void {
    const { block, metaKey, ctrlKey, screenX, screenY, screenWidth, screenHeight } = event;
    const mode = this.currentMode();
    const additive = metaKey || ctrlKey;

    if (mode === 'select') {
      // In select mode, double-click selects all similar items
      // With Cmd/Ctrl held, add to existing selection
      this.selectLikeThis(block, additive);
    } else if (mode === 'edit') {
      // In edit mode, double-click opens inline text editor
      this.openInlineEditor(block, screenX, screenY, screenWidth, screenHeight);
    }
    // In crop/organize modes, double-click does nothing
  }

  openInlineEditor(block: TextBlock, x: number, y: number, width: number, height: number): void {
    // Position the editor at the block's screen location
    // Calculate scale from screen rect to PDF coordinates
    const scale = block.height > 0 ? height / block.height : 1;

    // Get the text and base font size
    const text = this.editorState.textCorrections().get(block.id) ?? block.text;
    const baseFontSize = block.font_size || 12;

    // Check if this is a single-line block (height close to one line of text)
    const isSingleLine = block.height < baseFontSize * 2;

    // For multi-line blocks, use the original font size
    // For single-line blocks, shrink to fit if needed
    let fittedFontSize = baseFontSize;

    if (isSingleLine) {
      const padding = 8;
      const availableWidth = block.width - padding;

      if (availableWidth > 0 && text) {
        const avgCharWidthRatio = 0.55;
        const estimatedTextWidth = text.length * baseFontSize * avgCharWidthRatio;
        if (estimatedTextWidth > availableWidth) {
          const singleLineFontSize = availableWidth / (text.length * avgCharWidthRatio);
          const minFontSize = Math.max(8, baseFontSize * 0.5);
          fittedFontSize = Math.max(minFontSize, singleLineFontSize);
        }
      }
    }

    // Convert to screen coordinates
    // Apply a small adjustment factor (0.92) to match SVG text rendering more closely
    // SVG foreignObject text and CSS textarea text render at slightly different effective sizes
    const screenFontSize = fittedFontSize * scale * 0.92;

    // Store the calculated values
    this.inlineEditorBlock.set(block);
    this.inlineEditorX.set(x);
    this.inlineEditorY.set(y);
    // Slightly reduce dimensions to match the text area more closely
    this.inlineEditorWidth.set(Math.max(width * 0.98, 150));
    this.inlineEditorHeight.set(Math.max(height * 0.98, 40));
    this.inlineEditorCalculatedFontSize.set(Math.max(10, Math.min(48, screenFontSize)));
    this.showInlineEditor.set(true);
  }

  closeInlineEditor(): void {
    this.showInlineEditor.set(false);
    this.inlineEditorBlock.set(null);
  }

  onInlineEditComplete(result: TextEditResult): void {
    if (!result.cancelled) {
      const block = this.inlineEditorBlock();
      if (block) {
        // Check if text was actually changed
        const originalText = block.text;
        const correctedText = this.editorState.textCorrections().get(block.id);
        const previousText = correctedText ?? originalText;

        let needsRerender = false;

        if (result.text !== previousText) {
          if (result.text === originalText) {
            // Text was reverted to original - clear the correction
            this.editorState.clearTextCorrection(block.id);
          } else {
            // Text was changed - save as a correction (automatically adds to history)
            this.editorState.setTextCorrection(block.id, result.text);
            needsRerender = true;
          }
        }

        // Handle resize if dimensions changed
        if (result.width !== undefined && result.height !== undefined) {
          // Convert screen dimensions back to PDF coordinates
          const screenHeight = this.inlineEditorHeight();
          const pdfHeight = block.height;
          const scale = screenHeight / pdfHeight;

          const newPdfWidth = result.width / scale;
          const newPdfHeight = result.height / scale;

          // Get previous size for history
          const edit = this.editorState.blockEdits().get(block.id);
          const prevWidth = edit?.width ?? block.width;
          const prevHeight = edit?.height ?? block.height;

          // Update size
          this.editorState.setBlockSize(block.id, newPdfWidth, newPdfHeight, false);

          // Record resize in history
          this.editorState.recordResize(block.id, prevWidth, prevHeight, newPdfWidth, newPdfHeight);

          needsRerender = true;
        }

        // Re-render page with redactions to hide original text
        if (needsRerender) {
          this.rerenderPageWithEdits(block.page);
        }
      }
    }
    this.closeInlineEditor();
  }

  // Track initial position before drag for undo support
  private dragStartPosition: { blockId: string; offsetX: number; offsetY: number } | null = null;

  // Handle block position changes from drag/drop in edit mode (called during drag)
  onBlockMoved(event: { blockId: string; offsetX: number; offsetY: number }): void {
    const { blockId, offsetX, offsetY } = event;

    // Capture initial position when drag starts
    if (!this.dragStartPosition || this.dragStartPosition.blockId !== blockId) {
      const edit = this.editorState.blockEdits().get(blockId);
      this.dragStartPosition = {
        blockId,
        offsetX: edit?.offsetX ?? 0,
        offsetY: edit?.offsetY ?? 0
      };
    }

    // Update position for visual feedback during drag (no re-render yet)
    if (Math.abs(offsetX) > 0.5 || Math.abs(offsetY) > 0.5) {
      this.editorState.setBlockPosition(blockId, offsetX, offsetY, false);
    } else {
      this.editorState.clearBlockPosition(blockId, false);
    }
  }

  // Handle block drag completion - re-render page with redactions
  onBlockDragEnd(event: { blockId: string; pageNum: number }): void {
    const { blockId, pageNum } = event;

    // Add to undo history if position changed
    if (this.dragStartPosition && this.dragStartPosition.blockId === blockId) {
      const edit = this.editorState.blockEdits().get(blockId);
      const finalOffsetX = edit?.offsetX ?? 0;
      const finalOffsetY = edit?.offsetY ?? 0;

      // Record the move in history with before/after positions
      this.editorState.recordMove(
        blockId,
        this.dragStartPosition.offsetX,
        this.dragStartPosition.offsetY,
        finalOffsetX,
        finalOffsetY
      );

      this.dragStartPosition = null;
    }

    // Re-render the page with redactions now that drag is complete
    this.rerenderPageWithEdits(pageNum);
  }

  /**
   * Get all redact regions for a page (deleted blocks and edited blocks' original positions)
   */
  private getRedactRegionsForPage(pageNum: number): Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }> {
    const regions: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }> = [];
    const blockEdits = this.editorState.blockEdits();
    const deletedIds = this.deletedBlockIds();

    for (const block of this.blocks()) {
      if (block.page !== pageNum) continue;

      // Check if block is deleted - add to redact regions
      if (deletedIds.has(block.id)) {
        regions.push({
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height,
          isImage: block.is_image
        });
        continue;
      }

      const edit = blockEdits.get(block.id);
      if (!edit) continue;

      // Block has an edit - only redact for text/size changes, NOT position changes
      // Position changes just move the overlay without affecting the background
      const hasTextEdit = edit.text !== undefined;
      const hasSizeEdit = edit.width !== undefined || edit.height !== undefined;

      if (hasTextEdit || hasSizeEdit) {
        regions.push({
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height
        });
      }
    }

    return regions;
  }

  /**
   * Get fill regions for a page (blocks with position edits - fill with background color)
   */
  private getFillRegionsForPage(pageNum: number): Array<{ x: number; y: number; width: number; height: number }> {
    const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
    const blockEdits = this.editorState.blockEdits();

    for (const block of this.blocks()) {
      if (block.page !== pageNum) continue;

      const edit = blockEdits.get(block.id);
      if (!edit) continue;

      // Only include position-only edits (no text or size changes)
      const hasTextEdit = edit.text !== undefined;
      const hasSizeEdit = edit.width !== undefined || edit.height !== undefined;
      const hasPositionEdit = edit.offsetX !== undefined || edit.offsetY !== undefined;

      // Position-only moves get background fill (not redaction)
      if (hasPositionEdit && !hasTextEdit && !hasSizeEdit) {
        regions.push({
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height
        });
      }
    }

    return regions;
  }

  /**
   * Check if all image blocks on a page are deleted
   */
  private areAllImagesDeletedOnPage(pageNum: number): boolean {
    const deletedIds = this.deletedBlockIds();
    const pageBlocks = this.blocks().filter(b => b.page === pageNum);
    const imageBlocks = pageBlocks.filter(b => b.is_image);

    // Return true if there are image blocks and ALL are deleted
    return imageBlocks.length > 0 && imageBlocks.every(b => deletedIds.has(b.id));
  }

  /**
   * Re-render a page with all edited blocks' original positions redacted
   */
  private rerenderPageWithEdits(pageNum: number): void {
    // Always remove from blankedPages - we no longer use blank page rendering
    // Instead, we paint white over deleted images to preserve original text positioning
    this.blankedPages.update(pages => {
      if (pages.has(pageNum)) {
        const newPages = new Set(pages);
        newPages.delete(pageNum);
        return newPages;
      }
      return pages;
    });

    const redactRegions = this.getRedactRegionsForPage(pageNum);
    const fillRegions = this.getFillRegionsForPage(pageNum);

    if (redactRegions.length > 0 || fillRegions.length > 0) {
      // Pass both redact regions (for deleted/edited) and fill regions (for moved)
      // This includes deleted images - they get painted white while preserving native PDF text
      this.pageRenderService.rerenderPageWithRedactions(
        pageNum,
        redactRegions.length > 0 ? redactRegions : undefined,
        fillRegions.length > 0 ? fillRegions : undefined
      );
    } else {
      // No more edits on this page - re-render from original PDF
      this.pageRenderService.rerenderPageFromOriginal(pageNum);
    }
  }

  // Legacy modal methods (kept for compatibility)
  openTextEditor(block: TextBlock): void {
    this.editingBlock.set(block);
    this.editedText.set(block.text);
    this.showTextEditor.set(true);
  }

  cancelTextEdit(): void {
    this.showTextEditor.set(false);
    this.editingBlock.set(null);
    this.editedText.set('');
  }

  saveTextEdit(): void {
    const block = this.editingBlock();
    const newText = this.editedText();

    if (!block || newText === block.text) {
      this.cancelTextEdit();
      return;
    }

    // Save as text correction instead of modifying block directly
    this.editorState.setTextCorrection(block.id, newText);

    // Close modal
    this.cancelTextEdit();
  }

  // Alert modal methods
  showAlert(options: Partial<AlertModal> & { title: string; message: string }): void {
    this.alertModal.set({
      type: 'info',
      confirmText: 'OK',
      ...options
    });
  }

  closeAlert(): void {
    this.alertModal.set(null);
  }

  onAlertConfirm(): void {
    const modal = this.alertModal();
    if (modal?.onConfirm) {
      modal.onConfirm();
    }
    this.closeAlert();
  }

  onAlertCancel(): void {
    const modal = this.alertModal();
    if (modal?.onCancel) {
      modal.onCancel();
    }
    this.closeAlert();
  }

  onBlockHover(_block: TextBlock | null): void {
    // Could show tooltip here
  }

  selectLikeThis(block: TextBlock, additive: boolean = false): void {
    const categoryId = block.category_id;
    const deleted = this.deletedBlockIds();
    const matching = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id))
      .map(b => b.id);

    if (additive) {
      // Add to existing selection (deduplicated)
      const current = new Set(this.selectedBlockIds());
      matching.forEach(id => current.add(id));
      this.selectedBlockIds.set([...current]);
    } else {
      // Replace selection
      this.selectedBlockIds.set(matching);
    }
  }

  onMarqueeSelect(event: { blockIds: string[]; additive: boolean }): void {
    const { blockIds, additive } = event;

    if (blockIds.length === 0) return;

    if (additive) {
      // Add to existing selection (toggle: remove if already selected)
      const existing = new Set(this.selectedBlockIds());
      const allSelected = blockIds.every(id => existing.has(id));

      if (allSelected) {
        // All are already selected - deselect them
        blockIds.forEach(id => existing.delete(id));
      } else {
        // Add new blocks to selection
        blockIds.forEach(id => existing.add(id));
      }
      this.selectedBlockIds.set([...existing]);
    } else {
      // Replace selection
      this.selectedBlockIds.set(blockIds);
    }
  }

  onPageReorder(newOrder: number[]): void {
    // Use editor state for undo/redo support
    this.editorState.setPageOrder(newOrder);
  }

  deleteSelectedBlocks(): void {
    const selected = this.selectedBlockIds();
    if (selected.length === 0) return;

    const deleted = this.deletedBlockIds();

    // Check if ALL selected blocks are already deleted - toggle to restore
    const allDeleted = selected.every(id => deleted.has(id));

    if (allDeleted) {
      // Restore all selected blocks (toggle off)
      // Get affected pages before restoration
      const affectedPages = new Set<number>();
      for (const blockId of selected) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }

      this.editorState.restoreBlocks(selected);
      this.editorState.clearSelection();

      // Re-render affected pages to restore original content
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    } else {
      // Get blocks being deleted and their pages
      const blocksToDelete = selected.filter(id => !deleted.has(id));
      const affectedPages = new Set<number>();
      for (const blockId of blocksToDelete) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }

      // Delete the non-deleted selected blocks
      this.editorState.deleteSelectedBlocks();

      // Re-render affected pages to remove deleted content
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    }
  }

  deleteLikeThis(block: TextBlock): void {
    const categoryId = block.category_id;
    const deleted = this.deletedBlockIds();
    const blocksToDelete = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id));

    if (blocksToDelete.length === 0) return;

    // Get affected pages before deletion
    const affectedPages = new Set(blocksToDelete.map(b => b.page));

    this.editorState.deleteBlocks(blocksToDelete.map(b => b.id));
    this.editorState.clearSelection();

    // Re-render affected pages to remove deleted content
    for (const pageNum of affectedPages) {
      this.rerenderPageWithEdits(pageNum);
    }
  }

  deleteBlock(blockId: string): void {
    if (this.deletedBlockIds().has(blockId)) return;

    // Get the block's page before deletion
    const block = this.editorState.getBlock(blockId);
    const pageNum = block?.page;

    this.editorState.deleteBlocks([blockId]);

    // Re-render the page to remove deleted content
    if (pageNum !== undefined) {
      this.rerenderPageWithEdits(pageNum);
    }
  }

  /**
   * Handle click on a custom category highlight (click-through selection).
   * Toggles the deleted state of the highlight.
   */
  onHighlightClick(event: { catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
    const highlightId = this.getHighlightId(event.catId, event.pageNum, event.rect.x, event.rect.y);
    const deletedIds = this.deletedHighlightIds();

    // Toggle deleted state
    const newDeletedIds = new Set(deletedIds);
    if (deletedIds.has(highlightId)) {
      newDeletedIds.delete(highlightId);
    } else {
      newDeletedIds.add(highlightId);
    }

    this.deletedHighlightIds.set(newDeletedIds);
    this.hasUnsavedChanges.set(true);
  }

  revertBlockText(blockId: string): void {
    // Clear the text correction to revert to original
    this.editorState.clearTextCorrection(blockId);
    // Re-render the page to show original text
    const block = this.editorState.getBlock(blockId);
    if (block) {
      this.rerenderPageWithEdits(block.page);
    }
  }

  // Delegate undo/redo to service
  async undo(): Promise<void> {
    const action = this.editorState.undo();
    if (!action) return;

    // Handle visual changes based on action type
    if (action.type === 'toggleBackgrounds') {
      await this.applyRemoveBackgrounds(action.backgroundsBefore ?? false);
    } else if (action.type === 'delete' || action.type === 'restore') {
      // Re-render affected pages when block deletion state changes
      const affectedPages = new Set<number>();
      for (const blockId of action.blockIds) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    }
    // Page deletion/restoration/reorder are handled by signals automatically
  }

  async redo(): Promise<void> {
    const action = this.editorState.redo();
    if (!action) return;

    // Handle visual changes based on action type
    if (action.type === 'toggleBackgrounds') {
      await this.applyRemoveBackgrounds(action.backgroundsAfter ?? false);
    } else if (action.type === 'delete' || action.type === 'restore') {
      // Re-render affected pages when block deletion state changes
      const affectedPages = new Set<number>();
      for (const blockId of action.blockIds) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    }
    // Page deletion/restoration/reorder are handled by signals automatically
  }

  // Click on category: add/enable. Cmd/Ctrl+click: remove/disable
  selectAllOfCategory(event: { categoryId: string; additive: boolean }): void {
    const { categoryId, additive } = event;

    // Custom categories: enable/disable visibility and track as focused
    if (categoryId.startsWith('custom_')) {
      // Track this as the focused custom category (for keyboard delete)
      this.focusedCategoryId.set(categoryId);

      this.categories.update(cats => {
        const cat = cats[categoryId];
        if (!cat) return cats;
        // Toggle: if enabled, disable; if disabled, enable
        // Cmd+click always disables
        const newEnabled = additive ? false : !cat.enabled;
        return {
          ...cats,
          [categoryId]: {
            ...cat,
            enabled: newEnabled
          }
        };
      });
      return;
    }

    // Clear focused custom category when clicking a regular category
    this.focusedCategoryId.set(null);

    // Regular categories: select ALL blocks in category (including deleted ones)
    // User can press Delete to toggle deletion state
    const allBlocks = this.blocks();
    const categoryBlocks = allBlocks.filter(b => b.category_id === categoryId);
    const blockIds = categoryBlocks.map(b => b.id);

    if (blockIds.length === 0) return;

    const existing = new Set(this.selectedBlockIds());
    const allSelected = blockIds.every(id => existing.has(id));

    // Toggle behavior: if all blocks from this category are selected, remove them
    // Otherwise, add them (keeps other categories selected)
    if (allSelected) {
      blockIds.forEach(id => existing.delete(id));
    } else {
      blockIds.forEach(id => existing.add(id));
    }

    this.selectedBlockIds.set([...existing]);
  }

  // Select inverse: toggle selection of all blocks in a category
  // Selected blocks become unselected, unselected blocks become selected
  selectInverseOfCategory(categoryId: string): void {
    const deleted = this.deletedBlockIds();
    const blockIds = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id))
      .map(b => b.id);

    const currentSelection = new Set(this.selectedBlockIds());
    const newSelection = new Set(this.selectedBlockIds());

    for (const blockId of blockIds) {
      if (currentSelection.has(blockId)) {
        // Was selected -> unselect
        newSelection.delete(blockId);
      } else {
        // Was unselected -> select
        newSelection.add(blockId);
      }
    }

    this.selectedBlockIds.set([...newSelection]);
  }

  // Clear all selections
  clearSelection(): void {
    this.selectedBlockIds.set([]);
  }

  // Select all blocks (non-deleted)
  selectAllBlocks(): void {
    const deleted = this.deletedBlockIds();
    const allBlockIds = this.blocks()
      .filter(b => !deleted.has(b.id))
      .map(b => b.id);
    this.selectedBlockIds.set(allBlockIds);
  }

  // Select all blocks on a specific page
  selectAllOnPage(pageNum: number): void {
    const deleted = this.deletedBlockIds();
    const pageBlockIds = this.blocks()
      .filter(b => b.page === pageNum && !deleted.has(b.id))
      .map(b => b.id);

    // Add to existing selection
    const existing = new Set(this.selectedBlockIds());
    pageBlockIds.forEach(id => existing.add(id));
    this.selectedBlockIds.set([...existing]);
  }

  // Deselect all blocks on a specific page
  deselectAllOnPage(pageNum: number): void {
    const pageBlockIds = new Set(
      this.blocks()
        .filter(b => b.page === pageNum)
        .map(b => b.id)
    );

    // Remove page blocks from selection
    const newSelection = this.selectedBlockIds().filter(id => !pageBlockIds.has(id));
    this.selectedBlockIds.set(newSelection);
  }

  // Scroll to a specific page (used by timeline)
  scrollToPage(pageNum: number): void {
    this.pdfViewer?.scrollToPage(pageNum);
  }

  async exportText(): Promise<void> {
    const result = await this.exportService.exportText(
      this.blocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.textCorrections(),
      this.deletedPages()
    );

    if (!result.success) {
      this.showAlert({
        title: 'Nothing to Export',
        message: result.message,
        type: 'warning'
      });
    }
  }

  async exportEpub(): Promise<void> {
    // Use chapter-aware export if chapters are defined
    const chapters = this.chapters();
    const deletedHighlights = this.getDeletedHighlights();
    const result = chapters.length > 0
      ? await this.exportService.exportEpubWithChapters(
          this.blocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.textCorrections(),
          this.deletedPages(),
          deletedHighlights
        )
      : await this.exportService.exportEpub(
          this.blocks(),
          this.deletedBlockIds(),
          this.pdfName(),
          this.textCorrections(),
          this.deletedPages(),
          deletedHighlights
        );

    if (!result.success) {
      this.showAlert({
        title: 'Nothing to Export',
        message: result.message,
        type: 'warning'
      });
    }
  }

  /**
   * Show export settings modal
   */
  exportPdf(): void {
    this.showExportSettings.set(true);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Search functionality
  // ─────────────────────────────────────────────────────────────────────────────

  toggleSearch(): void {
    if (this.showSearch()) {
      this.closeSearch();
    } else {
      this.showSearch.set(true);
      // Focus the input after it renders
      setTimeout(() => {
        this.searchInputRef?.nativeElement.focus();
        this.searchInputRef?.nativeElement.select();
      }, 0);
    }
  }

  closeSearch(): void {
    this.showSearch.set(false);
    this.clearSearch();
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.currentSearchIndex.set(-1);
    // Clear highlights in viewer
    this.pdfViewer?.clearSearchHighlights();
  }

  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);

    // Debounce search
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    this.searchDebounceTimer = setTimeout(() => {
      this.performSearch();
    }, 200);
  }

  private performSearch(): void {
    const query = this.searchQuery().trim();
    if (!query) {
      this.searchResults.set([]);
      this.currentSearchIndex.set(-1);
      this.pdfViewer?.clearSearchHighlights();
      return;
    }

    const blocks = this.blocks();
    const deletedIds = this.deletedBlockIds();
    const results: { blockId: string; page: number; text: string; matchStart: number; matchEnd: number }[] = [];

    // Search through non-deleted text blocks
    const searchLower = query.toLowerCase();
    for (const block of blocks) {
      if (deletedIds.has(block.id) || block.is_image) continue;

      const textLower = block.text.toLowerCase();
      let pos = 0;
      while ((pos = textLower.indexOf(searchLower, pos)) !== -1) {
        results.push({
          blockId: block.id,
          page: block.page,
          text: block.text,
          matchStart: pos,
          matchEnd: pos + query.length
        });
        pos += 1; // Find overlapping matches
      }
    }

    // Sort by page, then by position within the block
    results.sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return a.matchStart - b.matchStart;
    });

    this.searchResults.set(results);
    this.currentSearchIndex.set(results.length > 0 ? 0 : -1);

    // Highlight results in viewer and navigate to first
    if (results.length > 0) {
      const matchingBlockIds = [...new Set(results.map(r => r.blockId))];
      this.pdfViewer?.highlightSearchResults(matchingBlockIds, results[0].blockId);
      this.navigateToSearchResult(0);
    } else {
      this.pdfViewer?.clearSearchHighlights();
    }
  }

  goToNextResult(): void {
    const results = this.searchResults();
    if (results.length === 0) return;

    const currentIndex = this.currentSearchIndex();
    const nextIndex = (currentIndex + 1) % results.length;
    this.currentSearchIndex.set(nextIndex);
    this.navigateToSearchResult(nextIndex);
  }

  goToPrevResult(): void {
    const results = this.searchResults();
    if (results.length === 0) return;

    const currentIndex = this.currentSearchIndex();
    const prevIndex = currentIndex <= 0 ? results.length - 1 : currentIndex - 1;
    this.currentSearchIndex.set(prevIndex);
    this.navigateToSearchResult(prevIndex);
  }

  private navigateToSearchResult(index: number): void {
    const results = this.searchResults();
    if (index < 0 || index >= results.length) return;

    const result = results[index];
    // Navigate to the page containing this result
    this.pdfViewer?.scrollToPage(result.page);
    // Highlight the current result block
    this.pdfViewer?.highlightCurrentSearchResult(result.blockId);
  }

  /**
   * Handle export settings modal result
   */
  async onExportSettingsResult(result: ExportResult): Promise<void> {
    this.showExportSettings.set(false);

    if (!result.confirmed || !result.settings) {
      return;
    }

    const settings = result.settings;
    this.loading.set(true);
    // Reset page render progress to hide the secondary progress bar during export
    this.pageRenderService.loadingProgress.set({ current: 0, total: 0, phase: 'preview' });

    try {
      // Handle different export formats
      switch (settings.format) {
        case 'txt':
          await this.exportAsTxt();
          break;
        case 'epub':
          await this.exportAsEpub(settings.textOnlyEpub);
          break;
        case 'audiobook':
          await this.exportToAudiobook(settings.textOnlyEpub);
          break;
        case 'pdf':
        default:
          await this.exportAsPdf(settings);
          break;
      }
    } catch (err) {
      this.showAlert({
        title: 'Export Failed',
        message: (err as Error).message,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Export as TXT format
   */
  private async exportAsTxt(): Promise<void> {
    this.loadingText.set('Exporting text...');

    const result = await this.exportService.exportText(
      this.blocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.editorState.textCorrections(),
      this.deletedPages()
    );

    if (!result.success) {
      this.showAlert({
        title: 'Export Failed',
        message: result.message,
        type: 'error'
      });
    }
  }

  /**
   * Export as EPUB format
   */
  private async exportAsEpub(textOnlyMode?: boolean): Promise<void> {
    // Use text-only export if requested
    if (textOnlyMode) {
      this.loadingText.set('Extracting text and generating EPUB...');

      // Generate output filename
      const baseName = this.pdfName().replace(/\.[^.]+$/, '');
      const outputFilename = `${baseName}_text-only.epub`;

      // Get metadata
      const metadata = {
        title: baseName,
        author: 'Unknown'  // Could enhance this to extract from PDF metadata
      };

      // Use the text-only export via pdftotext + ebook-convert
      const result = await this.electronService.exportTextOnlyEpub(
        this.effectivePath(),  // Source PDF path
        metadata
      );

      if (result.success && result.data) {
        // Convert base64 to blob and download
        const binaryString = atob(result.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/epub+zip' });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outputFilename;
        a.click();
        URL.revokeObjectURL(url);

        this.showAlert({
          title: 'Export Successful',
          message: `Text-only EPUB exported successfully`,
          type: 'success'
        });
      } else {
        this.showAlert({
          title: 'Export Failed',
          message: result.error || 'Failed to export text-only EPUB',
          type: 'error'
        });
      }
      return;
    }

    // Regular EPUB export (existing code)
    this.loadingText.set('Generating EPUB...');

    // Use chapter-aware export if chapters are defined
    const chapters = this.chapters();
    const deletedHighlights = this.getDeletedHighlights();
    const result = chapters.length > 0
      ? await this.exportService.exportEpubWithChapters(
          this.blocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          deletedHighlights
        )
      : await this.exportService.exportEpub(
          this.blocks(),
          this.deletedBlockIds(),
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          deletedHighlights
        );

    if (!result.success) {
      this.showAlert({
        title: 'Export Failed',
        message: result.message,
        type: 'error'
      });
    }
  }

  /**
   * Export to Audiobook Producer
   */
  private async exportToAudiobook(textOnlyMode?: boolean): Promise<void> {
    // Use text-only export if requested
    if (textOnlyMode) {
      this.loadingText.set('Extracting text and preparing audiobook...');

      // Generate filename
      const baseName = this.pdfName().replace(/\.[^.]+$/, '');
      const epubFilename = `${baseName}_text-only.epub`;

      // Get metadata
      const metadata = {
        title: this.metadata()?.title || baseName,
        author: this.metadata()?.author || 'Unknown'
      };

      // First, create text-only EPUB using pdftotext + ebook-convert
      const epubResult = await this.electronService.exportTextOnlyEpub(
        this.effectivePath(),  // Source PDF path
        metadata
      );

      if (!epubResult.success || !epubResult.data) {
        this.showAlert({
          title: 'Export Failed',
          message: epubResult.error || 'Failed to create text-only EPUB for audiobook',
          type: 'error'
        });
        return;
      }

      // Convert base64 to ArrayBuffer for the queue
      const binaryString = atob(epubResult.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Use the electron API directly (like export service does) which accepts ArrayBuffer
      if (typeof window !== 'undefined' && (window as any).electron) {
        const queueResult = await (window as any).electron.library.copyToQueue(
          bytes.buffer,  // ArrayBuffer
          epubFilename,
          this.metadata()  // metadata
        );

        if (queueResult.success) {
          // Navigate to audiobook producer
          await this.router.navigate(['/audiobook']);

          this.showAlert({
            title: 'Export Successful',
            message: 'Text-only EPUB added to Audiobook Producer queue',
            type: 'success'
          });
        } else {
          this.showAlert({
            title: 'Export Failed',
            message: queueResult.error || 'Failed to add to audiobook queue',
            type: 'error'
          });
        }
      } else {
        this.showAlert({
          title: 'Export Failed',
          message: 'Audiobook export is only available in Electron',
          type: 'error'
        });
      }
      return;
    }

    // Regular audiobook export (existing code)
    this.loadingText.set('Preparing audiobook export...');

    const chapters = this.chapters();
    const deletedHighlights = this.getDeletedHighlights();

    const result = await this.exportService.exportToAudiobook(
      this.blocks(),
      this.deletedBlockIds(),
      chapters,
      this.pdfName(),
      this.editorState.textCorrections(),
      this.deletedPages(),
      deletedHighlights,
      this.metadata(),  // Pass metadata for title, author, cover, etc.
      true // Navigate to audiobook producer after
    );

    if (!result.success) {
      this.showAlert({
        title: 'Export Failed',
        message: result.message,
        type: 'error'
      });
    }
  }

  /**
   * Export as PDF format (with optional background removal)
   *
   * Image deletion now uses object-level removal (preserves fonts perfectly).
   * The removeBackgrounds option is for paper cleanup (yellowed → white) only,
   * which requires page rasterization and is only used when no content deletions.
   */
  private async exportAsPdf(settings: ExportSettings): Promise<void> {
    // Check if we have any deletions (blocks, highlights, or pages)
    const hasDeletedBlocks = this.deletedBlockIds().size > 0;
    const hasDeletedHighlights = this.deletedHighlightIds().size > 0;
    const hasDeletedPages = this.deletedPages().size > 0;
    const hasAnyDeletions = hasDeletedBlocks || hasDeletedHighlights || hasDeletedPages;

    // Use rasterization path ONLY for pure paper background cleanup (no deletions)
    // When there are deletions, always use object-level manipulation to preserve fonts
    if (settings.removeBackgrounds && !hasAnyDeletions) {
      // Pure paper background cleanup (yellowed paper → white, no content changes)
      this.loadingText.set('Cleaning paper backgrounds...');

      const unsubscribe = this.electronService.onExportProgress((progress) => {
        this.loadingText.set(`Processing page ${progress.current + 1} of ${progress.total}...`);
      });

      let pdfBase64: string;
      try {
        const scale = this.getScaleFromQuality(settings.quality);
        pdfBase64 = await this.electronService.exportPdfNoBackgrounds(scale);
      } finally {
        unsubscribe();
      }

      // Trigger download
      const byteCharacters = atob(pdfBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/pdf' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = this.pdfName().replace(/\.[^.]+$/, '');
      a.download = `${baseName}_clean.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // WYSIWYG canvas-based export - screenshots what the viewer shows
      // This guarantees visual fidelity: what you see is what you get
      this.loadingText.set('Rendering pages for export...');

      try {
        const scale = this.getScaleFromQuality(settings.quality);
        const totalPages = this.pageNumbers().length;

        // Render all pages from the viewer's canvas (composites text overlays)
        const renderedPages: Array<{ pageNum: number; dataUrl: string }> = [];

        for (let i = 0; i < totalPages; i++) {
          const pageNum = this.pageNumbers()[i];

          // Skip deleted pages
          if (this.deletedPages().has(pageNum)) continue;

          this.loadingText.set(`Rendering page ${i + 1} of ${totalPages}...`);

          // Render the page with text overlays composited onto canvas
          const dataUrl = await this.pdfViewer?.renderPageForExport(pageNum, scale);
          if (dataUrl) {
            renderedPages.push({ pageNum, dataUrl });
          }
        }

        this.loadingText.set('Assembling PDF...');

        // Get page dimensions for the PDF
        const pageDims = this.pageDimensions();

        // Call the new canvas-based export
        const result = await this.exportService.exportPdfFromCanvas(
          renderedPages,
          pageDims,
          this.pdfName(),
          this.chapters()
        );

        if (!result.success) {
          this.showAlert({
            title: 'Export Failed',
            message: result.message,
            type: 'error'
          });
        }
        // Success case: file downloads automatically, no modal needed
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.showAlert({
          title: 'Export Failed',
          message: `Failed to export PDF: ${message}`,
          type: 'error'
        });
      }
    }
  }

  /**
   * Convert quality setting to scale factor
   */
  private getScaleFromQuality(quality: 'low' | 'medium' | 'high' | 'maximum'): number {
    switch (quality) {
      case 'low': return 1.0;
      case 'medium': return 1.5;
      case 'high': return 2.0;
      case 'maximum': return 3.0;
      default: return 2.0;
    }
  }

  // Find and select blocks containing footnote reference numbers
  findFootnoteRefs(): void {
    const deleted = this.deletedBlockIds();

    // Patterns to match:
    // 1. Unicode superscript numbers: ⁰¹²³⁴⁵⁶⁷⁸⁹
    // 2. Bracketed references: [1], [12], (1), (12)
    // 3. Inline numbers at end of words that look like refs
    const superscriptPattern = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/;
    const bracketedPattern = /[\[\(]\d{1,3}[\]\)]/;
    const inlineRefPattern = /\w\d{1,3}(?=[\s\.,;:!?\)]|$)/;

    const matchingBlocks = this.blocks().filter(block => {
      // Skip already deleted
      if (deleted.has(block.id)) return false;

      // Skip image blocks
      if (block.is_image) return false;

      // Check for any of the patterns
      const text = block.text;
      return superscriptPattern.test(text) ||
             bracketedPattern.test(text) ||
             inlineRefPattern.test(text);
    });

    if (matchingBlocks.length === 0) {
      this.showAlert({
        title: 'No References Found',
        message: 'No footnote references found in the text.',
        type: 'info'
      });
      return;
    }

    // Select all matching blocks
    const blockIds = matchingBlocks.map(b => b.id);
    this.selectedBlockIds.set(blockIds);

    // Show summary
    this.showAlert({
      title: 'Footnote References Found',
      message: `Found ${matchingBlocks.length} blocks containing footnote references.\n\nThey are now selected. Press Delete to remove them, or click elsewhere to deselect.\n\nNote: When you export, the footnote numbers within text will also be stripped automatically.`,
      type: 'success'
    });
  }

  private saveRecentFile(path: string, name: string): void {
    const key = 'bookforge-library-books';
    try {
      const recent = JSON.parse(localStorage.getItem(key) || '[]');
      const filtered = recent.filter((f: any) => f.path !== path);
      filtered.unshift({ path, name, timestamp: Date.now() });
      localStorage.setItem(key, JSON.stringify(filtered.slice(0, 50))); // Increased limit for library
    } catch {
      // Ignore localStorage errors
    }
  }

  // Auto-save timer
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly AUTO_SAVE_DELAY = 1000; // 1 second debounce

  // Auto-create project when PDF is opened
  private async autoCreateProject(pdfPath: string, pdfName: string): Promise<void> {
    const projectName = pdfName.replace(/\.[^.]+$/, '');
    const currentFileHash = this.fileHash();
    const currentLibraryPath = this.libraryPath();

    // Check if project already exists for this PDF (match by hash, then by path)
    const existingProjects = await this.electronService.projectsList();
    if (existingProjects.success && existingProjects.projects) {
      // First try to match by file hash (most reliable)
      let existing = currentFileHash
        ? existingProjects.projects.find(
            (p) => p.fileHash && p.fileHash === currentFileHash
          )
        : null;

      // Fall back to matching by library path or source path
      if (!existing) {
        existing = existingProjects.projects.find(
          (p) =>
            (p.libraryPath && p.libraryPath === currentLibraryPath) ||
            p.sourcePath === pdfPath ||
            p.sourcePath === currentLibraryPath
        );
      }

      if (existing) {
        // Load existing project data (including chapters, deleted blocks, etc.)
        await this.restoreProjectState(existing.path);
        return;
      }
    }

    // Create new project
    const projectData: BookForgeProject = {
      version: 1,
      source_path: pdfPath,
      source_name: pdfName,
      library_path: this.libraryPath(),
      file_hash: this.fileHash(),
      deleted_block_ids: [],
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.projectsSave(projectData, projectName);
    if (result.success && result.filePath) {
      this.projectPath.set(result.filePath);
    }
  }

  /**
   * Restore project state from a saved project file.
   * Called when an existing project is found for the currently loaded PDF/EPUB.
   * Does NOT reload the document - only restores the project data (chapters, deletions, etc.)
   */
  private async restoreProjectState(projectFilePath: string): Promise<void> {
    const result = await this.electronService.projectsLoadFromPath(projectFilePath);
    if (!result.success || !result.data) {
      console.warn('[restoreProjectState] Failed to load project:', projectFilePath);
      this.projectPath.set(projectFilePath); // Still set path for future saves
      return;
    }

    const project = result.data as BookForgeProject;
    this.projectPath.set(projectFilePath);

    // Restore deleted block IDs
    if (project.deleted_block_ids && project.deleted_block_ids.length > 0) {
      this.editorState.deletedBlockIds.set(new Set(project.deleted_block_ids));
    }

    // Restore page order
    if (project.page_order && project.page_order.length > 0) {
      this.editorState.pageOrder.set(project.page_order);
    }

    // Restore undo/redo history
    if (project.undo_stack || project.redo_stack) {
      this.editorState.setHistory({
        undoStack: project.undo_stack || [],
        redoStack: project.redo_stack || []
      });
    }

    // Restore custom categories
    if (project.custom_categories && project.custom_categories.length > 0) {
      this.restoreCustomCategories(project.custom_categories);
    }

    // Restore deleted highlight IDs
    if (project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
      this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
    }

    // Restore chapters
    if (project.chapters && project.chapters.length > 0) {
      this.chapters.set(project.chapters);
      this.chaptersSource.set(project.chapters_source || 'manual');
    }

    // Restore deleted pages
    if (project.deleted_pages && project.deleted_pages.length > 0) {
      this.deletedPages.set(new Set(project.deleted_pages));
    }

    // Restore metadata
    if (project.metadata) {
      this.metadata.set(project.metadata);
    }

    console.log('[restoreProjectState] Restored project from:', projectFilePath,
      'chapters:', project.chapters?.length || 0);
  }

  // Schedule auto-save (debounced)
  private scheduleAutoSave(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    this.autoSaveTimeout = setTimeout(() => {
      this.performAutoSave();
    }, this.AUTO_SAVE_DELAY);
  }

  // Perform the actual auto-save
  private async performAutoSave(): Promise<void> {
    if (!this.pdfLoaded()) return;

    const projectPath = this.projectPath();
    if (projectPath) {
      // Save to existing project
      await this.saveProjectToPath(projectPath, true); // silent = true
    } else {
      // Auto-create new project on first change
      const order = this.pageOrder();
      const history = this.editorState.getHistory();
      const customCategories = this.getCustomCategoriesData();
      const ocrBlocks = this.blocks().filter(b => b.is_ocr);
      const chapters = this.chapters();
      const chaptersSource = this.chaptersSource();
      const projectData: BookForgeProject = {
        version: 1,
        source_path: this.pdfPath(),
        source_name: this.pdfName(),
        library_path: this.libraryPath(),
        file_hash: this.fileHash(),
        deleted_block_ids: [...this.deletedBlockIds()],
        deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : undefined,
        page_order: order.length > 0 ? order : undefined,
        custom_categories: customCategories.length > 0 ? customCategories : undefined,
        undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
        redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
        ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
        chapters: chapters.length > 0 ? chapters : undefined,
        chapters_source: chapters.length > 0 ? chaptersSource : undefined,
        deleted_pages: this.deletedPages().size > 0 ? [...this.deletedPages()] : undefined,
        metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString()
      };

      const projectName = this.pdfName().replace(/\.[^.]+$/, '');
      const result = await this.electronService.projectsSave(projectData, projectName);

      if (result.success && result.filePath) {
        this.projectPath.set(result.filePath);
        this.hasUnsavedChanges.set(false);
      }
    }
  }

  // Project save/load methods (kept for export functionality)
  async saveProject(): Promise<void> {
    if (!this.pdfLoaded()) return;

    const projectPath = this.projectPath();
    if (projectPath) {
      // Save to existing path
      await this.saveProjectToPath(projectPath);
    } else {
      // No project path yet - auto-save to ~/Documents/BookForge/
      const order = this.pageOrder();
      const history = this.editorState.getHistory();
      const customCategories = this.getCustomCategoriesData();
      const ocrBlocks = this.blocks().filter(b => b.is_ocr);
      const chapters = this.chapters();
      const chaptersSource = this.chaptersSource();
      const projectData: BookForgeProject = {
        version: 1,
        source_path: this.pdfPath(),
        source_name: this.pdfName(),
        library_path: this.libraryPath(),
        file_hash: this.fileHash(),
        deleted_block_ids: [...this.deletedBlockIds()],
        deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : undefined,
        page_order: order.length > 0 ? order : undefined,
        custom_categories: customCategories.length > 0 ? customCategories : undefined,
        undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
        redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
        ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
        chapters: chapters.length > 0 ? chapters : undefined,
        chapters_source: chapters.length > 0 ? chaptersSource : undefined,
        deleted_pages: this.deletedPages().size > 0 ? [...this.deletedPages()] : undefined,
        metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString()
      };

      const projectName = this.pdfName().replace(/\.[^.]+$/, '');
      const result = await this.electronService.projectsSave(projectData, projectName);

      if (result.success && result.filePath) {
        this.projectPath.set(result.filePath);
        this.hasUnsavedChanges.set(false);
      } else if (result.error) {
        this.showAlert({
          title: 'Save Failed',
          message: 'Failed to save project: ' + result.error,
          type: 'error'
        });
      }
    }
  }

  async saveProjectAs(): Promise<void> {
    if (!this.pdfLoaded()) return;

    const order = this.pageOrder();
    const history = this.editorState.getHistory();
    const customCategories = this.getCustomCategoriesData();
    const ocrBlocks = this.blocks().filter(b => b.is_ocr);
    const chapters = this.chapters();
    const chaptersSource = this.chaptersSource();
    const projectData: BookForgeProject = {
      version: 1,
      source_path: this.pdfPath(),
      source_name: this.pdfName(),
      library_path: this.libraryPath(),
      file_hash: this.fileHash(),
      deleted_block_ids: [...this.deletedBlockIds()],
      deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : undefined,
      page_order: order.length > 0 ? order : undefined,
      custom_categories: customCategories.length > 0 ? customCategories : undefined,
      undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
      redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
      ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
      chapters: chapters.length > 0 ? chapters : undefined,
      chapters_source: chapters.length > 0 ? chaptersSource : undefined,
      deleted_pages: this.deletedPages().size > 0 ? [...this.deletedPages()] : undefined,
      metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
      created_at: this.projectPath() ? new Date().toISOString() : new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const suggestedName = this.pdfName().replace(/\.[^.]+$/, '') + '.bfp';
    const result = await this.electronService.saveProject(projectData, suggestedName);

    if (result.success && result.filePath) {
      this.projectPath.set(result.filePath);
      this.hasUnsavedChanges.set(false);
    } else if (result.error) {
      this.showAlert({
        title: 'Save Failed',
        message: 'Failed to save project: ' + result.error,
        type: 'error'
      });
    }
  }

  // Serialize custom categories for project save
  private getCustomCategoriesData(): CustomCategoryData[] {
    const categories = this.categories();
    const highlights = this.categoryHighlights();
    const customCategories: CustomCategoryData[] = [];

    // Find categories that are custom (start with 'custom_')
    for (const [catId, cat] of Object.entries(categories)) {
      if (catId.startsWith('custom_')) {
        const catHighlights = highlights.get(catId);
        if (catHighlights) {
          customCategories.push({
            category: {
              id: cat.id,
              name: cat.name,
              description: cat.description,
              color: cat.color,
              block_count: cat.block_count,
              char_count: cat.char_count,
              font_size: cat.font_size,
              region: cat.region,
              sample_text: cat.sample_text
            },
            highlights: catHighlights
          });
        }
      }
    }

    return customCategories;
  }

  private restoreCustomCategories(customCategories: CustomCategoryData[]): void {

    for (const data of customCategories) {
      // Restore the category to editorState.categories
      const category: Category = {
        id: data.category.id,
        name: data.category.name,
        description: data.category.description,
        color: data.category.color,
        block_count: data.category.block_count,
        char_count: data.category.char_count,
        font_size: data.category.font_size,
        region: data.category.region,
        sample_text: data.category.sample_text,
        enabled: true  // Custom categories restored as enabled
      };

      this.categories.update(cats => ({
        ...cats,
        [category.id]: category
      }));

      // Restore the highlights
      this.categoryHighlights.update(highlights => {
        const updated = new Map(highlights);
        updated.set(category.id, data.highlights);
        return updated;
      });

    }
  }

  private async saveProjectToPath(filePath: string, silent: boolean = false): Promise<void> {
    const order = this.pageOrder();
    const history = this.editorState.getHistory();
    const customCategories = this.getCustomCategoriesData();
    const blockEdits = this.editorState.blockEdits();

    // Convert Map to Record for JSON serialization
    const blockEditsRecord: Record<string, BlockEditData> | undefined =
      blockEdits.size > 0 ? Object.fromEntries(blockEdits) : undefined;

    // Get OCR blocks to persist (these are generated by OCR and independent from PDF analysis)
    const ocrBlocks = this.blocks().filter(b => b.is_ocr);

    // If we have OCR blocks, also save the current categories (they match OCR categorization)
    const categoriesToSave = ocrBlocks.length > 0 ? this.categories() : undefined;

    // Get chapters to persist
    const chapters = this.chapters();
    const chaptersSource = this.chaptersSource();

    const projectData: BookForgeProject = {
      version: 1,
      source_path: this.pdfPath(),
      source_name: this.pdfName(),
      library_path: this.libraryPath(),
      file_hash: this.fileHash(),
      deleted_block_ids: [...this.deletedBlockIds()],
      deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : undefined,
      page_order: order.length > 0 ? order : undefined,
      custom_categories: customCategories.length > 0 ? customCategories : undefined,
      block_edits: blockEditsRecord,
      undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
      redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
      remove_backgrounds: this.removeBackgrounds() || undefined,
      ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
      ocr_categories: categoriesToSave,
      chapters: chapters.length > 0 ? chapters : undefined,
      chapters_source: chapters.length > 0 ? chaptersSource : undefined,
      deleted_pages: this.deletedPages().size > 0 ? [...this.deletedPages()] : undefined,
      metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const result = await this.electronService.saveProjectToPath(filePath, projectData);

    if (result.success) {
      this.hasUnsavedChanges.set(false);
    } else if (result.error && !silent) {
      this.showAlert({
        title: 'Save Failed',
        message: 'Failed to save project: ' + result.error,
        type: 'error'
      });
    }
  }

  async openProject(): Promise<void> {
    const result = await this.electronService.loadProject();

    if (result.canceled) return;

    if (!result.success || !result.data) {
      if (result.error) {
        this.showAlert({
          title: 'Open Failed',
          message: 'Failed to open project: ' + result.error,
          type: 'error'
        });
      }
      return;
    }

    const project = result.data as BookForgeProject;

    // Validate project data
    if (!project.version || !project.source_path) {
      this.showAlert({
        title: 'Invalid Project',
        message: 'This file does not appear to be a valid BookForge project.',
        type: 'error'
      });
      return;
    }

    // Load the source PDF - prefer library_path, fall back to source_path
    this.loading.set(true);
    this.loadingText.set('Loading project...');

    // If project is missing library_path or file_hash, import the source file to library
    let libraryPath = project.library_path;
    let fileHash = project.file_hash || '';

    if (!libraryPath || !fileHash) {
      this.loadingText.set('Importing to library...');
      const importResult = await this.electronService.libraryImportFile(project.source_path);
      if (importResult.success && importResult.libraryPath) {
        libraryPath = importResult.libraryPath;
        fileHash = importResult.hash || '';
      } else {
        // Fall back to source path if import fails
        libraryPath = project.source_path;
        console.warn('[loadProject] Library import failed, using source path:', project.source_path);
      }
    }

    const pdfPathToLoad = libraryPath;

    try {
      const pdfResult = await this.pdfService.analyzePdf(pdfPathToLoad);

      // Convert block edits Record to Map if present, fall back to text_corrections for legacy
      let blockEditsMap: Map<string, BlockEdit> | undefined;
      if (project.block_edits) {
        blockEditsMap = new Map(Object.entries(project.block_edits));
      } else if (project.text_corrections) {
        // Legacy: convert text_corrections to blockEdits
        blockEditsMap = new Map();
        Object.entries(project.text_corrections).forEach(([blockId, text]) => {
          blockEditsMap!.set(blockId, { text });
        });
      }

      // Load document state via service
      this.editorState.loadDocument({
        blocks: pdfResult.blocks,
        categories: pdfResult.categories,
        pageDimensions: pdfResult.page_dimensions,
        totalPages: pdfResult.page_count,
        pdfName: pdfResult.pdf_name,
        pdfPath: project.source_path,
        libraryPath: libraryPath,
        fileHash: fileHash,
        deletedBlockIds: new Set(project.deleted_block_ids || []),
        pageOrder: project.page_order || [],
        blockEdits: blockEditsMap
      });

      // Restore undo/redo history from project (loadDocument clears it)
      if (project.undo_stack || project.redo_stack) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      // Restore custom categories
      if (project.custom_categories && project.custom_categories.length > 0) {
        this.restoreCustomCategories(project.custom_categories);
      }

      // Restore deleted highlight IDs
      if (project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
        this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
      }

      // Restore chapters
      if (project.chapters && project.chapters.length > 0) {
        this.chapters.set(project.chapters);
        this.chaptersSource.set(project.chapters_source || 'manual');
      }

      // Restore deleted pages
      if (project.deleted_pages && project.deleted_pages.length > 0) {
        this.deletedPages.set(new Set(project.deleted_pages));
      }

      // Restore metadata
      if (project.metadata) {
        this.metadata.set(project.metadata);
      }

      this.pageRenderService.clear();
      this.projectService.projectPath.set(result.filePath || null);

      // Initialize page rendering - starts in background, doesn't block
      this.pageRenderService.initialize(this.effectivePath(), pdfResult.page_count);

      // Start page rendering in background (non-blocking)
      this.pageRenderService.loadAllPageImages(pdfResult.page_count);
    } catch (err) {
      console.error('Failed to load project source file:', err);
      this.showAlert({
        title: 'Source File Not Found',
        message: 'Could not find the source PDF file at:\n\n' + pdfPathToLoad + '\n\nThe file may have been moved or deleted.',
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  async loadProjectFromPath(filePath: string, lightweight: boolean = false): Promise<void> {
    // Check if this project is already open
    const existingDoc = this.openDocuments().find(d => d.projectPath === filePath);
    if (existingDoc) {
      // Switch to existing tab
      this.saveCurrentDocumentState();
      this.restoreDocumentState(existingDoc.id);
      return;
    }

    const result = await this.electronService.projectsLoadFromPath(filePath);

    if (!result.success || !result.data) {
      if (result.error) {
        this.showAlert({
          title: 'Open Failed',
          message: 'Failed to open project: ' + result.error,
          type: 'error'
        });
      }
      return;
    }

    const project = result.data as BookForgeProject;
    // Use the returned filePath - may be different if project was imported to library
    const actualProjectPath = result.filePath || filePath;

    // Validate project data
    if (!project.version || !project.source_path) {
      this.showAlert({
        title: 'Invalid Project',
        message: 'This file does not appear to be a valid BookForge project.',
        type: 'error'
      });
      return;
    }

    // EPUBs are now handled by the PDF picker via mupdf (renders them as pages)
    // No special routing needed - both PDFs and EPUBs load the same way

    // Save current document state before loading new one
    this.saveCurrentDocumentState();

    // Load the source PDF - prefer library_path, fall back to source_path
    this.loading.set(true);
    this.loadingText.set('Loading project...');

    // If project is missing library_path or file_hash, import the source file to library
    let libraryPath = project.library_path;
    let fileHash = project.file_hash || '';

    if (!libraryPath || !fileHash) {
      this.loadingText.set('Importing to library...');
      const importResult = await this.electronService.libraryImportFile(project.source_path);
      if (importResult.success && importResult.libraryPath) {
        libraryPath = importResult.libraryPath;
        fileHash = importResult.hash || '';
      } else {
        // Fall back to source path if import fails
        libraryPath = project.source_path;
        console.warn('[loadProjectFromPath] Library import failed, using source path:', project.source_path);
      }
    }

    const pdfPathToLoad = libraryPath;

    try {
      const pdfResult = await this.pdfService.analyzePdf(pdfPathToLoad);

      // Create new document for tabs
      const docId = this.generateDocumentId();
      const deletedBlockIds = new Set<string>(project.deleted_block_ids || []);
      const pageOrder = project.page_order || [];

      const newDoc: OpenDocument = {
        id: docId,
        path: project.source_path,
        libraryPath: libraryPath,
        fileHash: fileHash,
        name: project.source_name || pdfResult.pdf_name,
        blocks: pdfResult.blocks,
        categories: pdfResult.categories,
        pageDimensions: pdfResult.page_dimensions,
        totalPages: pdfResult.page_count,
        deletedBlockIds: deletedBlockIds,
        deletedPages: new Set(project.deleted_pages || []),
        selectedBlockIds: [],
        pageOrder: pageOrder,
        pageImages: new Map(),
        hasUnsavedChanges: false,
        projectPath: actualProjectPath,
        undoStack: project.undo_stack || [],
        redoStack: project.redo_stack || [],
        lightweightMode: lightweight
      };

      // Add to open documents
      this.openDocuments.update(docs => [...docs, newDoc]);
      this.activeDocumentId.set(docId);

      // Convert block edits Record to Map if present, fall back to text_corrections for legacy
      let blockEditsMap: Map<string, BlockEdit> | undefined;
      if (project.block_edits) {
        blockEditsMap = new Map(Object.entries(project.block_edits));
      } else if (project.text_corrections) {
        // Legacy: convert text_corrections to blockEdits
        blockEditsMap = new Map();
        Object.entries(project.text_corrections).forEach(([blockId, text]) => {
          blockEditsMap!.set(blockId, { text });
        });
      }

      // Load document state via service
      this.editorState.loadDocument({
        blocks: pdfResult.blocks,
        categories: pdfResult.categories,
        pageDimensions: pdfResult.page_dimensions,
        totalPages: pdfResult.page_count,
        pdfName: project.source_name || pdfResult.pdf_name,
        pdfPath: project.source_path,
        libraryPath: libraryPath,
        fileHash: fileHash,
        deletedBlockIds: deletedBlockIds,
        pageOrder: pageOrder,
        blockEdits: blockEditsMap
      });

      // Restore undo/redo history from project (loadDocument clears it)
      if (project.undo_stack || project.redo_stack) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      // Restore custom categories
      if (project.custom_categories && project.custom_categories.length > 0) {
        this.restoreCustomCategories(project.custom_categories);
      }

      // Restore deleted highlight IDs
      if (project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
        this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
      }

      // Restore chapters
      if (project.chapters && project.chapters.length > 0) {
        this.chapters.set(project.chapters);
        this.chaptersSource.set(project.chapters_source || 'manual');
      }

      // Restore deleted pages
      if (project.deleted_pages && project.deleted_pages.length > 0) {
        this.deletedPages.set(new Set(project.deleted_pages));
      }

      // Restore metadata
      if (project.metadata) {
        this.metadata.set(project.metadata);
      }

      // Restore OCR blocks and categories - these replace PDF-analyzed blocks on their pages
      if (project.ocr_blocks && project.ocr_blocks.length > 0) {
        // Get the pages that have OCR blocks
        const ocrPages = [...new Set(project.ocr_blocks.map(b => b.page))];
        // Replace PDF blocks with OCR blocks on those pages
        this.editorState.replaceTextBlocksOnPages(ocrPages, project.ocr_blocks);

        // Update spans for OCR pages so custom category matching searches OCR text
        for (const pageNum of ocrPages) {
          const pageBlocks = project.ocr_blocks.filter(b => b.page === pageNum);
          const ocrBlocksForSpans = pageBlocks.map(b => ({
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            text: b.text,
            font_size: b.font_size,
            id: b.id
          }));
          this.electronService.updateSpansForOcr(pageNum, ocrBlocksForSpans);
        }

        // Restore OCR categories if saved (these match the OCR block categorization)
        if (project.ocr_categories) {
          this.editorState.categories.set(project.ocr_categories);
        }
      }

      // Restore remove backgrounds state
      if (project.remove_backgrounds) {
        this.editorState.removeBackgrounds.set(true);
      }

      this.pageRenderService.clear();
      this.projectService.projectPath.set(actualProjectPath);

      // Set lightweight mode
      this.lightweightMode.set(lightweight);

      // Always initialize page rendering (so OCR can work)
      // But only load pages if NOT in lightweight mode
      this.pageRenderService.initialize(this.effectivePath(), pdfResult.page_count);

      // Show document immediately
      this.pdfLoaded.set(true);

      // Start page rendering in background (skip if lightweight mode)
      if (!lightweight) {
        // If background removal is enabled, apply it after pages load
        if (project.remove_backgrounds) {
          this.pageRenderService.loadAllPageImages(pdfResult.page_count).then(() => {
            this.applyRemoveBackgrounds(true);
          });
        } else {
          this.pageRenderService.loadAllPageImages(pdfResult.page_count);
        }
      }
    } catch (err) {
      console.error('Failed to load project source file:', err);
      this.showAlert({
        title: 'Source File Not Found',
        message: 'Could not find the source PDF file at:\n\n' + pdfPathToLoad + '\n\nThe file may have been moved or deleted.',
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  // Sample mode methods (for creating custom categories by drawing boxes)
  enterSampleMode(): void {
    this.sampleMode.set(true);
    this.sampleRects.set([]);
    this.sampleCategoryName.set('');
    this.sampleCategoryColor.set('#E91E63');
    this.sampleCurrentRect = null;
  }

  exitSampleMode(): void {
    this.sampleMode.set(false);
    this.sampleRects.set([]);
    this.sampleCurrentRect = null;
    this.sampleDrawingRect.set(null);
  }

  onSampleMouseDown(event: MouseEvent, page: number, pageX: number, pageY: number): void {
    if (!this.sampleMode()) return;

    this.sampleCurrentRect = {
      page,
      startX: pageX,
      startY: pageY,
      currentX: pageX,
      currentY: pageY
    };
    // Initialize the drawing rect signal
    this.sampleDrawingRect.set({
      page,
      x: pageX,
      y: pageY,
      width: 0,
      height: 0
    });
  }

  onSampleMouseMove(pageX: number, pageY: number): void {
    if (!this.sampleCurrentRect) return;

    this.sampleCurrentRect.currentX = pageX;
    this.sampleCurrentRect.currentY = pageY;

    // Update the drawing rect signal for visualization
    const rect = this.sampleCurrentRect;
    const x = Math.min(rect.startX, rect.currentX);
    const y = Math.min(rect.startY, rect.currentY);
    const width = Math.abs(rect.currentX - rect.startX);
    const height = Math.abs(rect.currentY - rect.startY);
    this.sampleDrawingRect.set({ page: rect.page, x, y, width, height });
  }

  onSampleMouseUp(): void {
    if (!this.sampleCurrentRect) return;

    const rect = this.sampleCurrentRect;
    const x = Math.min(rect.startX, rect.currentX);
    const y = Math.min(rect.startY, rect.currentY);
    const width = Math.abs(rect.currentX - rect.startX);
    const height = Math.abs(rect.currentY - rect.startY);

    // Only add if rectangle has meaningful size
    if (width > 5 && height > 5) {
      this.sampleRects.update(rects => [...rects, {
        page: rect.page,
        x,
        y,
        width,
        height
      }]);
    }

    this.sampleCurrentRect = null;
    this.sampleDrawingRect.set(null);
  }

  removeSampleRect(index: number): void {
    this.sampleRects.update(rects => rects.filter((_, i) => i !== index));
  }

  async analyzeSamplesAndCreateCategory(): Promise<void> {
    const rects = this.sampleRects();
    if (rects.length === 0) {
      this.showAlert({
        title: 'No Samples',
        message: 'Draw boxes around at least one example to create a category.',
        type: 'warning'
      });
      return;
    }

    // Find spans within each rectangle
    const allSpans: any[] = [];
    for (const rect of rects) {
      const result = await this.electronService.findSpansInRect(rect.page, rect.x, rect.y, rect.width, rect.height);
      if (result?.data) {
        allSpans.push(...result.data);
      }
    }

    if (allSpans.length === 0) {
      this.showAlert({
        title: 'No Text Found',
        message: 'No text was found within the selected areas. Try drawing larger boxes around the text.',
        type: 'warning'
      });
      return;
    }

    // Analyze samples to find pattern
    const patternResult = await this.electronService.analyzeSamples(allSpans);
    if (!patternResult?.data) {
      this.showAlert({
        title: 'Analysis Failed',
        message: 'Could not analyze the selected samples.',
        type: 'error'
      });
      return;
    }

    // Find all matching spans - returns lightweight MatchRect objects grouped by page
    const matchesResult = await this.electronService.findMatchingSpans(patternResult.data);
    if (!matchesResult?.data) {
      this.showAlert({
        title: 'Match Failed',
        message: 'Could not find matching patterns.',
        type: 'error'
      });
      return;
    }

    const { matches, matchesByPage, total, pattern } = matchesResult.data;

    if (total === 0) {
      this.showAlert({
        title: 'No Matches',
        message: 'No additional matches found for the selected pattern.',
        type: 'info'
      });
      return;
    }

    // Generate category ID and name
    const categoryName = this.sampleCategoryName() || `Custom (${total} matches)`;
    const categoryColor = this.sampleCategoryColor();
    const categoryId = this.generateCategoryId(categoryName);

    // Calculate total characters from matches
    const totalChars = matches.reduce((sum: number, m: MatchRect) => sum + m.text.length, 0);

    // Create the category
    const newCategory: Category = {
      id: categoryId,
      name: categoryName,
      description: `Pattern: ${pattern} (${total} matches)`,
      color: categoryColor,
      block_count: total,
      char_count: totalChars,
      font_size: patternResult.data.font_size_avg,
      region: 'body',
      sample_text: matches[0]?.text || '',
      enabled: true
    };

    // Update categories
    this.categories.update(cats => ({
      ...cats,
      [categoryId]: newCategory
    }));

    // Store lightweight highlights by page for efficient rendering
    // This avoids creating heavy TextBlock objects (saves ~160 bytes per match)
    this.categoryHighlights.update(highlights => {
      const updated = new Map(highlights);
      updated.set(categoryId, matchesByPage);
      return updated;
    });

    // Log stats for debugging
    const pageCount = Object.keys(matchesByPage).length;

    this.hasUnsavedChanges.set(true);
    this.exitSampleMode();

    // Collapse the create category accordion
    this.categoriesPanel?.collapseCreateSection();

    this.showAlert({
      title: 'Category Created',
      message: `Created "${categoryName}" with ${total} matched items across ${pageCount} pages.`,
      type: 'success'
    });
  }

  private generateCategoryId(name: string): string {
    return 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20) + '_' + Date.now().toString(36);
  }

  // Regex category panel methods
  onRegexExpandedChange(expanded: boolean): void {
    this.regexPanelExpanded.set(expanded);
    if (expanded && !this.editingCategoryId()) {
      // Reset form when opening (but not if editing existing category)
      this.regexPattern.set('');
      this.regexCategoryName.set('');
      this.regexCategoryColor.set('#FF5722');
      this.regexMinFontSize.set(0);
      this.regexMaxFontSize.set(0);
      this.regexMinBaseline.set(null);
      this.regexMaxBaseline.set(null);
      this.regexCaseSensitive.set(false);
      this.regexLiteralMode.set(false);
      // Initialize with all categories selected
      this.regexCategoryFilter.set(Object.keys(this.categories()));
      this.regexPageFilterType.set('all');
      this.regexPageRangeStart.set(1);
      this.regexPageRangeEnd.set(1);
      this.regexSpecificPages.set('');
      this.regexMatches.set([]);
      this.regexMatchCount.set(0);
    } else if (!expanded) {
      // Clear editing state when closing
      this.editingCategoryId.set(null);
    }
  }

  openRegexModal(): void {
    this.editingCategoryId.set(null);  // Clear editing state
    this.regexPattern.set('');
    this.regexCategoryName.set('');
    this.regexCategoryColor.set('#FF5722');
    this.regexMinFontSize.set(0);
    this.regexMaxFontSize.set(0);  // 0 means "no max filter" (empty field)
    this.regexMinBaseline.set(null);
    this.regexMaxBaseline.set(null);
    this.regexCaseSensitive.set(false);
    this.regexLiteralMode.set(false);
    // Initialize with all categories selected
    this.regexCategoryFilter.set(Object.keys(this.categories()));
    this.regexPageFilterType.set('all');
    this.regexPageRangeStart.set(1);
    this.regexPageRangeEnd.set(1);
    this.regexSpecificPages.set('');
    this.regexNearLineEnd.set(false);
    this.regexLineEndChars.set(3);
    this.regexMatches.set([]);
    this.regexPanelExpanded.set(true);
  }

  onRegexPatternChange(pattern: string): void {
    this.regexPattern.set(pattern);
    this.updateRegexMatches();
  }

  onMinFontSizeChange(size: number): void {
    // Allow empty/0 - don't auto-reset
    this.regexMinFontSize.set(isNaN(size) ? 0 : size);
    this.updateRegexMatches();
  }

  onMaxFontSizeChange(size: number): void {
    // Store the actual value - don't auto-reset to 999
    // Empty input gives 0, which we'll treat as "no max filter" in the search
    this.regexMaxFontSize.set(isNaN(size) ? 0 : size);
    this.updateRegexMatches();
  }

  onMinBaselineChange(value: string): void {
    // Empty string means no filter (null)
    const num = parseFloat(value);
    this.regexMinBaseline.set(isNaN(num) ? null : num);
    this.updateRegexMatches();
  }

  onMaxBaselineChange(value: string): void {
    // Empty string means no filter (null)
    const num = parseFloat(value);
    this.regexMaxBaseline.set(isNaN(num) ? null : num);
    this.updateRegexMatches();
  }

  onNearLineEndChange(checked: boolean): void {
    this.regexNearLineEnd.set(checked);
    this.updateRegexMatches();
  }

  onLineEndCharsChange(chars: number): void {
    this.regexLineEndChars.set(chars || 3);
    this.updateRegexMatches();
  }

  onCaseSensitiveChange(caseSensitive: boolean): void {
    this.regexCaseSensitive.set(caseSensitive);
    this.updateRegexMatches();
  }

  onLiteralModeChange(literalMode: boolean): void {
    this.regexLiteralMode.set(literalMode);
    this.updateRegexMatches();
  }

  onCategoryFilterChange(categoryIds: string[]): void {
    this.regexCategoryFilter.set(categoryIds);
    this.updateRegexMatches();
  }

  onPageFilterTypeChange(filterType: 'all' | 'range' | 'even' | 'odd' | 'specific'): void {
    this.regexPageFilterType.set(filterType);
    this.updateRegexMatches();
  }

  onPageRangeStartChange(page: number): void {
    this.regexPageRangeStart.set(page || 1);
    this.updateRegexMatches();
  }

  onPageRangeEndChange(page: number): void {
    this.regexPageRangeEnd.set(page || 1);
    this.updateRegexMatches();
  }

  onSpecificPagesChange(pages: string): void {
    this.regexSpecificPages.set(pages);
    this.updateRegexMatches();
  }

  private updateRegexMatches(): void {
    // Debounce to avoid too many backend calls while typing
    if (this.regexDebounceTimer) {
      clearTimeout(this.regexDebounceTimer);
    }

    this.regexDebounceTimer = setTimeout(() => {
      this.doUpdateRegexMatches();
    }, 300);
  }

  private async doUpdateRegexMatches(): Promise<void> {
    let pattern = this.regexPattern();
    const minSize = this.regexMinFontSize();
    // Treat 0 as "no max filter" (use 999)
    const maxSize = this.regexMaxFontSize() || 999;
    const minBaseline = this.regexMinBaseline();
    const maxBaseline = this.regexMaxBaseline();
    const caseSensitive = this.regexCaseSensitive();
    const literalMode = this.regexLiteralMode();

    // Filter settings
    const categoryFilter = this.regexCategoryFilter();
    const pageFilterType = this.regexPageFilterType();
    const pageRangeStart = this.regexPageRangeStart();
    const pageRangeEnd = this.regexPageRangeEnd();
    const specificPages = this.regexSpecificPages();

    if (!pattern) {
      this.regexMatches.set([]);
      this.regexMatchCount.set(0);
      return;
    }

    // In literal mode, escape special regex characters so users can search for anything
    if (literalMode) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      // Validate regex only in regex mode
      try {
        new RegExp(pattern);
      } catch {
        this.regexMatches.set([]);
        this.regexMatchCount.set(0);
        return;
      }
    }

    // Use span-based matching from backend
    const result = await this.electronService.findSpansByRegex(pattern, minSize, maxSize, minBaseline, maxBaseline, caseSensitive);

    if (result?.data) {
      let matches = result.data.matches;

      // Validate positions - filter out matches not within known text blocks
      // This filters out text from embedded figures/tables with incorrect coordinates
      matches = this.validateMatchPositions(matches);

      // Apply page filter (client-side)
      matches = this.applyPageFilter(matches, pageFilterType, pageRangeStart, pageRangeEnd, specificPages);

      // Apply category filter (client-side) - need to look up block categories
      // Empty filter = no categories selected = filter out everything
      matches = this.applyCategoryFilter(matches, categoryFilter);

      // Store first 10000 matches for preview (performance limit)
      this.regexMatches.set(matches.slice(0, 10000));
      this.regexMatchCount.set(matches.length);
    } else {
      this.regexMatches.set([]);
      this.regexMatchCount.set(0);
    }
  }

  // Apply page filter to matches
  private applyPageFilter(
    matches: MatchRect[],
    filterType: 'all' | 'range' | 'even' | 'odd' | 'specific',
    rangeStart: number,
    rangeEnd: number,
    specificPagesStr: string
  ): MatchRect[] {
    if (filterType === 'all') {
      return matches;
    }

    if (filterType === 'even') {
      // Even pages (0-indexed, so page 0 = page 1 = odd, page 1 = page 2 = even)
      return matches.filter(m => (m.page + 1) % 2 === 0);
    }

    if (filterType === 'odd') {
      return matches.filter(m => (m.page + 1) % 2 === 1);
    }

    if (filterType === 'range') {
      // Convert to 0-indexed
      const start = Math.max(0, rangeStart - 1);
      const end = Math.max(start, rangeEnd - 1);
      return matches.filter(m => m.page >= start && m.page <= end);
    }

    if (filterType === 'specific') {
      // Parse specific pages string like "1, 3, 10-15, 42"
      const allowedPages = this.parseSpecificPages(specificPagesStr);
      return matches.filter(m => allowedPages.has(m.page));
    }

    return matches;
  }

  // Parse "1, 3, 10-15, 42" into a Set of 0-indexed page numbers
  private parseSpecificPages(pagesStr: string): Set<number> {
    const pages = new Set<number>();
    if (!pagesStr.trim()) return pages;

    const parts = pagesStr.split(',').map(s => s.trim()).filter(s => s);
    for (const part of parts) {
      if (part.includes('-')) {
        // Range like "10-15"
        const [startStr, endStr] = part.split('-').map(s => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            pages.add(i - 1); // Convert to 0-indexed
          }
        }
      } else {
        // Single page
        const page = parseInt(part, 10);
        if (!isNaN(page)) {
          pages.add(page - 1); // Convert to 0-indexed
        }
      }
    }
    return pages;
  }

  // Apply category filter - need to look up which category each match's block belongs to
  private applyCategoryFilter(matches: MatchRect[], allowedCategories: string[]): MatchRect[] {
    // Build a map of block positions to category IDs
    // Since matches don't have block_id, we need to match by position
    // This is a simplification - we check if the match overlaps with any block of allowed categories

    const allowedSet = new Set(allowedCategories);
    const blocks = this.blocks();

    return matches.filter(match => {
      // Find any block on this page that contains this match
      for (const block of blocks) {
        if (block.page !== match.page) continue;

        // Check if match is within this block's bounds (with some tolerance)
        const inBlock = match.x >= block.x - 2 &&
                       match.y >= block.y - 2 &&
                       match.x + match.w <= block.x + block.width + 2 &&
                       match.y + match.h <= block.y + block.height + 2;

        if (inBlock && allowedSet.has(block.category_id)) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Validate match positions - filter out matches that:
   * 1. Fall within any image block bounds (text from embedded figures/tables has unreliable coordinates)
   * 2. Don't fall within any known text block
   * This filters out text from embedded figures/tables that may have incorrect coordinates.
   */
  private validateMatchPositions(matches: MatchRect[]): MatchRect[] {
    const blocks = this.blocks();
    const pageDims = this.pageDimensions();

    // Get all image blocks for position checking
    const imageBlocks = blocks.filter(b => b.is_image);

    // Track pages that have images (coordinates may be unreliable)
    const pagesWithImages = new Set(imageBlocks.map(b => b.page));

    let filteredInImage = 0;
    let filteredNoBlock = 0;
    let filteredSuspicious = 0;
    let kept = 0;

    const result = matches.filter(match => {
      const pageDim = pageDims[match.page];

      // First, check if match falls within ANY image block
      // Text inside images/figures/tables often has unreliable coordinates
      for (const imgBlock of imageBlocks) {
        if (imgBlock.page !== match.page) continue;

        const inImage = match.x >= imgBlock.x - 10 &&
                       match.y >= imgBlock.y - 10 &&
                       match.x + match.w <= imgBlock.x + imgBlock.width + 10 &&
                       match.y + match.h <= imgBlock.y + imgBlock.height + 10;

        if (inImage) {
          // Match is inside an image area - skip it
          filteredInImage++;
          return false;
        }
      }

      // On pages with images, apply stricter coordinate validation
      // Reject matches with coordinates outside reasonable page bounds
      if (pagesWithImages.has(match.page) && pageDim) {
        const maxX = pageDim.width * 0.95;
        const maxY = pageDim.height * 0.98;
        if (match.x < 0 || match.y < 0 || match.x > maxX || match.y > maxY) {
          filteredSuspicious++;
          console.log(`[validateMatchPositions] Suspicious coords on page ${match.page} (has images): "${match.text}" at (${match.x.toFixed(1)}, ${match.y.toFixed(1)}), page size: ${pageDim.width}x${pageDim.height}`);
          return false;
        }
      }

      // Find any text block on this page that contains this match
      for (const block of blocks) {
        if (block.page !== match.page) continue;
        if (block.is_image) continue; // Skip image blocks

        // Check if match is within this block's bounds (with some tolerance)
        const tolerance = 5;
        const inBlock = match.x >= block.x - tolerance &&
                       match.y >= block.y - tolerance &&
                       match.x + match.w <= block.x + block.width + tolerance &&
                       match.y + match.h <= block.y + block.height + tolerance;

        if (inBlock) {
          kept++;
          return true;
        }
      }
      filteredNoBlock++;
      console.log(`[validateMatchPositions] Filtered match on page ${match.page}: "${match.text}" at (${match.x.toFixed(1)}, ${match.y.toFixed(1)}) - not in any text block`);
      return false;
    });

    console.log(`[validateMatchPositions] Results: ${kept} kept, ${filteredInImage} filtered (in image), ${filteredSuspicious} filtered (suspicious coords), ${filteredNoBlock} filtered (no block)`);
    return result;
  }

  async createRegexCategory(): Promise<void> {
    const pattern = this.regexPattern();
    const name = this.regexCategoryName();
    const color = this.regexCategoryColor();
    const minSize = this.regexMinFontSize();
    // Treat 0 as "no max filter" (use 999)
    const maxSize = this.regexMaxFontSize() || 999;
    const minBaseline = this.regexMinBaseline();
    const maxBaseline = this.regexMaxBaseline();
    const editingId = this.editingCategoryId();

    // If editing and no new pattern, just update name/color
    if (editingId && !pattern) {
      if (!name) return;

      this.categories.update(cats => {
        const existingCat = cats[editingId];
        if (!existingCat) return cats;
        return {
          ...cats,
          [editingId]: {
            ...existingCat,
            name: name,
            color: color
          }
        };
      });

      this.hasUnsavedChanges.set(true);
      this.regexPanelExpanded.set(false);
      this.editingCategoryId.set(null);
      return;
    }

    if (!pattern || !name) return;

    // Find spans matching the regex pattern (span-level, not block-level)
    const matchesResult = await this.electronService.findSpansByRegex(pattern, minSize, maxSize, minBaseline, maxBaseline);
    if (!matchesResult?.data || matchesResult.data.total === 0) {
      this.showAlert({
        title: 'No Matches',
        message: 'No spans match the regex pattern with the specified font size filters.',
        type: 'info'
      });
      return;
    }

    const { matches, matchesByPage, total } = matchesResult.data;

    // Filter matches to only include those within known text blocks
    // This filters out text from embedded figures/tables with incorrect coordinates
    const validatedMatches = this.validateMatchPositions(matches);
    const validatedByPage: Record<number, MatchRect[]> = {};
    for (const match of validatedMatches) {
      if (!validatedByPage[match.page]) {
        validatedByPage[match.page] = [];
      }
      validatedByPage[match.page].push(match);
    }

    if (validatedMatches.length === 0) {
      this.showAlert({
        title: 'No Valid Matches',
        message: 'No matches found within visible text blocks. The matches may be inside embedded figures or tables.',
        type: 'info'
      });
      return;
    }

    // Use existing ID if editing, otherwise generate new
    const catId = editingId || ('custom_regex_' + Date.now().toString(36));

    // Create/update the category
    const newCategory: Category = {
      id: catId,
      name: name,
      description: `Regex: ${pattern} (${validatedMatches.length} matches)`,
      color: color,
      block_count: validatedMatches.length,
      char_count: validatedMatches.reduce((sum, m) => sum + m.text.length, 0),
      font_size: minSize || 10,
      region: 'body',
      sample_text: validatedMatches[0]?.text || '',
      enabled: true
    };

    // Add/update category in state
    this.categories.update(cats => ({
      ...cats,
      [catId]: newCategory
    }));

    // Store lightweight highlights by page (same as sample mode)
    this.categoryHighlights.update(highlights => {
      const newHighlights = new Map(highlights);
      newHighlights.set(catId, validatedByPage);
      return newHighlights;
    });

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);

    // Close modal and clear editing state
    this.regexPanelExpanded.set(false);
    this.editingCategoryId.set(null);

    // Collapse the create category accordion
    this.categoriesPanel?.collapseCreateSection();

  }

  deleteCustomCategory(categoryId: string): void {
    // Remove from categories
    this.categories.update(cats => {
      const newCats = { ...cats };
      delete newCats[categoryId];
      return newCats;
    });

    // Remove from highlights
    this.categoryHighlights.update(highlights => {
      const newHighlights = new Map(highlights);
      newHighlights.delete(categoryId);
      return newHighlights;
    });

    // Clear focused state if this was the focused category
    if (this.focusedCategoryId() === categoryId) {
      this.focusedCategoryId.set(null);
    }

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);

  }

  // Toggle deletion state for all highlights in a custom category
  // If all are deleted -> un-delete all; otherwise -> delete all
  clearCustomCategoryHighlights(categoryId: string): void {
    const highlights = this.categoryHighlights().get(categoryId);
    if (!highlights) return;

    const currentDeletedIds = this.deletedHighlightIds();
    const newDeletedIds = new Set(currentDeletedIds);

    // Collect all highlight IDs for this category
    const categoryHighlightIds: string[] = [];
    for (const [pageStr, rects] of Object.entries(highlights)) {
      const page = parseInt(pageStr);
      for (const rect of rects) {
        const id = this.getHighlightId(categoryId, page, rect.x, rect.y);
        categoryHighlightIds.push(id);
      }
    }

    // Check if ALL highlights in this category are already deleted
    const allDeleted = categoryHighlightIds.every(id => currentDeletedIds.has(id));

    if (allDeleted) {
      // UN-DELETE all highlights in this category
      for (const id of categoryHighlightIds) {
        newDeletedIds.delete(id);
      }
    } else {
      // DELETE all highlights in this category
      for (const id of categoryHighlightIds) {
        newDeletedIds.add(id);
      }
    }

    this.deletedHighlightIds.set(newDeletedIds);

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);
  }

  editCustomCategory(categoryId: string): void {
    const cat = this.categories()[categoryId];
    if (!cat) return;

    // Load category data into the form
    this.editingCategoryId.set(categoryId);
    this.regexCategoryName.set(cat.name);
    this.regexCategoryColor.set(cat.color);

    // We don't store the original pattern, so leave it empty
    // The user can enter a new pattern to update matches, or just rename/recolor
    this.regexPattern.set('');
    this.regexMinFontSize.set(0);
    this.regexMaxFontSize.set(0);
    this.regexMinBaseline.set(null);
    this.regexMaxBaseline.set(null);
    this.regexCaseSensitive.set(false);
    this.regexLiteralMode.set(false);
    this.regexMatches.set([]);
    this.regexMatchCount.set(0);

    // Expand the panel
    this.regexPanelExpanded.set(true);

  }

  toggleCategoryEnabled(categoryId: string): void {
    this.categories.update(cats => {
      const cat = cats[categoryId];
      if (!cat) return cats;
      return {
        ...cats,
        [categoryId]: {
          ...cat,
          enabled: !cat.enabled
        }
      };
    });
  }

  // Mode methods
  setMode(mode: EditorMode): void {
    const previousMode = this.currentMode();

    // If entering crop mode, save layout and switch to vertical
    if (mode === 'crop' && previousMode !== 'crop') {
      this.previousLayout = this.layout();
      this.layout.set('vertical');
      this.cropCurrentPage.set(0);
      this.currentCropRect.set(null);
    }

    // If leaving crop mode, restore layout
    if (previousMode === 'crop' && mode !== 'crop') {
      this.layout.set(this.previousLayout);
      this.pdfViewer?.clearCrop();
      this.currentCropRect.set(null);
    }

    // If entering split mode, auto-enable splitting
    if (mode === 'split' && previousMode !== 'split') {
      this.splitConfig.update(config => ({ ...config, enabled: true }));
      this.splitPreviewPage.set(0);
    }

    // If entering OCR mode, open OCR settings
    if (mode === 'ocr') {
      // In lightweight mode, pre-render pages for OCR
      if (this.lightweightMode()) {
        // Pre-render all pages (or a reasonable subset)
        // For now, we'll just show the modal and let the user select which pages
        // Then we'll pre-render those specific pages when they click "Start OCR"
      }
      this.showOcrSettings.set(true);
      // Don't change currentMode - OCR is a modal, not a persistent mode
      return;
    }

    // If entering chapters mode, try to auto-load outline on first entry
    if (mode === 'chapters' && previousMode !== 'chapters') {
      if (this.chapters().length === 0) {
        this.tryLoadOutline();
      }
    }

    this.currentMode.set(mode);
  }

  // Crop methods (for backward compatibility with panel)
  enterCropMode(): void {
    this.setMode('crop');
  }

  exitCropMode(): void {
    this.setMode('select');
  }

  cancelCrop(): void {
    this.exitCropMode();
  }

  cropPrevPage(): void {
    const current = this.cropCurrentPage();
    if (current > 0) {
      this.cropCurrentPage.set(current - 1);
      this.scrollToPage(current - 1);
    }
  }

  cropNextPage(): void {
    const current = this.cropCurrentPage();
    if (current < this.totalPages() - 1) {
      this.cropCurrentPage.set(current + 1);
      this.scrollToPage(current + 1);
    }
  }

  onCropComplete(cropRect: CropRect): void {
    this.currentCropRect.set(cropRect);
  }

  applyCropFromPanel(event: { pages: number[]; cropRect: CropRect }): void {
    this.applyCropToPages(event.pages, event.cropRect);
    this.exitCropMode();
  }

  private applyCropToPages(pageNums: number[], cropRect: CropRect): void {
    const selectionBefore = [...this.selectedBlockIds()];
    const deleted = new Set(this.deletedBlockIds());
    const toDelete: string[] = [];

    for (const block of this.blocks()) {
      // Skip if not on one of the target pages
      if (!pageNums.includes(block.page)) continue;

      // Skip if already deleted
      if (deleted.has(block.id)) continue;

      // Check if block is outside the crop region
      const blockRight = block.x + block.width;
      const blockBottom = block.y + block.height;
      const cropRight = cropRect.x + cropRect.width;
      const cropBottom = cropRect.y + cropRect.height;

      // Block is outside if it doesn't overlap with crop rect
      const isOutside =
        blockRight < cropRect.x ||  // Block is to the left
        block.x > cropRight ||       // Block is to the right
        blockBottom < cropRect.y ||  // Block is above
        block.y > cropBottom;        // Block is below

      if (isOutside) {
        toDelete.push(block.id);
        deleted.add(block.id);
      }
    }

    if (toDelete.length > 0) {
      this.editorState.deleteBlocks(toDelete);
    }
  }

  // Split mode methods
  splitPrevPage(): void {
    const current = this.splitPreviewPage();
    if (current > 0) {
      this.splitPreviewPage.set(current - 1);
      this.scrollToPage(current - 1);
    }
  }

  splitNextPage(): void {
    const current = this.splitPreviewPage();
    if (current < this.totalPages() - 1) {
      this.splitPreviewPage.set(current + 1);
      this.scrollToPage(current + 1);
    }
  }

  exitSplitMode(): void {
    this.setMode('select');
  }

  // Cancel split mode - discard changes and disable split
  cancelSplitMode(): void {
    this.splitConfig.update(config => ({ ...config, enabled: false }));
    this.setMode('select');
  }

  // Apply split settings and exit split mode
  applySplit(): void {
    // Keep split enabled, mark as changed, and exit mode
    this.hasUnsavedChanges.set(true);
    this.setMode('select');
  }

  onSplitConfigChange(config: SplitConfig): void {
    this.splitConfig.set(config);
    this.hasUnsavedChanges.set(true);
  }

  // Get split position for a specific page (considering overrides)
  getSplitPositionForPage(pageNum: number): number {
    const config = this.splitConfig();
    if (!config.enabled) return 0.5;

    // Check for page-specific override
    if (pageNum in config.pageOverrides) {
      return config.pageOverrides[pageNum];
    }

    // Use odd/even setting
    const isOdd = (pageNum + 1) % 2 === 1;
    return isOdd ? config.oddPageSplit : config.evenPageSplit;
  }

  // Set split position override for current page (called from pdf-viewer drag)
  setSplitOverrideForPage(pageNum: number, position: number): void {
    const config = this.splitConfig();
    const newOverrides = { ...config.pageOverrides, [pageNum]: position };
    this.splitConfig.set({ ...config, pageOverrides: newOverrides });
    this.hasUnsavedChanges.set(true);
  }

  // Handle split position change from pdf-viewer drag
  onSplitPositionChange(event: { pageNum: number; position: number }): void {
    this.setSplitOverrideForPage(event.pageNum, event.position);
  }

  // Handle split page checkbox toggle
  onSplitPageToggle(event: { pageNum: number; enabled: boolean }): void {
    const config = this.splitConfig();
    const newSkipped = new Set(config.skippedPages);

    if (event.enabled) {
      // Page should be split - remove from skipped
      newSkipped.delete(event.pageNum);
    } else {
      // Page should NOT be split - add to skipped
      newSkipped.add(event.pageNum);
    }

    this.splitConfig.set({ ...config, skippedPages: newSkipped });
    this.hasUnsavedChanges.set(true);
  }

  // Deskew methods for split mode
  async deskewCurrentPage(): Promise<void> {
    const pageNum = this.splitPreviewPage();
    await this.deskewPage(pageNum);
  }

  async deskewAllPages(): Promise<void> {
    this.deskewing.set(true);
    const total = this.totalPages();

    for (let i = 0; i < total; i++) {
      await this.deskewPage(i);
    }

    this.deskewing.set(false);
    this.showAlert({
      title: 'Deskew Complete',
      message: `Analyzed ${total} pages for rotation correction.`,
      type: 'success'
    });
  }

  private async deskewPage(pageNum: number): Promise<void> {
    this.deskewing.set(true);

    try {
      // Get the page image for OCR analysis
      const pageImage = this.pageImages().get(pageNum);
      if (!pageImage) {
        console.warn(`No image cached for page ${pageNum}`);
        this.deskewing.set(false);
        return;
      }

      // Detect skew angle using Tesseract
      const result = await this.electronService.ocrDetectSkew(pageImage);

      if (result && Math.abs(result.angle) > 0.1) {
        // Only apply correction if angle is significant (> 0.1 degrees)
        this.lastDeskewAngle.set(result.angle);

        // TODO: Apply the rotation to the page
        // This would require either:
        // 1. Modifying the PDF itself (complex, requires PDF manipulation)
        // 2. Applying CSS transform to the displayed page (visual only)
        // 3. Storing rotation info to be applied during export
        // For now, we just detect and report the angle
      } else {
        this.lastDeskewAngle.set(result?.angle ?? 0);
      }
    } catch (err) {
      console.error('Deskew detection failed:', err);
      this.showAlert({
        title: 'Deskew Failed',
        message: 'Could not detect page orientation. Make sure Tesseract is installed.',
        type: 'error'
      });
    }

    this.deskewing.set(false);
  }

  // Chapter methods
  async tryLoadOutline(): Promise<void> {
    try {
      const outline = await this.electronService.extractOutline();
      if (outline && outline.length > 0) {
        const chapters = await this.electronService.outlineToChapters(outline);
        if (chapters.length > 0) {
          this.chapters.set(chapters);
          this.chaptersSource.set('toc');
        }
      }
    } catch (err) {
      console.warn('Failed to extract outline:', err);
    }
  }

  async autoDetectChapters(): Promise<void> {
    this.detectingChapters.set(true);
    try {
      const chapters = await this.electronService.detectChapters();
      if (chapters.length > 0) {
        // Merge with existing chapters, preferring TOC entries
        const existing = this.chapters();
        const existingPages = new Set(existing.map(c => c.page));
        const newChapters = chapters.filter(c => !existingPages.has(c.page));

        if (newChapters.length > 0) {
          this.chapters.set([...existing, ...newChapters].sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return (a.y || 0) - (b.y || 0);
          }));
          this.chaptersSource.set(existing.length > 0 ? 'mixed' : 'heuristic');
        }

      } else {
        this.showAlert({
          title: 'No Chapters Found',
          message: 'Could not automatically detect chapter headings. Try marking chapters manually by clicking on text blocks.',
          type: 'info'
        });
      }
    } catch (err) {
      console.error('Failed to detect chapters:', err);
      this.showAlert({
        title: 'Detection Failed',
        message: 'Could not detect chapters: ' + (err as Error).message,
        type: 'error'
      });
    } finally {
      this.detectingChapters.set(false);
    }
  }

  addChapterFromBlock(block: TextBlock, level: number = 1): void {
    const chapterId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newChapter: Chapter = {
      id: chapterId,
      title: block.text.length > 80 ? block.text.substring(0, 77) + '...' : block.text,
      page: block.page,
      blockId: block.id,
      y: block.y,
      level,
      source: 'manual',
    };

    // Insert in sorted order
    const chapters = [...this.chapters(), newChapter].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    this.chapters.set(chapters);
    this.selectedChapterId.set(chapterId);
    this.chaptersSource.set(this.chapters().some(c => c.source !== 'manual') ? 'mixed' : 'manual');
    this.hasUnsavedChanges.set(true);
  }

  removeChapter(chapterId: string): void {
    this.chapters.update(chapters => chapters.filter(c => c.id !== chapterId));
    if (this.selectedChapterId() === chapterId) {
      this.selectedChapterId.set(null);
    }
    this.hasUnsavedChanges.set(true);
  }

  renameChapter(event: { chapterId: string; newTitle: string }): void {
    this.chapters.update(chapters =>
      chapters.map(c =>
        c.id === event.chapterId
          ? { ...c, title: event.newTitle }
          : c
      )
    );
    this.hasUnsavedChanges.set(true);
  }

  onMetadataChange(newMetadata: BookMetadata): void {
    this.metadata.set(newMetadata);
    this.hasUnsavedChanges.set(true);
  }

  async onSaveMetadata(): Promise<void> {
    await this.saveProject();
  }

  selectChapter(chapterId: string): void {
    this.selectedChapterId.set(chapterId);
    const chapter = this.chapters().find(c => c.id === chapterId);
    if (chapter) {
      this.scrollToPage(chapter.page);
    }
  }

  clearAllChapters(): void {
    this.chapters.set([]);
    this.chaptersSource.set('manual');
    this.selectedChapterId.set(null);
    this.hasUnsavedChanges.set(true);
  }

  /**
   * Finalize chapters for export - validates and prepares chapter metadata
   * This recalculates page numbers accounting for deleted pages and shows a summary
   */
  async finalizeChapters(): Promise<void> {
    const chapters = this.chapters();
    const deletedPages = this.deletedPages();

    if (chapters.length === 0) {
      this.showAlert({
        title: 'No Chapters',
        message: 'Please define at least one chapter before finalizing.',
        type: 'warning'
      });
      return;
    }

    this.finalizingChapters.set(true);

    try {
      // Filter out chapters on deleted pages
      const activeChapters = chapters.filter(c => !deletedPages.has(c.page));

      if (activeChapters.length === 0) {
        this.showAlert({
          title: 'No Valid Chapters',
          message: 'All chapters are on deleted pages. Please add chapters on active pages.',
          type: 'warning'
        });
        return;
      }

      // Calculate effective page numbers (accounting for deleted pages before each chapter)
      const chapterSummary = activeChapters.map(chapter => {
        const deletedBefore = Array.from(deletedPages).filter(p => p < chapter.page).length;
        const effectivePage = chapter.page - deletedBefore;
        return {
          title: chapter.title,
          originalPage: chapter.page + 1,  // 1-indexed for display
          effectivePage: effectivePage + 1,  // 1-indexed for display
          level: chapter.level
        };
      });

      // Update chapters with effective page numbers for export
      // (stored separately so original page numbers are preserved)
      const removedCount = chapters.length - activeChapters.length;
      const deletedPagesCount = deletedPages.size;

      let message = `${activeChapters.length} chapter${activeChapters.length !== 1 ? 's' : ''} ready for export.`;
      if (removedCount > 0) {
        message += ` (${removedCount} chapter${removedCount !== 1 ? 's' : ''} on deleted pages excluded)`;
      }
      if (deletedPagesCount > 0) {
        message += `\n${deletedPagesCount} page${deletedPagesCount !== 1 ? 's' : ''} will be skipped during export.`;
      }

      // Save the project to persist chapters
      await this.saveProject();

      this.showAlert({
        title: 'Chapters Finalized',
        message,
        type: 'success'
      });

      // Exit chapters mode after finalizing
      this.exitChaptersMode();

    } catch (err) {
      console.error('Failed to finalize chapters:', err);
      this.showAlert({
        title: 'Finalization Failed',
        message: 'Could not finalize chapters: ' + (err as Error).message,
        type: 'error'
      });
    } finally {
      this.finalizingChapters.set(false);
    }
  }

  // Page deletion methods (with undo/redo support via editor state)
  togglePageDeleted(pageNum: number): void {
    this.editorState.togglePageDeletion([pageNum]);
  }

  isPageDeleted(pageNum: number): boolean {
    return this.deletedPages().has(pageNum);
  }

  getDeletedPageCount(): number {
    return this.deletedPages().size;
  }

  clearDeletedPages(): void {
    // Restore all deleted pages (with undo support)
    const deletedArray = [...this.deletedPages()];
    if (deletedArray.length > 0) {
      this.editorState.restorePages(deletedArray);
    }
  }

  // Page selection methods (for edit/organize/chapters mode)
  onPageSelect(event: { pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
    const { pageNum, shiftKey, metaKey, ctrlKey } = event;

    // Clear block selection when selecting pages (mutually exclusive)
    if (this.selectedBlockIds().length > 0) {
      this.selectedBlockIds.set([]);
    }

    this.selectedPageNumbers.update(selected => {
      const newSelected = new Set(selected);

      if (shiftKey && this.lastSelectedPage !== null) {
        // Range selection: select all pages between last selected and current
        const start = Math.min(this.lastSelectedPage, pageNum);
        const end = Math.max(this.lastSelectedPage, pageNum);
        for (let i = start; i <= end; i++) {
          newSelected.add(i);
        }
      } else if (metaKey || ctrlKey) {
        // Toggle selection
        if (newSelected.has(pageNum)) {
          newSelected.delete(pageNum);
        } else {
          newSelected.add(pageNum);
        }
      } else {
        // Single selection: clear others and select this one
        newSelected.clear();
        newSelected.add(pageNum);
      }

      return newSelected;
    });

    // Update last selected page (unless shift-clicking)
    if (!shiftKey) {
      this.lastSelectedPage = pageNum;
    }
  }

  onDeleteSelectedPages(pages: Set<number>): void {
    if (pages.size === 0) {
      // Clear selection
      this.selectedPageNumbers.set(new Set());
      return;
    }

    // Toggle page deletion (delete if not deleted, restore if all are deleted)
    const pageArray = [...pages];
    this.editorState.togglePageDeletion(pageArray);

    // Clear selection after action
    this.selectedPageNumbers.set(new Set());
  }

  clearPageSelection(): void {
    this.selectedPageNumbers.set(new Set());
    this.lastSelectedPage = null;
  }

  exitChaptersMode(): void {
    this.setMode('select');
  }

  onChapterClick(event: { block: TextBlock; level: number }): void {
    // Check if this block is already marked as a chapter
    const existingChapter = this.chapters().find(c => c.blockId === event.block.id);
    if (existingChapter) {
      // If it's already a chapter, remove it
      this.removeChapter(existingChapter.id);
    } else {
      // Add new chapter
      this.addChapterFromBlock(event.block, event.level);
    }
  }

  /**
   * Handle chapter placement on empty space (no block to snap to).
   * Creates a chapter at the specified Y position on the page.
   */
  onChapterPlacement(event: { pageNum: number; y: number; level: number }): void {
    // Check if there's already a chapter near this Y position on this page
    const existingNearby = this.chapters().find(c =>
      c.page === event.pageNum && Math.abs((c.y || 0) - event.y) < 20
    );

    if (existingNearby) {
      // Remove existing nearby chapter (toggle behavior)
      this.removeChapter(existingNearby.id);
      return;
    }

    // Create a new chapter at this position
    const chapterId = 'chapter_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const chapterNum = this.chapters().filter(c => c.level === event.level).length + 1;
    const title = event.level === 1 ? `Chapter ${chapterNum}` : `Section ${chapterNum}`;

    const newChapter: Chapter = {
      id: chapterId,
      title,
      page: event.pageNum,
      y: event.y,
      level: event.level,
      source: 'manual',
      blockId: undefined // No block associated
    };

    this.chapters.update(chapters => [...chapters, newChapter].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    }));

    this.chaptersSource.set('manual');
    this.hasUnsavedChanges.set(true);
  }

  /**
   * Handle chapter marker drag - update chapter position
   */
  onChapterDrag(event: { chapterId: string; pageNum: number; y: number; snapToBlock?: TextBlock }): void {
    this.chapters.update(chapters =>
      chapters.map(ch => {
        if (ch.id === event.chapterId) {
          return {
            ...ch,
            page: event.pageNum,
            y: event.y,
            blockId: event.snapToBlock?.id,
            // Update title if snapped to a new block with text
            title: event.snapToBlock
              ? (event.snapToBlock.text.trim().substring(0, 50) || ch.title)
              : ch.title
          };
        }
        return ch;
      }).sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return (a.y || 0) - (b.y || 0);
      })
    );

    this.hasUnsavedChanges.set(true);
  }

  // OCR methods
  getPageImageForOcr(pageNum: number): string | null {
    const allImages = this.pageImages();
    const image = allImages.get(pageNum);

    // In lightweight mode, we don't have page images - OCR will use headless processing
    if (!image && this.lightweightMode()) {
      return null; // OCR modal will handle this gracefully
    }

    if (!image) {
      console.warn(`getPageImageForOcr(${pageNum}): No image found. Map size: ${allImages.size}, keys: ${Array.from(allImages.keys()).slice(0, 5).join(',')}...`);
    }
    return image && image !== 'loading' && image !== 'failed' ? image : null;
  }

  onOcrCompleted(event: OcrCompletionEvent | OcrPageResult[]): void {
    // Handle both old format (array) and new format (event object)
    const results = Array.isArray(event) ? event : event.results;
    const useSuryaCategories = Array.isArray(event) ? false : event.useSuryaCategories;


    // Count total text lines with bboxes
    const totalLines = results.reduce((sum, r) => sum + (r.textLines?.length || 0), 0);

    if (totalLines === 0) {
      // No bounding box data - just show success message
      this.showAlert({
        title: 'OCR Complete',
        message: `Processed ${results.length} pages. No bounding boxes available for block creation.`,
        type: 'success'
      });
      return;
    }

    // Find existing categories by region type to assign OCR blocks appropriately
    const categories = this.categories();
    const pageDims = this.pageDimensions();

    // Find the best category for each region type (body, header, footer)
    // Prefer existing categories with the most content
    const findCategoryByRegion = (region: string): string | null => {
      let bestCat: string | null = null;
      let bestChars = 0;
      for (const [id, cat] of Object.entries(categories)) {
        if (cat.region === region && cat.char_count > bestChars) {
          bestChars = cat.char_count;
          bestCat = id;
        }
      }
      return bestCat;
    };

    const bodyCategoryId = findCategoryByRegion('body');
    const headerCategoryId = findCategoryByRegion('header');
    const footerCategoryId = findCategoryByRegion('footer');

    // Default to body category or first available category
    const defaultCategoryId = bodyCategoryId || Object.keys(categories)[0] || 'body';

    // Full-res images are always rendered at 2.5x scale (FULL_SCALE in pdf-analyzer.ts)
    // OCR bbox coordinates are in image pixels, so divide by 2.5 to get PDF coordinates
    const renderScale = 2.5;

    // Convert OCR text lines to TextBlocks
    const newBlocks: TextBlock[] = [];
    // Use random suffix + page + index for unique IDs across all OCR batches
    const ocrBatchId = Math.random().toString(36).substring(2, 8);
    let lineCounter = 0;
    const pagesWithOcrResults: number[] = [];  // Only pages that actually have OCR results

    for (const result of results) {
      if (!result.textLines || result.textLines.length === 0) {
        continue;  // Skip pages with no OCR results - don't remove their existing blocks
      }

      // Only track pages that actually have OCR results
      pagesWithOcrResults.push(result.page);

      const pageWidth = pageDims[result.page]?.width || 600;
      const pageHeight = pageDims[result.page]?.height || 800;

      // Log first line of first page for debugging
      if (result.textLines.length > 0 && result.page === pagesWithOcrResults[0]) {
        const firstLine = result.textLines[0];
      }

      for (const line of result.textLines) {
        const [x1, y1, x2, y2] = line.bbox;

        // Convert from image pixels to PDF coordinates (divide by render scale)
        const pdfY = y1 / renderScale;
        const pdfHeight = (y2 - y1) / renderScale;

        // Classify by position on page
        const yPercent = pdfY / pageHeight;
        let region: string;
        let categoryId: string;

        if (yPercent < 0.08) {
          // Top 8% of page = header
          region = 'header';
          categoryId = headerCategoryId || defaultCategoryId;
        } else if (yPercent > 0.92) {
          // Bottom 8% of page = footer
          region = 'footer';
          categoryId = footerCategoryId || defaultCategoryId;
        } else {
          // Everything else = body
          region = 'body';
          categoryId = defaultCategoryId;
        }

        // Estimate font size from line height with sanity checks
        // OCR bounding boxes often include whitespace, so use a conservative multiplier
        const pdfWidth = (x2 - x1) / renderScale;
        let estimatedFontSize = Math.round(pdfHeight * 0.7);  // More conservative multiplier

        // For very short text (1-3 chars), the bounding box is often much taller than needed
        // Use character width as a better estimate
        const textLen = line.text.trim().length;
        if (textLen > 0 && textLen <= 3) {
          // For short text, estimate from width instead (assuming roughly square characters)
          const widthBasedSize = Math.round(pdfWidth / textLen * 0.9);
          estimatedFontSize = Math.min(estimatedFontSize, widthBasedSize);
        }

        // Cap font size to sensible document ranges
        // Most books: body 10-14pt, headings 14-24pt, titles up to 48pt
        const maxFontSize = 48;
        const minFontSize = 8;
        estimatedFontSize = Math.max(minFontSize, Math.min(maxFontSize, estimatedFontSize));

        const block: TextBlock = {
          id: `ocr_p${result.page}_${ocrBatchId}_${lineCounter++}`,
          page: result.page,
          x: x1 / renderScale,
          y: pdfY,
          width: pdfWidth,
          height: pdfHeight,
          text: line.text,
          font_size: estimatedFontSize,
          font_name: 'OCR',
          char_count: line.text.length,
          region,
          category_id: categoryId,
          is_ocr: true  // Mark as OCR-generated (independent from images)
        };

        newBlocks.push(block);
      }
    }

    // Collect layout blocks from Surya (if available) for smart categorization
    const layoutBlocksByPage = new Map<number, any[]>();
    // Debug: check what layout data is coming in
    const pagesWithLayout = results.filter(r => r.layoutBlocks && r.layoutBlocks.length > 0);
    if (pagesWithLayout.length === 0 && results.length > 0) {
    }
    for (const result of results) {
      if (result.layoutBlocks && result.layoutBlocks.length > 0) {
        // Scale layout blocks from image pixels to PDF coordinates
        const scaledBlocks = result.layoutBlocks.map(lb => ({
          ...lb,
          bbox: [
            lb.bbox[0] / renderScale,
            lb.bbox[1] / renderScale,
            lb.bbox[2] / renderScale,
            lb.bbox[3] / renderScale
          ] as [number, number, number, number]
        }));
        layoutBlocksByPage.set(result.page, scaledBlocks);
        scaledBlocks.forEach((b, i) => {
        });
      }
    }

    // Post-process OCR blocks: merge lines into paragraphs and apply smart categorization
    // Only use Surya layout blocks for categorization if the user opted in
    const layoutDataForCategorization = useSuryaCategories ? layoutBlocksByPage : undefined;
    const processedResult = this.ocrPostProcessor.processOcrBlocks(newBlocks, pageDims, layoutDataForCategorization);
    const processedBlocks = processedResult.blocks;
    const newCategories = processedResult.categories;

    const hasLayoutData = useSuryaCategories && layoutBlocksByPage.size > 0;

    // Merge new OCR categories with existing categories
    const existingCategories = this.categories();
    const mergedCategories = { ...existingCategories, ...newCategories };
    this.editorState.categories.set(mergedCategories);

    // Only replace blocks on pages that have OCR results
    // Pages with no OCR results keep their existing blocks
    if (pagesWithOcrResults.length > 0) {
      // Collect fill regions from OCR text lines (where text was actually detected)
      // These will fill the text areas with background color, becoming part of the background
      const ocrFillRegionsByPage = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>();

      for (const result of results) {
        if (!result.textLines || result.textLines.length === 0) continue;

        const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const line of result.textLines) {
          const [x1, y1, x2, y2] = line.bbox;
          // Convert from image pixels to PDF coordinates
          regions.push({
            x: x1 / renderScale,
            y: y1 / renderScale,
            width: (x2 - x1) / renderScale,
            height: (y2 - y1) / renderScale
          });
        }
        ocrFillRegionsByPage.set(result.page, regions);
      }

      // Replace blocks with processed OCR blocks
      this.editorState.replaceTextBlocksOnPages(pagesWithOcrResults, processedBlocks);

      // Update spans for OCR pages so custom category matching searches OCR text
      for (const pageNum of pagesWithOcrResults) {
        const pageBlocks = processedBlocks.filter(b => b.page === pageNum);
        const ocrBlocksForSpans = pageBlocks.map(b => ({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          text: b.text,
          font_size: b.font_size,
          id: b.id
        }));
        this.electronService.updateSpansForOcr(pageNum, ocrBlocksForSpans);
      }

      // Clear selection since old block IDs no longer exist
      this.selectedBlockIds.set([]);

      // Re-render each page with OCR text areas filled with background color
      // This integrates the fills into the background image
      for (const pageNum of pagesWithOcrResults) {
        const fillRegions = ocrFillRegionsByPage.get(pageNum);
        if (fillRegions && fillRegions.length > 0) {
          this.pageRenderService.rerenderPageWithRedactions(pageNum, undefined, fillRegions);
        }
      }
    }

    // Update category stats
    this.editorState.updateCategoryStats();

    // Update the open document's blocks
    this.saveCurrentDocumentState();

    // Log results for debugging
    if (processedBlocks.length > 0) {
    } else {
    }
  }

  /**
   * Called when an OCR job starts in the background
   */
  async onBackgroundOcrStarted(jobId: string): Promise<void> {
    // Check if this is a headless OCR job (lightweight mode)
    if (jobId.startsWith('headless_')) {
      console.log(`[OCR] Starting headless OCR job: ${jobId}`);

      // Parse parameters from the special job ID
      // Format: headless_timestamp_engine_language_page1,page2,page3
      const parts = jobId.split('_');
      const engine = parts[2] as 'tesseract' | 'surya';
      const language = parts[3];
      const pagesStr = parts[4] || '';
      const pages = pagesStr ? pagesStr.split(',').map(p => parseInt(p, 10)) : [];

      if (pages.length === 0) {
        // No pages specified, process all
        const totalPages = this.totalPages();
        for (let i = 0; i < totalPages; i++) {
          pages.push(i);
        }
      }

      // Show loading indicator
      this.loading.set(true);
      this.loadingText.set(`Initializing OCR for ${pages.length} pages...`);

      // Subscribe to progress updates
      const unsubscribe = this.electronService.onHeadlessOcrProgress((data) => {
        this.loadingText.set(`Processing OCR: ${data.current}/${data.total} pages`);

        // Also update background job progress for UI consistency
        const progress = Math.round((data.current / data.total) * 100);
        console.log(`[OCR] Headless progress: ${data.current}/${data.total} (${progress}%)`);
      });

      try {
        // Run headless OCR directly on the PDF
        const results = await this.electronService.ocrProcessPdfHeadless(
          this.effectivePath(),
          {
            engine,
            language,
            pages
          }
        );

        if (results && results.length > 0) {
          console.log(`[OCR] Headless OCR completed with ${results.length} pages`);

          // Convert results to the expected format
          const ocrPageResults = results.map(r => ({
            page: r.page,
            text: r.text,
            confidence: r.confidence,
            textLines: r.textLines,
            layoutBlocks: r.layoutBlocks
          }));

          // Process the OCR results - this will apply them to the document
          this.onOcrCompleted({
            results: ocrPageResults,
            useSuryaCategories: engine === 'surya'
          });

          // Show success message
          this.showAlert({
            title: 'OCR Complete',
            message: `Successfully processed ${results.length} pages with ${engine}`,
            type: 'success'
          });
        } else {
          this.showAlert({
            title: 'OCR Failed',
            message: 'No text was detected in the document',
            type: 'error'
          });
        }
      } catch (err) {
        console.error(`[OCR] Headless OCR failed:`, err);
        this.showAlert({
          title: 'OCR Failed',
          message: err instanceof Error ? err.message : 'Unknown error during OCR processing',
          type: 'error'
        });
      } finally {
        unsubscribe();
        this.loading.set(false);
      }

      return; // Don't continue with regular job processing
    }

    // Regular OCR job (non-lightweight mode)
    // The job will continue running and call onOcrCompleted when done
    // via the completion callback registered in the OcrJobService
  }

  /**
   * Dismiss a completed/errored background job
   */
  onDismissBackgroundJob(jobId: string): void {
    this.ocrJobService.dismissJob(jobId);
  }

  /**
   * Cancel a running or queued background job
   */
  onCancelBackgroundJob(jobId: string): void {
    this.ocrJobService.cancelJob(jobId);
  }

  // Tab management methods
  onTabSelected(tab: DocumentTab): void {
    if (tab.id === this.activeDocumentId()) return;

    // Save current document state
    this.saveCurrentDocumentState();

    // Restore selected document state
    this.restoreDocumentState(tab.id);
  }

  onTabClosed(tab: DocumentTab): void {
    const docs = this.openDocuments();
    const docIndex = docs.findIndex(d => d.id === tab.id);
    if (docIndex === -1) return;

    const doc = docs[docIndex];

    // Auto-save if there are unsaved changes
    if (doc.hasUnsavedChanges && this.projectService.projectPath()) {
      // Save in background before closing
      this.saveProject().catch(err => console.error('Auto-save on close failed:', err));
    }

    // Remove from list
    const newDocs = docs.filter(d => d.id !== tab.id);
    this.openDocuments.set(newDocs);

    // If closing active tab, switch to another or show library view
    if (tab.id === this.activeDocumentId()) {
      if (newDocs.length > 0) {
        // Switch to previous tab or first available
        const newIndex = Math.max(0, docIndex - 1);
        this.restoreDocumentState(newDocs[newIndex].id);
      } else {
        // No more documents - show library view
        this.activeDocumentId.set(null);
        this.pdfLoaded.set(false);
      }
    }
  }

  closeCurrentTabOrHideWindow(): void {
    const activeId = this.activeDocumentId();

    // If in library view (no active document), hide the window
    if (!activeId) {
      this.electronService.windowHide();
      return;
    }

    // Otherwise close the current document tab
    const currentTab = this.documentTabs().find(t => t.id === activeId);
    if (currentTab) {
      this.onTabClosed(currentTab);
    }
  }

  private saveCurrentDocumentState(): void {
    const activeId = this.activeDocumentId();
    if (!activeId) return;

    const history = this.editorState.getHistory();
    this.openDocuments.update(docs =>
      docs.map(doc => {
        if (doc.id === activeId) {
          return {
            ...doc,
            blocks: this.blocks(),
            categories: this.categories(),
            pageDimensions: this.pageDimensions(),
            totalPages: this.totalPages(),
            deletedBlockIds: this.deletedBlockIds(),
            deletedPages: this.deletedPages(),
            selectedBlockIds: this.selectedBlockIds(),
            pageOrder: this.pageOrder(),
            pageImages: this.pageRenderService.getPageImagesMap(),
            hasUnsavedChanges: this.hasUnsavedChanges(),
            projectPath: this.projectPath(),
            undoStack: history.undoStack,
            redoStack: history.redoStack
          };
        }
        return doc;
      })
    );
  }

  private restoreDocumentState(docId: string): void {
    const doc = this.openDocuments().find(d => d.id === docId);
    if (!doc) return;


    this.activeDocumentId.set(docId);

    // Load document data via service
    this.editorState.loadDocument({
      blocks: doc.blocks,
      categories: doc.categories,
      pageDimensions: doc.pageDimensions,
      totalPages: doc.totalPages,
      pdfName: doc.name,
      pdfPath: doc.path,
      libraryPath: doc.libraryPath,
      fileHash: doc.fileHash,
      deletedBlockIds: doc.deletedBlockIds,
      pageOrder: doc.pageOrder
    });

    // Restore additional state
    this.editorState.selectedBlockIds.set(doc.selectedBlockIds);
    this.editorState.hasUnsavedChanges.set(doc.hasUnsavedChanges);
    this.deletedPages.set(doc.deletedPages);
    this.editorState.setHistory({
      undoStack: doc.undoStack,
      redoStack: doc.redoStack
    });

    this.pageRenderService.restorePageImages(doc.pageImages);
    this.projectService.projectPath.set(doc.projectPath);
  }

  private clearDocumentState(): void {
    this.activeDocumentId.set(null);
    this.editorState.reset();
    this.pageRenderService.clear();
    this.projectService.reset();
  }

  private generateDocumentId(): string {
    return 'doc_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Restore open tabs from localStorage.
   * Called on component init to preserve tabs across route navigation.
   */
  private async restoreOpenTabs(): Promise<void> {
    try {
      const savedPaths = localStorage.getItem(this.OPEN_TABS_KEY);
      const activeTabPath = localStorage.getItem(this.ACTIVE_TAB_KEY);

      if (!savedPaths) return;

      const projectPaths: string[] = JSON.parse(savedPaths);
      if (!Array.isArray(projectPaths) || projectPaths.length === 0) return;


      // Load each project
      for (const path of projectPaths) {
        try {
          await this.loadProjectFromPath(path);
        } catch (err) {
          console.error('[restoreOpenTabs] Failed to load project:', path, err);
        }
      }

      // Restore active tab if specified and still exists
      if (activeTabPath) {
        const activeDoc = this.openDocuments().find(d => d.projectPath === activeTabPath);
        if (activeDoc) {
          this.restoreDocumentState(activeDoc.id);
        }
      }
    } catch (err) {
      console.error('[restoreOpenTabs] Failed to restore tabs:', err);
    }
  }
}

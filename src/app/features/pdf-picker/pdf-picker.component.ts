import { Component, inject, signal, computed, HostListener, ViewChild, ElementRef, effect, DestroyRef, ChangeDetectionStrategy, input, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService, Chapter, TocLine } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction, BlockEdit, SplitDefinition, MergeDefinition, CropRegion } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
import { ExportService, DeletedHighlight } from './services/export.service';
import { PageRenderService } from './services/page-render.service';
import { OcrPostProcessorService } from './services/ocr-post-processor.service';
import { DesktopThemeService } from '../../creamsicle-desktop/services/theme.service';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { PdfViewerComponent, CropRect } from './components/pdf-viewer/pdf-viewer.component';
import { CleanupPanelComponent } from './components/cleanup-panel/cleanup-panel.component';
import { AnalysisPanelComponent } from './components/analysis-panel/analysis-panel.component';
import { MergePanelComponent } from './components/merge-panel/merge-panel.component';
import { RegexCriteria, defaultRegexCriteria } from './components/regex-category-builder/regex-category-builder.component';
import { FilePickerComponent } from './components/file-picker/file-picker.component';
import { CropPanelComponent } from './components/crop-panel/crop-panel.component';
import { SplitPanelComponent, SplitConfig } from './components/split-panel/split-panel.component';
import { ChaptersPanelComponent } from './components/chapters-panel/chapters-panel.component';
import { PipelineBarComponent, PipelineStation } from './components/pipeline-bar/pipeline-bar.component';
import { ParagraphPanelComponent } from './components/paragraph-panel/paragraph-panel.component';
import { computeBaselines, learnFromBreaks, detectParagraphBreaks, getDefaultConfig, type DetectionStats, type DetectionConfig, type DocumentBaselines } from './services/paragraph-detector';
import { redetectCategories as redetectCategoriesFromLearner, classifyBlockHeuristic, computeBaselines as computeCategoryBaselines, recategorizeWithThresholds, isDefaultThresholds, detectMergeableGroups, createMergedBlock, type CategoryBaselines, type ClassificationThresholds, type MergeGroup } from './services/category-learner';
import { LibraryViewComponent, ProjectFile } from './components/library-view/library-view.component';
import { TabBarComponent, DocumentTab } from './components/tab-bar/tab-bar.component';
import { OcrSettingsModalComponent, OcrSettings, OcrPageResult, OcrCompletionEvent } from './components/ocr-settings-modal/ocr-settings-modal.component';
import { InlineTextEditorComponent, TextEditResult } from './components/inline-text-editor/inline-text-editor.component';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, ExportFormat } from './components/export-settings-modal/export-settings-modal.component';
import { BackgroundProgressComponent, BackgroundJob } from './components/background-progress/background-progress.component';
import { OcrJobService, OcrJob } from './services/ocr-job.service';
import { TaskRailComponent } from './components/task-rail/task-rail.component';
import { OcrPanelComponent } from './components/ocr-panel/ocr-panel.component';
import {
  TASK_GROUPS,
  TASK_ORDER,
  TaskId,
  PanelId,
  TaskStatus,
  deriveAllTaskStatuses,
  countPagesWithoutText,
  isBlockFullyOutside,
} from './tasks/task.model';

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
  paragraphBreaks?: Set<string>;
  categoryCorrections?: Map<string, string>;
  learnedCategories?: Map<string, string>;
  // Per-document component state (must be saved/restored on tab switch to
  // avoid leaking one document's data into another's project file)
  chapters?: Chapter[];
  chaptersSource?: 'toc' | 'heuristic' | 'manual' | 'mixed';
  metadata?: BookMetadata;
  categoryHighlights?: CategoryHighlights;
  deletedHighlightIds?: Set<string>;
  splitConfig?: SplitConfig;
  /** Session-scoped: user explicitly applied the split (enabled alone is not proof). */
  splitApplied?: boolean;
  /** Persistent crop regions per page (0-indexed). Durable across tab switches. */
  cropRegions?: Map<number, CropRegion>;
  blankedPages?: Set<number>;
  createdAt?: string;  // Project's original created_at (preserved across saves)
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
  coverImage?: string;  // @deprecated - use coverImagePath. Base64 data URL (for old projects)
  coverImagePath?: string;  // Relative path to cover in media folder (e.g., "media/cover_abc123.jpg")
}

// Audiobook production state (stored in BFP project)
interface AudiobookState {
  status: 'pending' | 'cleaning' | 'converting' | 'complete' | 'error';
  // Exported EPUB for TTS (in project folder)
  exportedEpubPath?: string;
  // Cleaned EPUB after AI cleanup
  cleanedEpubPath?: string;
  // TTS settings used for conversion
  ttsSettings?: {
    voice?: string;
    speed?: number;
    language?: string;
  };
  // Output paths
  outputM4bPath?: string;
  outputChaptersFolder?: string;
  // Progress tracking
  progress?: {
    phase: 'preparing' | 'cleaning' | 'converting' | 'merging' | 'complete' | 'error';
    percentage: number;
    currentChapter?: number;
    totalChapters?: number;
    message?: string;
  };
  // Timestamps
  exportedAt?: string;
  cleanedAt?: string;
  completedAt?: string;
  error?: string;
}

interface BookForgeProject {
  version: number;
  source_path: string;    // Original path
  source_name: string;
  library_path?: string;  // Path to copy in library
  file_hash?: string;     // SHA256 hash for duplicate detection
  deleted_block_ids?: string[];
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
  paragraph_breaks?: string[];  // Paragraph boundary block IDs
  category_corrections?: [string, string][];  // [blockId, categoryId][] explicit user overrides
  learned_categories?: [string, string][];  // [blockId, categoryId][] from re-detect
  classification_thresholds?: ClassificationThresholds;
  block_splits?: Array<{
    originalBlockId: string;
    splitPoints: number[];
    childBlockIds: string[];
  }>;
  block_merges?: Array<{ mergedBlockId: string; sourceBlockIds: string[] }>;
  // Persistent crop regions keyed by 0-indexed page number (as a string key in
  // JSON). Each records the crop rect plus the block IDs that crop deleted.
  crop_regions?: Record<string, { rect: { x: number; y: number; width: number; height: number }; deletedBlockIds: string[] }>;
  // Audiobook production (unified with BFP project)
  audiobook?: AudiobookState;
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

/** Stations on the embedded audiobook-prep path, in order. */
type PipelineStep = 'select' | 'chapters' | 'epub-review';

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
    CleanupPanelComponent,
    AnalysisPanelComponent,
    MergePanelComponent,
    FilePickerComponent,
    CropPanelComponent,
    SplitPanelComponent,
    ChaptersPanelComponent,
    PipelineBarComponent,
    ParagraphPanelComponent,
    LibraryViewComponent,
    TabBarComponent,
    OcrSettingsModalComponent,
    InlineTextEditorComponent,
    ExportSettingsModalComponent,
    BackgroundProgressComponent,
    TaskRailComponent,
    OcrPanelComponent,
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
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

    <!-- Tab Bar for open documents (hidden in embedded mode) -->
    @if (!embedded()) {
      <app-tab-bar
        [tabs]="documentTabs()"
        [activeTabId]="activeTabId()"
        (tabSelected)="onTabSelected($event)"
        (tabClosed)="onTabClosed($event)"
        (newTab)="showFilePicker.set(true)"
      />
    }

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
          @if (showToolbox()) {
          <div
            class="tools-sidebar"
            [style.width.px]="toolsSidebarWidth()"
          >
            <app-task-rail
              [groups]="taskGroups"
              [statuses]="taskStatuses()"
              [activePanel]="activePanel()"
              [disabledTasks]="disabledTasks()"
              [collapsedGroups]="collapsedGroups()"
              [interaction]="viewerInteraction()"
              (panelClick)="onRailPanelClick($event)"
              (interactionChange)="viewerInteraction.set($event)"
              (groupToggle)="toggleGroupCollapsed($event)"
            >
              <!-- Rendering controls (unchanged) live in the rail footer -->
              <div rail-footer class="rendering-section">
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
                <div class="text-layers-section">
                  <button
                    class="menu-item"
                    [class.active]="textLayersExpanded()"
                    title="Show/manage text layers"
                    (click)="textLayersExpanded.set(!textLayersExpanded())"
                  >
                    <span class="menu-icon">Aa</span>
                    <span class="menu-text">Text Layers</span>
                    <span class="menu-chevron">{{ textLayersExpanded() ? '▾' : '▸' }}</span>
                  </button>
                  @if (textLayersExpanded()) {
                    <div class="text-layers-list">
                      @for (layer of textLayers(); track layer.id) {
                        <div class="text-layer-row">
                          <label class="text-layer-toggle" [title]="layer.label">
                            <input
                              type="checkbox"
                              [checked]="layer.visible"
                              (change)="toggleTextLayerVisibility(layer.id)"
                            />
                            <span class="text-layer-label">{{ layer.label }}</span>
                            <span class="text-layer-count">{{ layer.count }}</span>
                          </label>
                          @if (layer.count > 0) {
                            <button
                              class="text-layer-delete"
                              title="Delete all {{ layer.label }} blocks"
                              (click)="deleteTextLayer(layer.id)"
                            >×</button>
                          }
                        </div>
                      }
                      @if (textLayers().length === 0) {
                        <div class="text-layer-empty">No text blocks</div>
                      }
                    </div>
                  }
                </div>
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
            </app-task-rail>

            <!-- Resize Handle -->
            <div
              class="sidebar-resize-handle"
              (mousedown)="onSidebarResizeStart($event)"
            ></div>
          </div>
          }

          <!-- Viewer + Timeline wrapper (stacked vertically) -->
          <div class="viewer-timeline-wrapper">
            <!-- Viewer -->
            <div class="viewer-pane">
              @if (reviewMode()) {
                <div class="review-banner">
                  <span class="review-banner-icon">🎧</span>
                  <span class="review-banner-text">This is the final text that goes to TTS — review only.</span>
                  <span class="review-banner-hint">See a problem? Hit <strong>Back</strong> to fix it at the source.</span>
                </div>
              }
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
              [pulseRects]="pulseHighlightRects()"
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
              [cropRegions]="cropRegionRects()"
              [editorMode]="viewerEditorMode()"
              [pageOrder]="pageOrder()"
              [splitMode]="splitMode()"
              [splitEnabled]="splitConfig().enabled"
              [splitPositionFn]="getSplitPositionForPageFn"
              [skippedPages]="splitConfig().skippedPages"
              [sampleMode]="sampleMode()"
              [sampleRects]="sampleRects()"
              [sampleCurrentRect]="sampleDrawingRect()"
              [regexSearchMode]="regexPanelExpanded()"
              [removeBackgrounds]="removeBackgrounds()"
              [showTextLayer]="showTextLayer()"
              [showPdfTextBlocks]="showPdfTextLayer()"
              [showOcrTextBlocks]="showOcrTextLayer()"
              [blankedPages]="blankedPages()"
              [pageImages]="pageImages()"
              [chapters]="chapters()"
              [chaptersMode]="chaptersMode()"
              [chaptersTabActive]="activePanel() === 'chapters'"
              [tocSelectedBlockIds]="tocSelectedBlockIdSet()"
              [isEpub]="isCurrentDocumentEpub()"
              [splitOriginalBlockIds]="splitOriginalBlockIds()"
              [mergeSourceBlockIds]="mergeSourceBlockIds()"
              [deletedPages]="deletedPages()"
              [selectedPages]="selectedPageNumbers()"
              [organizeMode]="organizeMode()"
              [paragraphMode]="paragraphMode()"
              [paragraphBreaks]="editorState.paragraphBreaks()"
              [categoryList]="autoDetectedCategoryList()"
              [categoryCorrections]="editorState.categoryCorrections()"
              (paragraphBreakToggle)="toggleParagraphBreak($event)"
              (paragraphBreakDelete)="deleteParagraphBreak($event)"
              (paragraphBreakMove)="moveParagraphBreak($event)"
              (blockClick)="onBlockClick($event)"
              (chapterClick)="onChapterClick($event)"
              (chapterPlacement)="onChapterPlacement($event)"
              (chapterGutterDrop)="onChapterGutterDrop($event)"
              (chapterFromBlocks)="onChapterFromBlocks($event)"
              (chapterDrag)="onChapterDrag($event)"
              (chapterDelete)="removeChapter($event)"
              (chapterSelect)="selectChapter($event)"
              (chapterRename)="renameChapter($event)"
              (chapterLevelChange)="changeChapterLevel($event)"
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
              (splitBlock)="onSplitBlockRequest($event)"
              (setBlockCategory)="onSetBlockCategory($event)"
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
              [getPageImageUrl]="getPageImageUrlFn"
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
                  @if (selectedPageNumbers().size > 0) {
                    · {{ selectedPageNumbers().size }} pages selected
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

        <!-- Side Panel (Secondary): one instantiation per panel -->
        <div pane-secondary class="secondary-pane-host">
          @switch (activePanel()) {
            @case ('crop') {
              <app-crop-panel
                [currentPage]="cropCurrentPage()"
                [totalPages]="totalPages()"
                [cropRect]="currentCropRect()"
                [cropRegions]="editorState.cropRegions()"
                (prevPage)="cropPrevPage()"
                (nextPage)="cropNextPage()"
                (cancel)="cancelCrop()"
                (apply)="applyCropFromPanel($event)"
                (clearCrop)="clearCropFromPanel($event)"
              />
            }
            @case ('split') {
              <app-split-panel
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
            }
            @case ('chapters') {
              <app-chapters-panel
                [chapters]="chapters()"
                [chaptersSource]="chaptersSource()"
                [detecting]="detectingChapters()"
                [finalizing]="finalizingChapters()"
                [selectedChapterId]="selectedChapterId()"
                [tocMode]="tocMode()"
                [tocEntryCount]="tocBlockIds().length"
                [tocStep]="tocStep()"
                [tocLines]="tocLines()"
                [tocCheckedIndexes]="tocCheckedIndexes()"
                (cancel)="activatePanel(null)"
                (autoDetect)="autoDetectChapters()"
                (findSimilarChapters)="findSimilarChapters()"
                (toggleTocMode)="toggleTocMode()"
                (splitTocBlocks)="splitTocBlocks()"
                (mapTocEntries)="mapTocEntries()"
                (toggleTocLineCheck)="toggleTocLineCheck($event)"
                (tocGoBack)="tocGoBackToBlocks()"
                (clearChapters)="clearAllChapters()"
                (selectChapter)="selectChapter($event)"
                (removeChapter)="removeChapter($event)"
                (renameChapter)="renameChapter($event)"
                (changeLevelChapter)="changeChapterLevel($event)"
                (finalizeChapters)="finalizeChapters()"
              />
            }
            @case ('paragraphs') {
              <app-paragraph-panel
                [paragraphBreaks]="editorState.paragraphBreaks()"
                [detectionStats]="paragraphDetectionStats()"
                [detectionConfig]="paragraphDetectionConfig()"
                [baselines]="paragraphBaselines()"
                [paragraphFixMode]="paragraphFixMode()"
                (detect)="detectParagraphs()"
                (clearAll)="clearParagraphs()"
                (configChange)="onParagraphConfigChange($event)"
                (done)="activatePanel(null)"
                (finishFix)="finishParagraphFix()"
              />
            }
            @case ('ocr') {
              <app-ocr-panel
                [status]="ocrStatus()"
                [pagesWithoutText]="ocrPagesWithoutText()"
                [jobRunning]="ocrJobRunning()"
                (close)="activatePanel(null)"
                (openSettings)="showOcrSettings.set(true)"
              />
            }
            @case ('analysis') {
              <app-analysis-panel
                [flags]="analysisFlags()"
                [analysisCategories]="analysisCategories()"
                [blocks]="textLayerFilteredBlocks()"
                [selectedFlagIndex]="selectedAnalysisFlagIndex()"
                (close)="activatePanel(null)"
                (navigateToFlag)="onAnalysisNavigate($event)"
              />
            }
            @case ('merge') {
              <app-merge-panel
                [mergeCount]="editorState.blockMerges().size"
                (close)="activatePanel(null)"
                (merge)="mergeAdjacentBlocks()"
              />
            }
            @default {
              <!-- null (default) and cleanup both use the cleanup panel -->
              <app-cleanup-panel
                [categories]="categoriesArray()"
                [blocks]="textLayerFilteredBlocks()"
                [selectedBlockIds]="selectedBlockIds()"
                [includedChars]="includedChars()"
                [excludedChars]="excludedChars()"
                [categoryCorrections]="editorState.categoryCorrections()"
                [thresholds]="editorState.classificationThresholds()"
                [baselines]="computedBaselines()"
                [regexMatches]="regexMatches()"
                [regexMatchCount]="regexMatchCount()"
                [regexEditCriteria]="regexEditCriteria()"
                [regexIsEditing]="!!editingCategoryId()"
                [regexExpanded]="regexPanelExpanded()"
                (close)="activatePanel(null)"
                (clearCorrections)="clearCategoryCorrections()"
                (thresholdChange)="onThresholdChange($event)"
                (recategorize)="recategorizeBlocks()"
                (resetThresholds)="resetThresholds()"
                (selectCategory)="selectAllOfCategory($event)"
                (selectInverse)="selectInverseOfCategory($event)"
                (selectAll)="selectAllBlocks()"
                (deselectAll)="clearSelection()"
                (enterSampleMode)="enterSampleMode()"
                (deleteCategory)="deleteCustomCategory($event)"
                (editCategory)="editCustomCategory($event)"
                (regexCriteriaChange)="onRegexCriteriaChange($event)"
                (regexCreate)="onRegexCreate($event)"
                (regexExpandedChange)="onRegexExpandedChange($event)"
              />
            }
          }
        </div>
      </desktop-split-pane>

      <!-- Bottom control bar: the audiobook-prep path (embedded pipeline only) -->
      @if (embedded()) {
        <app-pipeline-bar
          [stations]="pipelineStations()"
          [contextLine]="pipelineContext()"
          [primaryLabel]="pipelinePrimaryLabel()"
          [backDisabled]="pipelineStep() === 'select'"
          [busy]="pipelineBusy()"
          (back)="pipelineBack()"
          (primary)="pipelinePrimary()"
          (stationClick)="goToStation($event)"
        />
      }
    } @else if (embedded()) {
      <!-- Loading state for embedded mode -->
      <div class="embedded-loading">
        <div class="loading-spinner"></div>
        <p>Loading project...</p>
      </div>
    } @else {
      <!-- Library View when no PDF loaded (not in embedded mode) -->
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
      (restore)="onRestoreBackgroundJob($event)"
    />

    <!-- File Picker Modal (not shown in embedded mode) -->
    @if (showFilePicker() && !embedded()) {
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
        <p class="loading-hint">Large documents may take a minute</p>
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

    <!-- Split Block Popover -->
    @if (splitPopoverBlock()) {
      <div class="modal-overlay" (click)="cancelSplit()">
        <div class="split-block-popover" (click)="$event.stopPropagation()">
          <div class="split-header">Split Block</div>
          <div class="split-lines">
            @for (line of splitPopoverLines(); track $index; let i = $index) {
              @if (i > 0) {
                <div class="split-divider"
                     [class.active]="splitPopoverPoints().has(i)"
                     (click)="toggleSplitPoint(i)">
                  <span class="split-divider-line"></span>
                  <span class="split-divider-label">{{ splitPopoverPoints().has(i) ? 'split here' : 'click to split' }}</span>
                  <span class="split-divider-line"></span>
                </div>
              }
              <div class="split-line" [class.bold]="line.isBold" [class.italic]="line.isItalic">
                <span class="split-line-meta">{{ line.fontSize }}pt</span>
                {{ line.text }}
              </div>
            }
          </div>
          <div class="split-actions">
            <desktop-button variant="ghost" size="sm" (click)="cancelSplit()">Cancel</desktop-button>
            <desktop-button variant="primary" size="sm"
                            [disabled]="splitPopoverPoints().size === 0"
                            (click)="confirmSplit()">
              Split into {{ splitPopoverPoints().size + 1 }} blocks
            </desktop-button>
          </div>
        </div>
      </div>
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

    <!-- Library Save Modal -->
    @if (showLibrarySaveModal()) {
      <div class="modal-overlay" (click)="showLibrarySaveModal.set(false)">
        <div class="library-save-modal" (click)="$event.stopPropagation()">
          <div class="lsm-header">
            <h3>Save Changes</h3>
            <p>Choose how to save your edits</p>
          </div>
          <div class="lsm-options">
            <button class="lsm-option" (click)="librarySaveReplace()">
              <div class="lsm-option-icon">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M3 5a2 2 0 012-2h6l4 4v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" stroke-width="1.5" fill="none"/>
                  <path d="M7 13l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <div class="lsm-option-text">
                <span class="lsm-option-title">Replace Existing</span>
                <span class="lsm-option-desc">Overwrite the original file with your changes</span>
              </div>
            </button>
            <button class="lsm-option" (click)="librarySaveAsNew()">
              <div class="lsm-option-icon">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M3 5a2 2 0 012-2h6l4 4v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" stroke-width="1.5" fill="none"/>
                  <path d="M10 9v4M8 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="lsm-option-text">
                <span class="lsm-option-title">Save as New File</span>
                <span class="lsm-option-desc">Keep the original and create an edited copy</span>
              </div>
            </button>
          </div>
          <div class="lsm-footer">
            <desktop-button variant="ghost" (click)="showLibrarySaveModal.set(false)">
              Cancel
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
        [getPageImage]="getPageImageForOcrFn"
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

    /* Secondary pane host: one projected panel at a time via @switch */
    .secondary-pane-host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .secondary-pane-host > * {
      flex: 1;
      min-height: 0;
      display: flex;
      overflow: hidden;
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

    /* Read-only banner shown over the viewer during the EPUB review station */
    .review-banner {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
      font-size: var(--ui-font-sm);
      flex-shrink: 0;
    }
    .review-banner-icon { font-size: var(--ui-font-lg); }
    .review-banner-text { color: var(--text-primary); font-weight: 600; }
    .review-banner-hint { color: var(--text-tertiary); }

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

    .embedded-loading {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
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
      flex-shrink: 0;
      min-width: 150px;
      max-width: 400px;
      overflow: hidden;
      position: relative;
    }

    .tools-sidebar > app-task-rail {
      flex: 1;
      min-height: 0;
    }

    /* Rendering controls live in the rail footer */
    .rendering-section {
      display: flex;
      flex-direction: column;
      gap: 2px;
      border-top: 1px solid var(--border-subtle);
      padding-top: var(--ui-spacing-sm);
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

    .tools-label {
      font-size: 11px;
      font-weight: $font-weight-semibold;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      margin-bottom: 4px;
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
        color: var(--text-secondary);
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

    .loading-hint {
      margin-top: $spacing-2;
      font-size: 12px;
      color: var(--text-muted);
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
    .split-block-popover {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      width: 520px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn $duration-normal $ease-out forwards;
      overflow: hidden;

      .split-header {
        padding: $spacing-4 $spacing-4 $spacing-2;
        font-size: $font-size-lg;
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .split-lines {
        padding: $spacing-2 $spacing-4;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
      }

      .split-line {
        padding: $spacing-2 $spacing-3;
        font-size: $font-size-sm;
        color: var(--text-primary);
        line-height: 1.5;
        border-radius: $radius-sm;
        background: var(--bg-surface);
        margin: $spacing-1 0;

        &.bold { font-weight: $font-weight-bold; }
        &.italic { font-style: italic; }

        .split-line-meta {
          display: inline-block;
          font-size: 10px;
          color: var(--text-tertiary);
          margin-right: $spacing-2;
          font-weight: normal;
          font-style: normal;
        }
      }

      .split-divider {
        display: flex;
        align-items: center;
        gap: $spacing-2;
        padding: $spacing-1 0;
        cursor: pointer;
        opacity: 0.5;
        transition: opacity $duration-fast;

        &:hover { opacity: 0.8; }

        &.active {
          opacity: 1;
          .split-divider-line { border-color: var(--accent); }
          .split-divider-label { color: var(--accent); }
        }

        .split-divider-line {
          flex: 1;
          border-top: 1px dashed var(--border-default);
        }

        .split-divider-label {
          font-size: 11px;
          color: var(--text-tertiary);
          white-space: nowrap;
          user-select: none;
        }
      }

      .split-actions {
        display: flex;
        justify-content: flex-end;
        gap: $spacing-2;
        padding: $spacing-3 $spacing-4;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
      }
    }

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

    .library-save-modal {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      width: 380px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalSlideIn $duration-normal $ease-out forwards;
      overflow: hidden;

      .lsm-header {
        padding: $spacing-6 $spacing-6 $spacing-4;
        text-align: center;

        h3 {
          margin: 0 0 $spacing-1;
          font-size: $font-size-lg;
          font-weight: $font-weight-semibold;
          color: var(--text-primary);
        }

        p {
          margin: 0;
          font-size: $font-size-sm;
          color: var(--text-muted);
        }
      }

      .lsm-options {
        display: flex;
        flex-direction: column;
        gap: $spacing-2;
        padding: 0 $spacing-4 $spacing-4;
      }

      .lsm-option {
        display: flex;
        align-items: center;
        gap: $spacing-3;
        padding: $spacing-3 $spacing-4;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: $radius-md;
        cursor: pointer;
        transition: all 0.15s ease;
        text-align: left;
        color: var(--text-primary);

        &:hover {
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface));
        }

        &:active {
          transform: scale(0.99);
        }
      }

      .lsm-option-icon {
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: $radius-md;
        background: var(--bg-elevated);
        color: var(--accent);
        flex-shrink: 0;
      }

      .lsm-option-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .lsm-option-title {
        font-size: $font-size-sm;
        font-weight: $font-weight-medium;
        color: var(--text-primary);
      }

      .lsm-option-desc {
        font-size: $font-size-xs;
        color: var(--text-muted);
        line-height: 1.3;
      }

      .lsm-footer {
        display: flex;
        justify-content: center;
        padding: $spacing-3 $spacing-4;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
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

    .menu-chevron {
      margin-left: auto;
      font-size: 10px;
      color: var(--text-tertiary);
    }

    .text-layers-list {
      padding: 0 var(--ui-spacing-xs);
    }

    .text-layer-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: 3px var(--ui-spacing-sm);
      border-radius: $radius-sm;

      &:hover {
        background: var(--hover-bg);
      }
    }

    .text-layer-toggle {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      flex: 1;
      cursor: pointer;
      min-width: 0;

      input[type="checkbox"] {
        margin: 0;
        flex-shrink: 0;
      }
    }

    .text-layer-label {
      font-size: var(--ui-font-xs);
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .text-layer-count {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .text-layer-delete {
      background: none;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
      border-radius: $radius-sm;
      flex-shrink: 0;

      &:hover {
        color: var(--danger);
        background: var(--danger-subtle, rgba(255, 0, 0, 0.1));
      }
    }

    .text-layer-empty {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      font-style: italic;
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
export class PdfPickerComponent implements OnInit {
  // ─────────────────────────────────────────────────────────────────────────
  // Inputs & Outputs for embedded mode
  // ─────────────────────────────────────────────────────────────────────────

  /** When true, runs in embedded mode (inside Studio Editor tab) */
  readonly embedded = input<boolean>(false);

  /** BFP project path to auto-load when embedded */
  readonly bfpPath = input<string>('');

  /**
   * Optional: Override the source file to load when loading a BFP project.
   * This allows loading a BFP (for saved state like deletions, chapters) but
   * using a different source file (e.g., original vs exported vs cleaned EPUB).
   * When set, the BFP's source_path is ignored in favor of this path.
   */
  readonly overrideSourcePath = input<string | null>(null);

  /**
   * Optional: When set, the editor is in "library mode" — editing a standalone
   * ebook file (not a manifest project). Save shows a modal to replace or save as new.
   */
  readonly librarySourcePath = input<string | null>(null);

  /** Emitted when Finalize is clicked in embedded mode */
  readonly finalized = output<{ success: boolean; epubPath?: string; error?: string }>();

  /**
   * Tracks the source file being edited (EPUB/PDF path, not BFP).
   * When set, "Save" will write back to this file instead of creating a new export.
   */
  readonly sourceFilePath = signal<string | null>(null);

  /** Emitted when the user wants to exit embedded mode */
  readonly exitRequested = output<void>();

  // ─────────────────────────────────────────────────────────────────────────
  // Services
  // ─────────────────────────────────────────────────────────────────────────

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

  /** Unsubscribe functions for pdf:text-ready events, keyed by document ID */
  private textReadyUnsubs = new Map<string, () => void>();

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
  // Only runs in non-embedded mode to avoid corrupting main window state
  private readonly tabPersistenceEffect = effect(() => {
    // Skip in embedded mode - editor window shouldn't affect main window's tabs
    if (this.embedded()) {
      return;
    }

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

  // Task-rail UI persistence — collapsed groups only. The active panel is
  // document-scoped transient state and deliberately does NOT survive restarts
  // (restoring it would bypass activatePanel's side effects and disabled-task
  // rules). Skipped in embedded mode (the editor window must not affect the
  // main window's state). Pure UI state — MUST NOT touch hasUnsavedChanges.
  private readonly RAIL_STATE_KEY = 'bookforge-task-rail';
  private readonly railPersistenceEffect = effect(() => {
    if (this.embedded()) {
      return;
    }
    const collapsedGroups = [...this.collapsedGroups()];
    try {
      localStorage.setItem(
        this.RAIL_STATE_KEY,
        JSON.stringify({ collapsedGroups })
      );
    } catch {
      // Ignore localStorage errors
    }
  });

  // Tab restoration is now handled in ngOnInit() to ensure inputs are properly bound
  // This prevents race conditions where embedded() returns false before Angular sets the input

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

  // Global OCR job completion callback (stored as a stable reference so it can
  // be unregistered on destroy)
  private readonly ocrJobCompleteCallback = (job: OcrJob): void => {
    // Convert OcrJobResult to OcrPageResult and process
    const results: OcrPageResult[] = job.results.map(r => ({
      page: r.page,
      text: r.text,
      confidence: r.confidence,
      textLines: r.textLines
    }));
    if (results.length > 0) {
      this.onOcrCompleted(results);
    }
  };

  // Register global OCR job completion handler
  private readonly ocrJobCompletionHandler = (() => {
    this.ocrJobService.onJobComplete(this.ocrJobCompleteCallback);
  })();

  // Component teardown — release event subscriptions, timers, and global callbacks
  private readonly destroyCleanup = (() => {
    this.destroyRef.onDestroy(() => {
      // Unsubscribe all pending pdf:text-ready listeners
      for (const unsub of this.textReadyUnsubs.values()) {
        unsub();
      }
      this.textReadyUnsubs.clear();

      // Clear pending timers
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = null;
      }
      if (this.regexDebounceTimer) {
        clearTimeout(this.regexDebounceTimer);
        this.regexDebounceTimer = null;
      }
      if (this.pulseTimer) {
        clearTimeout(this.pulseTimer);
        this.pulseTimer = null;
      }
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
      }

      // Unregister the global OCR completion callback so the destroyed
      // component isn't retained and invoked against stale state
      this.ocrJobService.offJobComplete(this.ocrJobCompleteCallback);
    });
  })();

  @ViewChild(PdfViewerComponent) pdfViewer!: PdfViewerComponent;
  @ViewChild(CleanupPanelComponent) cleanupPanel?: CleanupPanelComponent;
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

  // Computed: Check if current document is an EPUB (not a PDF)
  readonly isCurrentDocumentEpub = computed(() => {
    const name = this.pdfName();
    return name.toLowerCase().endsWith('.epub');
  });

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
  // Block IDs that were split (for hiding originals in pdf-viewer)
  readonly splitOriginalBlockIds = computed(() => new Set(this.editorState.blockSplits().keys()));
  // Block IDs that were merged into larger blocks (for hiding sources in pdf-viewer)
  readonly mergeSourceBlockIds = computed(() => {
    const ids = new Set<string>();
    for (const def of this.editorState.blockMerges().values()) {
      for (const srcId of def.sourceBlockIds) {
        ids.add(srcId);
      }
    }
    return ids;
  });
  // Text layer management
  readonly textLayersExpanded = signal(false);
  readonly showPdfTextLayer = signal(true);
  readonly showOcrTextLayer = signal(true);
  // Show text layer overlay — true when panel is expanded (viewer uses layer filters)
  readonly showTextLayer = computed(() => this.textLayersExpanded());
  // Computed text layer info — counts ALL blocks including soft-deleted ones
  readonly textLayers = computed(() => {
    const blocks = this.blocks();
    let pdfCount = 0;
    let ocrCount = 0;
    for (const b of blocks) {
      if (b.is_image) continue;
      if (b.is_ocr) ocrCount++;
      else pdfCount++;
    }
    const layers: Array<{ id: string; label: string; count: number; visible: boolean }> = [];
    if (pdfCount > 0 || ocrCount === 0) {
      layers.push({ id: 'pdf', label: 'PDF Text', count: pdfCount, visible: this.showPdfTextLayer() });
    }
    if (ocrCount > 0) {
      layers.push({ id: 'ocr', label: 'OCR Text', count: ocrCount, visible: this.showOcrTextLayer() });
    }
    return layers;
  });
  // Blocks filtered by text layer visibility — used for the right panel
  readonly textLayerFilteredBlocks = computed(() => {
    const allBlocks = this.blocks();
    if (!this.textLayersExpanded()) return allBlocks;
    const showPdf = this.showPdfTextLayer();
    const showOcr = this.showOcrTextLayer();
    if (showPdf && showOcr) return allBlocks;
    return allBlocks.filter(b => {
      if (b.is_image) return true;
      if (b.is_ocr) return showOcr;
      return showPdf;
    });
  });
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

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle Hooks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize component - handles embedded mode auto-loading and tab restoration
   */
  ngOnInit(): void {
    if (this.embedded() && this.bfpPath()) {
      // Embedded mode - load the specified project
      const filePath = this.bfpPath();

      // Determine how to load based on path type
      setTimeout(async () => {
        const manifestExists = await this.electronService.fsExists(filePath + '/manifest.json');
        if (manifestExists) {
          this.loadProjectFromPath(filePath);
        } else {
          this.loadPdf(filePath);
        }
      }, 0);
    } else if (!this.embedded()) {
      // Non-embedded mode - restore open tabs from localStorage
      // This must be in ngOnInit to ensure embedded() input is properly bound
      this.restoreRailState();
      setTimeout(() => this.restoreOpenTabs(), 0);
    }
  }

  /**
   * Restore persisted rail UI state (collapsed groups only — the active panel
   * is transient by design). Absence is a legitimate first run; malformed JSON
   * is discarded loudly.
   */
  private restoreRailState(): void {
    const raw = localStorage.getItem(this.RAIL_STATE_KEY);
    if (raw === null) return;
    let parsed: { collapsedGroups?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('[task-rail] Discarding malformed persisted state:', err);
      return;
    }
    if (Array.isArray(parsed.collapsedGroups)) {
      this.collapsedGroups.set(new Set(parsed.collapsedGroups.filter((g): g is string => typeof g === 'string')));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Zoom & Layout
  // ─────────────────────────────────────────────────────────────────────────

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
  /** True when the event target is a text-entry element (input/textarea/contenteditable) */
  private isTextInputTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable);
  }

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

    // Ctrl/Cmd + Z for undo, Ctrl/Cmd + Shift + Z for redo
    // (key is 'Z' when shift is held, so compare case-insensitively)
    // Skip when typing in an input/textarea/contenteditable so the browser's
    // own text undo isn't hijacked by document undo
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z'
        && !this.isTextInputTarget(event.target)) {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    }

    // Ctrl/Cmd + Y for redo (alternative)
    if ((event.metaKey || event.ctrlKey) && event.key === 'y'
        && !this.isTextInputTarget(event.target)) {
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

    // Ctrl/Cmd + E for export (not while typing in a field)
    if ((event.metaKey || event.ctrlKey) && event.key === 'e'
        && !this.isTextInputTarget(event.target)) {
      event.preventDefault();
      if (this.pdfLoaded()) {
        this.showExportSettings.set(true);
      }
    }

    // Ctrl/Cmd + Shift + S for Save EPUB As
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'S') {
      event.preventDefault();
      this.saveEpubAs();
    }

    // Ctrl/Cmd + F for search
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      if (this.pdfLoaded()) {
        this.toggleSearch();
      }
    }

    // Escape closes the search bar first, otherwise closes the active panel.
    if (event.key === 'Escape') {
      if (this.showSearch()) {
        event.preventDefault();
        this.closeSearch();
        return;
      }
      if (this.activePanel() !== null) {
        event.preventDefault();
        this.activatePanel(null);
        return;
      }
    }

    // Task/pointer shortcuts (single keys, no modifiers). Never hijack typing.
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !this.isTextInputTarget(event.target)) {
      const key = event.key.toLowerCase();

      // Digits 1..7 activate the task in that rail slot (active task's digit closes it).
      if (key >= '1' && key <= '7') {
        const taskId = TASK_ORDER[Number(key) - 1];
        if (taskId && !this.disabledTasks().has(taskId)) {
          event.preventDefault();
          this.onRailPanelClick(taskId);
        }
        return;
      }

      switch (key) {
        case 's': // Pointer: select
          event.preventDefault();
          this.viewerInteraction.set('select');
          break;
        case 'e': // Pointer: edit
          event.preventDefault();
          this.viewerInteraction.set('edit');
          break;
        case 'a': // Analysis & search
          event.preventDefault();
          this.onRailPanelClick('analysis');
          break;
      }
    }
  }

  onSplitSizeChanged(size: number): void {
    this.splitSize.set(size);
    this.userResizedSplit = true; // User manually adjusted, stop auto-resizing
  }

  // Tools sidebar resize handlers
  private sidebarResizeCleanup: (() => void) | null = null;

  onSidebarResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizingSidebar = true;
    this.sidebarResizeStartX = event.clientX;
    this.sidebarResizeStartWidth = this.toolsSidebarWidth();
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    // Cleanup function
    this.sidebarResizeCleanup = () => {
      document.removeEventListener('mousemove', this.onSidebarResizeMove);
      document.removeEventListener('mouseup', this.onSidebarResizeEnd);
      document.removeEventListener('pointerup', this.onSidebarResizeEnd);
      document.removeEventListener('mouseleave', this.onSidebarMouseLeave);
      document.removeEventListener('visibilitychange', this.onSidebarVisibilityChange);
      window.removeEventListener('blur', this.onSidebarResizeEnd);
    };

    // Add document-level listeners for smooth dragging
    document.addEventListener('mousemove', this.onSidebarResizeMove);
    document.addEventListener('mouseup', this.onSidebarResizeEnd);
    document.addEventListener('pointerup', this.onSidebarResizeEnd);
    document.addEventListener('mouseleave', this.onSidebarMouseLeave);
    document.addEventListener('visibilitychange', this.onSidebarVisibilityChange);
    window.addEventListener('blur', this.onSidebarResizeEnd);
  }

  private onSidebarResizeMove = (event: MouseEvent): void => {
    if (!this.isResizingSidebar) return;

    const delta = event.clientX - this.sidebarResizeStartX;
    const newWidth = Math.max(150, Math.min(400, this.sidebarResizeStartWidth + delta));
    this.toolsSidebarWidth.set(newWidth);
  };

  private onSidebarResizeEnd = (): void => {
    if (this.sidebarResizeCleanup) {
      this.sidebarResizeCleanup();
      this.sidebarResizeCleanup = null;
    }
    this.isResizingSidebar = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  private onSidebarMouseLeave = (e: MouseEvent): void => {
    if (e.relatedTarget === null) this.onSidebarResizeEnd();
  };

  private onSidebarVisibilityChange = (): void => {
    if (document.hidden) this.onSidebarResizeEnd();
  };

  readonly showFilePicker = signal(false);
  readonly showExportSettings = signal(false);
  readonly loading = signal(false);
  readonly loadingText = signal('Loading...');
  readonly lightweightMode = signal(false);  // Process without rendering pages

  // Pipeline state (embedded mode: Select → Chapters → EPUB Review)
  readonly pipelineStep = signal<PipelineStep>('select');
  private pipelineTransitioning = false; // guard to prevent reset during transitions

  // ── Bottom-bar station model ──────────────────────────────────────────────
  // The required path is Remove blocks → Mark chapters → Review. 'select' is
  // visited from the start. Returning to an editable station after a generate
  // clears the 'epub-review' visit (the output is now stale → must regenerate).
  readonly visitedStations = signal<Set<PipelineStep>>(new Set<PipelineStep>(['select']));

  /** True while showing the read-only generated EPUB for final approval. */
  readonly reviewMode = computed(() => this.pipelineStep() === 'epub-review');

  /** Busy spinner state for the bottom bar during generate/reload/save. */
  readonly pipelineBusy = signal(false);

  private readonly pipelineStationMeta: Record<PipelineStep, { label: string; context: string }> = {
    'select':      { label: 'Remove blocks', context: 'Delete anything you don’t want in the audiobook.' },
    'chapters':    { label: 'Mark chapters', context: 'Mark where each chapter begins — most books auto-detect.' },
    'epub-review': { label: 'Review',        context: 'The final text for TTS. Approve, or go back to fix.' },
  };

  /** Whether the review station is reachable yet (both edit stations visited). */
  private canReachReview(): boolean {
    const v = this.visitedStations();
    return v.has('select') && v.has('chapters');
  }

  /** Chips for the bottom bar, in path order, with per-station state. */
  readonly pipelineStations = computed<PipelineStation[]>(() => {
    const order: PipelineStep[] = ['select', 'chapters', 'epub-review'];
    const current = this.pipelineStep();
    const visited = this.visitedStations();
    const canReview = this.canReachReview();
    return order.map(id => {
      let state: PipelineStation['state'];
      if (id === current) state = 'current';
      else if (visited.has(id)) state = 'done';
      else if (id === 'epub-review' && !canReview) state = 'locked';
      else state = 'todo';
      return { id, label: this.pipelineStationMeta[id].label, state };
    });
  });

  readonly pipelineContext = computed(() => this.pipelineStationMeta[this.pipelineStep()].context);

  readonly pipelinePrimaryLabel = computed(() => {
    switch (this.pipelineStep()) {
      case 'select':      return 'Next → Mark chapters';
      case 'chapters':    return 'Generate & review';
      case 'epub-review': return 'Approve & finish ✓';
    }
  });

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

  // Regex category builder state. The builder owns the FORM; the shell keeps
  // only: whether the regex overlay is active (drives the viewer + highlights),
  // the single criteria object the builder emits, the criteria pushed down to
  // trigger an edit-load, the id being edited, and the live match results.
  readonly regexPanelExpanded = signal(false);
  readonly regexCriteria = signal<RegexCriteria>(defaultRegexCriteria());
  readonly regexEditCriteria = signal<RegexCriteria | null>(null);  // non-null → builder loads it
  readonly editingCategoryId = signal<string | null>(null);  // ID of category being edited, null = creating new
  readonly focusedCategoryId = signal<string | null>(null);  // Last clicked custom category (for keyboard delete)
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
  readonly showLibrarySaveModal = signal(false);

  // Split block popover state
  readonly splitPopoverBlock = signal<TextBlock | null>(null);
  readonly splitPopoverLines = signal<Array<{
    text: string; y: number; height: number;
    isBold: boolean; isItalic: boolean; fontSize: number;
    fontName: string;
    spans: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; font_name: string; is_bold: boolean; is_italic: boolean }>;
  }>>([]);
  readonly splitPopoverPoints = signal<Set<number>>(new Set());

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

  // ─────────────────────────────────────────────────────────────────────────
  // Analysis Results
  // ─────────────────────────────────────────────────────────────────────────
  readonly analysisFlags = signal<Array<{
    categoryId: string;
    categoryName: string;
    categoryColor: string;
    quote: string;
    description: string;
    severity: 'low' | 'medium' | 'high';
    chapterId: string;
    chapterTitle: string;
    page?: number;  // Matched PDF page (if found)
  }>>([]);
  readonly analysisCategories = signal<Array<{
    id: string;
    name: string;
    color: string;
    enabled: boolean;
    flagCount: number;
  }>>([]);
  readonly pendingAnalysisMatch = signal(false);
  // Separate category records for analysis highlights (not shown in categories list)
  readonly analysisHighlightCategories = signal<Record<string, any>>({});
  // Index of the selected/scrolled-to flag in the sidebar
  readonly selectedAnalysisFlagIndex = signal<number>(-1);

  // Pulse highlight rects — temporary pulsing overlays shown when navigating to a flag or search result
  readonly pulseHighlightRects = signal<Array<{ page: number; x: number; y: number; w: number; h: number; color: string }>>([]);
  private pulseTimer: any = null;

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

  /** Get blocks for export, filtering out blocks whose category is disabled */
  private getExportableBlocks(): TextBlock[] {
    const categories = this.categories();
    const allBlocks = this.blocks();
    return allBlocks.filter(b => {
      const cat = categories[b.category_id];
      return !cat || cat.enabled !== false;
    });
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
    const analysisHighlightCats = this.analysisHighlightCategories();
    const filtered = new Map<string, Record<number, MatchRect[]>>();
    for (const [categoryId, pageHighlights] of base) {
      // Check both regular categories and analysis highlight categories
      const cat = categories[categoryId] || analysisHighlightCats[categoryId];
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
    const analysisHighlightCats = this.analysisHighlightCategories();

    // Merge analysis highlight categories (needed for viewer to resolve colors)
    const merged = Object.keys(analysisHighlightCats).length > 0
      ? { ...base, ...analysisHighlightCats }
      : base;

    // If regex modal isn't open, just return merged categories
    if (!this.regexPanelExpanded() || this.regexMatches().length === 0) {
      return merged;
    }

    // Add the preview category
    return {
      ...merged,
      '__regex_preview__': {
        id: '__regex_preview__',
        name: 'Regex Preview',
        description: 'Live preview of regex matches',
        color: this.regexCriteria().color,
        block_count: this.regexMatchCount(),
        char_count: 0,
        font_size: 0,
        region: '',
        sample_text: '',
        enabled: true
      }
    };
  });

  /**
   * Load analysis results from stages/04-analysis/analysis.json
   * Called after a project is loaded to display content flags in the sidebar.
   * Also matches flagged quotes to PDF text positions for highlighting.
   */
  async loadAnalysisResults(projectDir: string): Promise<void> {
    console.log('[Analysis] Loading analysis results for:', projectDir);
    const analysisPath = `${projectDir}/stages/04-analysis/analysis.json`;
    const checkpointPath = `${projectDir}/stages/04-analysis/analysis-progress.json`;

    // Try completed report first, fall back to in-progress checkpoint
    let activePath = analysisPath;
    let exists = await this.electronService.fsExists(analysisPath);
    if (!exists) {
      exists = await this.electronService.fsExists(checkpointPath);
      activePath = checkpointPath;
    }
    if (!exists) {
      console.log('[Analysis] No analysis file found at', analysisPath, 'or', checkpointPath);
      this.analysisFlags.set([]);
      this.analysisCategories.set([]);
      return;
    }
    console.log('[Analysis] Found analysis file:', activePath);

    try {
      const content = await this.electronService.readTextFile(activePath);
      if (!content) return;
      const report = JSON.parse(content);

      if (!report.flags || !Array.isArray(report.flags)) {
        return;
      }

      // Build category summary with flag counts
      const categoryCounts = new Map<string, number>();
      for (const flag of report.flags) {
        categoryCounts.set(flag.categoryId, (categoryCounts.get(flag.categoryId) || 0) + 1);
      }

      // For checkpoint files, categories aren't stored — build from the default set
      // by inferring from flags. For completed reports, use the stored categories.
      let rawCategories: Array<{ id: string; name: string; color: string }>;
      if (report.categories && Array.isArray(report.categories)) {
        rawCategories = report.categories;
      } else {
        // Build from flags — use categoryId as both id and name
        const categoryIds = new Set<string>(report.flags.map((f: any) => f.categoryId as string));
        const defaultColors: Record<string, { name: string; color: string }> = {
          thought_control: { name: 'Thought Control', color: '#E53935' },
          information_control: { name: 'Information Control', color: '#1565C0' },
          us_vs_them: { name: 'Us vs. Them', color: '#FB8C00' },
          fear_manipulation: { name: 'Fear & Doom', color: '#7B1FA2' },
          loaded_language: { name: 'Loaded Language', color: '#00838F' },
          emotional_manipulation: { name: 'Emotional Manipulation', color: '#C62828' },
          authority_claims: { name: 'Authority Claims', color: '#4527A0' },
          historical_revisionism: { name: 'Historical Revisionism', color: '#2E7D32' },
          scapegoating: { name: 'Scapegoating', color: '#D84315' },
          violence_glorification: { name: 'Violence & Extremism', color: '#B71C1C' },
          false_prophecy: { name: 'False Prophecy', color: '#8E24AA' },
          shunning: { name: 'Shunning & Isolation', color: '#6D4C41' },
        };
        rawCategories = Array.from(categoryIds).map((id: string) => ({
          id,
          name: defaultColors[id]?.name || id,
          color: defaultColors[id]?.color || '#888',
        }));
      }

      const categories = rawCategories.map((cat: any) => ({
        id: cat.id,
        name: cat.name,
        color: cat.color,
        enabled: true,
        flagCount: categoryCounts.get(cat.id) || 0,
      }));
      this.analysisCategories.set(categories);

      // Build flag list with category metadata
      const categoryMap = new Map(categories.map((c: any) => [c.id, c]));
      const flags = report.flags.map((flag: any) => {
        const cat = categoryMap.get(flag.categoryId) as any;
        return {
          categoryId: flag.categoryId,
          categoryName: cat?.name || flag.categoryId,
          categoryColor: cat?.color || '#888',
          quote: flag.quote,
          description: flag.description,
          severity: flag.severity,
          chapterId: flag.chapterId,
          chapterTitle: flag.chapterTitle,
        };
      });
      this.analysisFlags.set(flags);
      console.log(`[Analysis] Loaded ${flags.length} flags across ${categories.length} categories`);

      // Auto-enter analysis mode when flags are loaded
      if (flags.length > 0) {
        this.activatePanel('analysis');
      }

      // Match flagged quotes to PDF text positions (defer if text not ready)
      const isTextLoading = this.editorState.textLoading();
      console.log(`[Analysis] textLoading=${isTextLoading}, will ${isTextLoading ? 'DEFER' : 'RUN NOW'} matchAnalysisFlagsToPdf`);
      if (isTextLoading) {
        this.pendingAnalysisMatch.set(true);
      } else {
        await this.matchAnalysisFlagsToPdf(flags, categories);
      }

    } catch (err) {
      console.error('[Analysis] Failed to load analysis results:', err);
    }
  }

  /**
   * Match analysis flag quotes to PDF text for highlighting and page navigation.
   * Strategy: try span-level matching first (precise highlights), fall back to block-level
   * matching (block-rect highlights) for quotes that don't match spans exactly.
   */
  private async matchAnalysisFlagsToPdf(
    flags: Array<{ categoryId: string; quote: string; categoryColor: string; categoryName: string }>,
    categories: Array<{ id: string; name: string; color: string }>
  ): Promise<void> {
    console.log('[Analysis] matchAnalysisFlagsToPdf called with', flags.length, 'flags and', categories.length, 'categories');

    // Add analysis categories to a separate record for highlight rendering only
    const analysisHighlightCategories: Record<string, any> = {};
    for (const cat of categories) {
      const catId = `analysis_${cat.id}`;
      analysisHighlightCategories[catId] = {
        id: catId,
        name: `[Analysis] ${cat.name}`,
        description: `Content analysis: ${cat.name}`,
        color: cat.color,
        block_count: 0,
        char_count: 0,
        font_size: 0,
        region: 'analysis',
        sample_text: '',
        enabled: true,
      };
    }

    // Build two search indices:
    // 1. Span-based (precise character-level rects for highlighting)
    // 2. Block-based (paragraph-level fallback for page navigation + block highlighting)

    // --- Span index ---
    const rawSpans = await this.electronService.getSpans();
    const pageSpanTexts = new Map<number, { text: string; offsets: Array<{ start: number; end: number; span: { x: number; y: number; width: number; height: number; text: string; page: number } }> }>();

    if (rawSpans && rawSpans.length > 0) {
      console.log('[Analysis] Got', rawSpans.length, 'raw spans');
      // Group spans by page, sorted by reading order
      const spansByPage = new Map<number, typeof rawSpans>();
      for (const span of rawSpans) {
        if (!spansByPage.has(span.page)) spansByPage.set(span.page, []);
        spansByPage.get(span.page)!.push(span);
      }
      for (const [, pageSpans] of spansByPage) {
        pageSpans.sort((a, b) => {
          const yDiff = Math.abs(a.y - b.y);
          if (yDiff > 5) return a.y - b.y;
          return a.x - b.x;
        });
      }
      // Concatenate spans per page
      for (const [pageNum, pageSpans] of spansByPage) {
        let text = '';
        const offsets: Array<{ start: number; end: number; span: { x: number; y: number; width: number; height: number; text: string; page: number } }> = [];
        for (const span of pageSpans) {
          if (!span.text || span.text.length === 0) continue;
          const start = text.length;
          text += span.text + ' ';
          offsets.push({ start, end: start + span.text.length, span });
        }
        pageSpanTexts.set(pageNum, { text, offsets });
      }
    } else {
      console.log('[Analysis] No spans available from getSpans()');
    }

    // --- Block index ---
    const blocks = this.blocks();
    const pageBlockTexts = new Map<number, { text: string; offsets: Array<{ start: number; end: number; block: TextBlock }> }>();
    for (const block of blocks) {
      if (!block.text || block.text.trim().length === 0) continue;
      if (!pageBlockTexts.has(block.page)) {
        pageBlockTexts.set(block.page, { text: '', offsets: [] });
      }
      const entry = pageBlockTexts.get(block.page)!;
      const start = entry.text.length;
      entry.text += block.text + ' ';
      entry.offsets.push({ start, end: start + block.text.length, block });
    }
    console.log(`[Analysis] Block index: ${pageBlockTexts.size} pages, ${blocks.length} blocks`);

    const updatedHighlights = new Map(this.categoryHighlights());
    let spanMatches = 0;
    let blockMatches = 0;
    const flagPages = new Map<number, number>();

    for (let flagIdx = 0; flagIdx < flags.length; flagIdx++) {
      const flag = flags[flagIdx];
      const catId = `analysis_${flag.categoryId}`;

      // Truncate quote before escaping to avoid splitting mid-escape
      const maxQuoteLen = 150;
      const quoteToMatch = flag.quote.length > maxQuoteLen
        ? flag.quote.substring(0, maxQuoteLen)
        : flag.quote;

      const escaped = quoteToMatch
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');

      let regex: RegExp;
      try {
        regex = new RegExp(escaped, 'gi');
      } catch {
        continue;
      }

      let matched = false;

      // Try span-level matching first (precise highlighting)
      if (pageSpanTexts.size > 0) {
        for (const [pageNum, { text, offsets }] of pageSpanTexts) {
          regex.lastIndex = 0;
          const match = regex.exec(text);
          if (!match) continue;

          const matchStart = match.index;
          const matchEnd = matchStart + match[0].length;
          const matchingSpans = offsets.filter(o => o.start < matchEnd && o.end > matchStart);
          if (matchingSpans.length === 0) continue;

          if (!updatedHighlights.has(catId)) updatedHighlights.set(catId, {});
          const pageMap = updatedHighlights.get(catId)!;
          if (!pageMap[pageNum]) pageMap[pageNum] = [];

          // Merge matching spans into line-level rects
          let currentRect: { x: number; y: number; w: number; h: number; text: string } | null = null;
          for (const { span } of matchingSpans) {
            if (currentRect && Math.abs(span.y - currentRect.y) < 5) {
              const right = Math.max(currentRect.x + currentRect.w, span.x + span.width);
              currentRect.w = right - currentRect.x;
              currentRect.h = Math.max(currentRect.h, span.height);
              currentRect.text += span.text;
            } else {
              if (currentRect) pageMap[pageNum].push({ page: pageNum, ...currentRect });
              currentRect = { x: span.x, y: span.y, w: span.width, h: span.height, text: span.text };
            }
          }
          if (currentRect) pageMap[pageNum].push({ page: pageNum, ...currentRect });

          flagPages.set(flagIdx, pageNum);
          spanMatches++;
          matched = true;
          break;
        }
      }

      // Fallback: block-level matching (use block bounding rect as highlight)
      if (!matched) {
        for (const [pageNum, { text, offsets }] of pageBlockTexts) {
          regex.lastIndex = 0;
          const match = regex.exec(text);
          if (!match) continue;

          const matchStart = match.index;
          const matchEnd = matchStart + match[0].length;
          const matchingBlocks = offsets.filter(o => o.start < matchEnd && o.end > matchStart);
          if (matchingBlocks.length === 0) continue;

          if (!updatedHighlights.has(catId)) updatedHighlights.set(catId, {});
          const pageMap = updatedHighlights.get(catId)!;
          if (!pageMap[pageNum]) pageMap[pageNum] = [];

          for (const { block } of matchingBlocks) {
            pageMap[pageNum].push({
              page: pageNum,
              x: block.x,
              y: block.y,
              w: block.width,
              h: block.height,
              text: block.text.substring(0, 100),
            });
          }

          flagPages.set(flagIdx, pageNum);
          blockMatches++;
          matched = true;
          break;
        }
      }
    }

    console.log(`[Analysis] Matched ${spanMatches + blockMatches}/${flags.length} flags (${spanMatches} span-level, ${blockMatches} block-level)`);

    // Store analysis categories separately for highlight rendering
    this.analysisHighlightCategories.set(analysisHighlightCategories);
    this.categoryHighlights.set(updatedHighlights);

    // Update analysisFlags with matched page numbers for navigation
    if (flagPages.size > 0) {
      const currentFlags = this.analysisFlags();
      const updatedFlags = currentFlags.map((f, i) => {
        const matchedPage = flagPages.get(i);
        return matchedPage !== undefined ? { ...f, page: matchedPage } : f;
      });
      this.analysisFlags.set(updatedFlags);
    }
  }

  // Task/panel state. `activePanel` is the single source of truth for the
  // right pane and viewer overlay; `viewerInteraction` is the pointer mode
  // (select/edit), independent of which task panel is open.
  readonly activePanel = signal<PanelId | null>(null);   // null = default panel (cleanup)
  readonly viewerInteraction = signal<'select' | 'edit'>('select');

  // Task groups for the rail (static; TASK_ORDER drives digit shortcuts).
  readonly taskGroups = TASK_GROUPS;

  // Collapsed rail groups (persisted; see rail persistence effect).
  readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  // Viewer editor mode: crop/split when those panels are active, else the
  // current pointer interaction (select/edit).
  readonly viewerEditorMode = computed<string>(() => {
    const panel = this.activePanel();
    if (panel === 'crop') return 'crop';
    if (panel === 'split') return 'split';
    return this.viewerInteraction();
  });

  // The rail is hidden only while reviewing the exported EPUB; it is fully
  // usable at both editable stations (select AND chapters) in embedded mode.
  readonly showToolbox = computed(() => this.pipelineStep() !== 'epub-review');

  // Crop mode state (derived from activePanel)
  readonly cropMode = computed(() => this.activePanel() === 'crop');
  readonly cropCurrentPage = signal(0);
  readonly currentCropRect = signal<CropRect | null>(null);
  private previousLayout: 'vertical' | 'grid' = 'grid';

  // Per-page crop rectangles for the viewer's persistent crop mask (display
  // only). Derived from the durable cropRegions source of truth.
  readonly cropRegionRects = computed<Map<number, { x: number; y: number; width: number; height: number }>>(() => {
    const out = new Map<number, { x: number; y: number; width: number; height: number }>();
    for (const [page, region] of this.editorState.cropRegions()) {
      out.set(page, region.rect);
    }
    return out;
  });

  // Split mode state (for scanned book pages)
  readonly splitMode = computed(() => this.activePanel() === 'split');
  readonly splitConfig = signal<SplitConfig>({
    enabled: false,
    oddPageSplit: 0.5,
    evenPageSplit: 0.5,
    pageOverrides: {},
    skippedPages: new Set<number>(),
    readingOrder: 'left-to-right'
  });
  // True only after the user explicitly applied the split this session.
  // Entering the split panel auto-enables splitConfig, so `enabled` alone is
  // not evidence of applied work — this flag keeps the rail status factual.
  readonly splitApplied = signal(false);
  readonly splitPreviewPage = signal(0);  // Page being previewed in split mode
  readonly isDraggingSplit = signal(false);
  readonly deskewing = signal(false);
  readonly lastDeskewAngle = signal<number | null>(null);

  // Analysis mode state
  readonly analysisMode = computed(() => this.activePanel() === 'analysis');

  // Paragraph mode state
  readonly paragraphMode = computed(() => this.activePanel() === 'paragraphs');
  readonly paragraphDetectionStats = signal<DetectionStats | null>(null);
  readonly paragraphDetectionConfig = signal<DetectionConfig | null>(null);
  readonly paragraphBaselines = signal<DocumentBaselines | null>(null);
  private userDetectionConfig: DetectionConfig | null = null;

  // Paragraph fix mode — entered after save to auto-detect and fix paragraph breaks
  readonly paragraphFixMode = signal(false);
  readonly paragraphFixEpubPath = signal<string | null>(null);

  // Chapters mode state
  readonly chaptersMode = computed(() => this.activePanel() === 'chapters');
  readonly chapters = signal<Chapter[]>([]);
  readonly chaptersSource = signal<'toc' | 'heuristic' | 'manual' | 'mixed'>('manual');
  readonly detectingChapters = signal(false);
  readonly finalizingChapters = signal(false);
  readonly selectedChapterId = signal<string | null>(null);

  // TOC mode state (sub-mode within chapters mode)
  readonly tocMode = signal(false);
  readonly tocBlockIds = signal<string[]>([]);
  readonly tocSelectedBlockIdSet = computed(() => new Set(this.tocBlockIds()));
  readonly tocStep = signal<'blocks' | 'lines'>('blocks');
  readonly tocLines = signal<TocLine[]>([]);
  readonly tocCheckedIndexes = signal<Set<number>>(new Set());

  // Book metadata for EPUB export
  readonly metadata = signal<BookMetadata>({});

  // Original created_at of the loaded project (preserved across saves; per-document,
  // saved/restored on tab switch via OpenDocument.createdAt)
  private projectCreatedAt: string | null = null;

  // Page deletion - delegate to editor state (has undo/redo support)
  get deletedPages() { return this.editorState.deletedPages; }

  // Organize mode state (page selection, deletion, reordering). Active on the
  // default/cleanup/merge/OCR panels — i.e. any panel that does not commandeer
  // the pointer (crop/split/chapters/paragraphs/analysis do).
  readonly organizeMode = computed(() => {
    const panel = this.activePanel();
    return panel === null || panel === 'ocr' || panel === 'cleanup' || panel === 'merge';
  });
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
    const isEmbedded = this.embedded();

    // In embedded mode, don't show "Open File" button
    const baseItems: ToolbarItem[] = isEmbedded ? [] : [
      { id: 'open', type: 'button', icon: '📂', label: 'Open File', tooltip: 'Open PDF file' },
    ];

    // Items only shown when PDF is open
    if (pdfIsOpen) {
      const inFixMode = this.paragraphFixMode();

      // In paragraph fix mode, show "Done" instead of normal save/export.
      // The embedded audiobook-prep path (Back / Next / Generate / Approve) now
      // lives in the bottom control bar, not the top toolbar — both embedded and
      // standalone keep just Export up here.
      const actionItems: ToolbarItem[] = inFixMode
        ? [
            { id: 'finishParagraphFix', type: 'button', icon: '✓', label: 'Done', tooltip: 'Save paragraph corrections and finish' },
          ]
        : [
            { id: 'export', type: 'button', icon: '📤', label: 'Export', tooltip: 'Export document (Cmd+E)' },
          ];

      return [
        ...baseItems,
        ...actionItems,
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


  // ─────────────────────────────────────────────────────────────────────────
  // Task rail derivation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * One shared, memoized status map for every task. Reads only always-present
   * signals; the block-iterating derivations (OCR, cleanup) run once here and
   * are cached until a dependency changes — no per-render loops.
   */
  readonly taskStatuses = computed<Map<TaskId, TaskStatus>>(() => {
    const blocks = this.blocks();
    const deletedBlockIds = this.deletedBlockIds();
    const categories = this.categories();
    const splitConfig = this.splitConfig();
    return deriveAllTaskStatuses({
      crop: { croppedPageCount: this.editorState.cropRegions().size },
      split: {
        applied: this.splitApplied(),
        enabled: splitConfig.enabled,
        skippedCount: splitConfig.skippedPages.size,
        pageDimensions: this.pageDimensions(),
      },
      ocr: { blocks, deletedBlockIds, totalPages: this.totalPages() },
      cleanup: { blocks, deletedBlockIds, categories },
      mergeCount: this.editorState.blockMerges().size,
      chapterCount: this.chapters().length,
      chaptersSource: this.chaptersSource(),
      paragraphBreakCount: this.editorState.paragraphBreaks().size,
    });
  });

  /**
   * Tasks disabled for the current document/context, mapped to a factual
   * reason (same rules the old toolbox enforced): EPUB has no crop/split/ocr;
   * lightweight mode allows only OCR; paragraphs are unavailable while
   * reviewing the exported EPUB.
   */
  readonly disabledTasks = computed<Map<TaskId, string>>(() => {
    const disabled = new Map<TaskId, string>();
    const isEpub = this.isCurrentDocumentEpub();
    const lightweight = this.lightweightMode();
    const step = this.pipelineStep();
    for (const id of TASK_ORDER) {
      if (isEpub && (id === 'crop' || id === 'split' || id === 'ocr')) {
        disabled.set(id, 'PDF only — not available for EPUB');
        continue;
      }
      if (lightweight && id !== 'ocr') {
        disabled.set(id, 'Not available in lightweight mode');
        continue;
      }
      if (step === 'epub-review' && id === 'paragraphs') {
        disabled.set(id, 'Not available while reviewing the exported EPUB');
        continue;
      }
    }
    return disabled;
  });

  /** OCR task status, for the OCR panel (invariant: always derived). */
  readonly ocrStatus = computed<TaskStatus>(() => {
    const status = this.taskStatuses().get('ocr');
    if (!status) {
      throw new Error('taskStatuses is missing the ocr entry');
    }
    return status;
  });

  /** Count of pages with no live text block, for the OCR panel. */
  readonly ocrPagesWithoutText = computed(() =>
    countPagesWithoutText({
      blocks: this.blocks(),
      deletedBlockIds: this.deletedBlockIds(),
      totalPages: this.totalPages(),
    })
  );

  /** True while an OCR job is queued or running. */
  readonly ocrJobRunning = computed(() =>
    this.ocrJobService.jobs().some(
      j => j.status === 'running' || j.status === 'queued' || j.status === 'pending'
    )
  );

  // Computed values
  readonly visibleBlocks = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks().filter(b => !deleted.has(b.id));
  });

  readonly categoriesArray = computed(() => {
    return Object.values(this.categories()).sort((a, b) => b.char_count - a.char_count);
  });

  readonly computedBaselines = computed(() => {
    const blocks = this.blocks();
    if (blocks.length === 0) return null;
    return computeCategoryBaselines(blocks);
  });

  // All standard category types for the "Set Category" submenu.
  // Always shows every type — not just ones the auto-detector happened to assign.
  readonly autoDetectedCategoryList = computed(() => {
    const ALL_STANDARD_CATEGORIES: Array<{ id: string; name: string; color: string }> = [
      { id: 'body',         name: 'Body Text',        color: '#4CAF50' },
      { id: 'heading',      name: 'Section Headings',  color: '#FF9800' },
      { id: 'subheading',   name: 'Subheadings',       color: '#9C27B0' },
      { id: 'title',        name: 'Titles',            color: '#F44336' },
      { id: 'quote',        name: 'Block Quotes',      color: '#FFEB3B' },
      { id: 'caption',      name: 'Captions',          color: '#00BCD4' },
      { id: 'footnote',     name: 'Footnotes',         color: '#2196F3' },
      { id: 'footnote_ref', name: 'Footnote Numbers',  color: '#E91E63' },
      { id: 'header',       name: 'Page Headers',      color: '#795548' },
      { id: 'footer',       name: 'Page Footers',      color: '#607D8B' },
      { id: 'image',        name: 'Images',            color: '#9E9E9E' },
    ];

    // Override colors from actual detected categories (user may have customized)
    const existing = this.categories();
    return ALL_STANDARD_CATEGORIES.map(cat => {
      const detected = existing[cat.id];
      return detected ? { id: cat.id, name: detected.name, color: detected.color } : cat;
    });
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
      case 'finishParagraphFix':
        this.finishParagraphFix();
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
   * Toggle visibility of a specific text layer type.
   */
  toggleTextLayerVisibility(layerId: string): void {
    if (layerId === 'pdf') {
      this.showPdfTextLayer.update(v => !v);
    } else if (layerId === 'ocr') {
      this.showOcrTextLayer.update(v => !v);
    }
  }

  /**
   * Permanently remove all blocks of a specific text layer type.
   */
  deleteTextLayer(layerId: string): void {
    const blocks = this.blocks();
    const idsToRemove: string[] = [];
    for (const b of blocks) {
      if (b.is_image) continue;
      if (layerId === 'pdf' && !b.is_ocr) idsToRemove.push(b.id);
      if (layerId === 'ocr' && b.is_ocr) idsToRemove.push(b.id);
    }
    if (idsToRemove.length > 0) {
      this.editorState.removeBlocks(idsToRemove);
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

  onZoomChange(delta: number): void {
    // Apply zoom delta directly for smooth, responsive zooming
    this.userAdjustedZoom = true;
    const currentZoom = this.zoom();
    // Scale delta based on current zoom for consistent feel
    // At higher zoom levels, same scroll should change more absolute pixels
    const scaledDelta = delta * (currentZoom / 100);
    const newZoom = Math.max(10, Math.min(2000, Math.round(currentZoom + scaledDelta)));
    this.zoom.set(newZoom);
  }

  // Delegate to PageRenderService
  getPageImageUrl(pageNum: number): string {
    return this.pageRenderService.getPageImageUrl(pageNum);
  }

  // Stable function references for template inputs — avoids creating a new
  // function identity on every change-detection pass (defeats OnPush children)
  readonly getPageImageUrlFn = (pageNum: number): string => this.getPageImageUrl(pageNum);
  readonly getSplitPositionForPageFn = (pageNum: number): number => this.getSplitPositionForPage(pageNum);
  readonly getPageImageForOcrFn = (pageNum: number): string | null => this.getPageImageForOcr(pageNum);

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
      this.router.navigate(['/studio']);
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

  /**
   * Surface non-fatal analysis warnings (e.g. "image extraction failed") to the
   * user. The backend attaches these to analyze/analyzeText results and the
   * text-ready event; without this they'd only exist in the main-process log.
   */
  private surfaceAnalysisWarnings(warnings: string[] | undefined): void {
    if (!warnings || warnings.length === 0) return;
    this.showAlert({
      title: 'Document Analysis Warning',
      message: warnings.join('\n\n'),
      type: 'warning'
    });
  }

  /**
   * Start background text extraction for a document opened with analyzeQuick().
   * Subscribes to the text-ready event and fires analyzePdfText (fire-and-forget).
   * Returns immediately — text arrives asynchronously via the event.
   */
  private startBackgroundTextExtraction(libraryPath: string, docId: string): void {
    // Clean up any existing subscription for this doc
    this.textReadyUnsubs.get(docId)?.();

    this.editorState.textLoading.set(true);

    const unsub = this.electronService.onTextReady((data) => {
      // Ignore text-ready events for other documents (a missing pdfPath is
      // treated as a match for safety during the transition period)
      if (data.pdfPath && data.pdfPath !== libraryPath) {
        return;
      }

      // Clean up subscription — we only expect one text-ready per analyzeText call
      this.textReadyUnsubs.get(docId)?.();
      this.textReadyUnsubs.delete(docId);

      // Surface non-fatal extraction problems (e.g. images failed) to the user
      this.surfaceAnalysisWarnings(data.warnings);

      // Update editor state if this doc is still the active one
      if (this.activeDocumentId() === docId) {
        this.editorState.updateTextData({
          blocks: data.blocks as TextBlock[],
          categories: data.categories as Record<string, Category>,
        });

        // Re-apply any block merges that were restored before text arrived.
        // updateTextData() replaced all blocks, undoing any previous merge application.
        const blockMerges = this.editorState.blockMerges();
        if (blockMerges.size > 0) {
          const allBlocks = this.editorState.blocks();
          const blocksById = new Map(allBlocks.map(b => [b.id, b]));
          const definitions: MergeDefinition[] = [];
          for (const [, def] of blockMerges) {
            const sourceBlocks = def.sourceBlockIds
              .map(id => blocksById.get(id))
              .filter((b): b is TextBlock => !!b);
            if (sourceBlocks.length >= 2) {
              definitions.push({
                ...def,
                sourceBlocks,
                mergedBlock: createMergedBlock(def.mergedBlockId, sourceBlocks),
              });
            }
          }
          if (definitions.length > 0) {
            // Clear existing merge map first (mergeBlocks appends)
            this.editorState.blockMerges.set(new Map());
            this.editorState.mergeBlocks(definitions, false);
          }
        }

        // Freshly-ingested EPUB (no restored merges): consolidate its per-line
        // blocks into one block per paragraph. Guards inside make this a no-op
        // for PDFs and for documents that already have paragraph structure.
        this.autoSegmentEpubParagraphs();
      }

      // Also update the OpenDocument in tabs so tab switching preserves text
      this.openDocuments.update(docs => docs.map(d => {
        if (d.id === docId) {
          return { ...d, blocks: data.blocks as TextBlock[], categories: data.categories as Record<string, Category> };
        }
        return d;
      }));

      // Run deferred analysis matching now that text/spans are ready
      if (this.pendingAnalysisMatch()) {
        this.pendingAnalysisMatch.set(false);
        this.matchAnalysisFlagsToPdf(this.analysisFlags(), this.analysisCategories());
      }
    });

    this.textReadyUnsubs.set(docId, unsub);

    // Fire-and-forget — result also comes via text-ready event
    this.pdfService.analyzePdfText(libraryPath).catch(err => {
      console.error('[PdfPicker] Background text extraction failed:', err);
      this.editorState.textLoading.set(false);
      this.textReadyUnsubs.get(docId)?.();
      this.textReadyUnsubs.delete(docId);
    });
  }

  private closePdf(): void {
    // Reset all state to show library view
    this.pdfLoaded.set(false);
    this.blocks.set([]);
    // Reset editor state via service
    this.editorState.reset();
    this.pageRenderService.closeDocument(); // Also frees the backend cached render doc
    this.electronService.closePdf(); // Free the main analysis document WASM memory
    this.projectService.reset();

    // Clear blanked pages tracking
    this.blankedPages.set(new Set());

    // Clear per-document component state
    this.chapters.set([]);
    this.chaptersSource.set('manual');
    this.metadata.set({});
    this.categoryHighlights.set(new Map());
    this.deletedHighlightIds.set(new Set());
    this.splitConfig.set(this.defaultSplitConfig());
    this.splitApplied.set(false);
    this.projectCreatedAt = null;

    // Clear crop / task panel state (cropRegions live on editorState and are
    // reset by editorState.reset()/loadDocument()).
    this.activePanel.set(null);
    this.viewerInteraction.set('select');
    this.currentCropRect.set(null);
  }

  async loadPdf(path: string, lightweight: boolean = false): Promise<void> {
    this.showFilePicker.set(false);
    if (!this.pipelineTransitioning) {
      this.pipelineStep.set('select');
      this.visitedStations.set(new Set<PipelineStep>(['select']));
    }

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
            this.showAlert({
              title: 'Conversion failed',
              message: convResult.error || 'Calibre could not convert this file to EPUB.',
              type: 'error',
            });
            return; // Can't proceed without conversion
          }
        } else {
          console.log('[PdfPicker] ebook-convert not available, cannot open', path);
          this.loading.set(false);
          this.showAlert({
            title: 'Calibre required',
            message: 'This format needs Calibre to convert it to EPUB. Install Calibre, then add it in Settings → Add-ons.',
            type: 'error',
          });
          return;
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

    let libraryPath: string;
    let fileHash = '';

    try {
      // In embedded mode, skip library import - just use the file directly
      // The file is already part of a BFP project
      if (this.embedded()) {
        this.loadingText.set('Analyzing document...');
        libraryPath = effectivePath;
      } else {
        this.loadingText.set('Importing to library...');

        // Import file to library (copies file and deduplicates by hash)
        const importResult = await this.electronService.libraryImportFile(effectivePath);
        if (!importResult.success || !importResult.libraryPath) {
          throw new Error(importResult.error || 'Failed to import file to library');
        }

        libraryPath = importResult.libraryPath;
        fileHash = importResult.hash || '';

        // Check if already open by hash (same file, different path)
        const existingByHash = this.openDocuments().find(d => d.fileHash === fileHash && fileHash);
        if (existingByHash) {
          this.saveCurrentDocumentState();
          this.restoreDocumentState(existingByHash.id);
          this.loading.set(false);
          return;
        }

        this.loadingText.set('Analyzing document...');
      }

      // Subscribe to real-time progress from the worker thread
      const unsubProgress = this.electronService.onAnalyzeProgress((progress) => {
        this.loadingText.set(progress.message);
      });

      let quickResult;
      try {
        quickResult = await this.pdfService.analyzePdfQuick(libraryPath);
      } finally {
        unsubProgress();
      }

      // Cache hit may carry warnings recorded when the analysis was produced
      // (e.g. image extraction failed) — surface them
      this.surfaceAnalysisWarnings(quickResult.warnings);

      // Create new document — use full data if cache hit, empty if cache miss
      const docId = this.generateDocumentId();
      const newDoc: OpenDocument = {
        id: docId,
        path: path,           // Original path for display
        libraryPath: libraryPath,  // Library path for operations
        fileHash: fileHash,
        name: quickResult.pdf_name,
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
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
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
        pdfName: quickResult.pdf_name,
        pdfPath: path,
        libraryPath: libraryPath,
        fileHash: fileHash
      });
      this.pageRenderService.clear();
      this.projectService.reset();
      this.blankedPages.set(new Set());  // Clear blanked pages for new document
      this.metadata.set({});  // Clear metadata for new document
      // Clear remaining per-document component state so the previous tab's
      // data doesn't leak into (and get auto-saved with) the new document
      this.chapters.set([]);
      this.chaptersSource.set('manual');
      this.categoryHighlights.set(new Map());
      this.deletedHighlightIds.set(new Set());
      this.splitConfig.set(this.defaultSplitConfig());
      this.splitApplied.set(false);
      this.projectCreatedAt = null;

      this.saveRecentFile(path, quickResult.pdf_name);

      // Set lightweight mode
      this.lightweightMode.set(lightweight);

      // Always initialize page rendering (so OCR can work)
      // But only load pages if NOT in lightweight mode
      this.pageRenderService.initialize(this.effectivePath(), quickResult.page_count);

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
      // Only auto-create project in non-embedded mode
      // In embedded mode, the project already exists (we're editing a version of it).
      // Also skip during pipeline transitions (review / paragraph-fix reloads of a
      // DERIVED epub) — projectPath already points at the manifest project and must
      // stay bound to it, not rebind to the exported artifact's (absent) project.
      if (!this.embedded() && !this.pipelineTransitioning) {
        await this.autoCreateProject(path, quickResult.pdf_name);
      }

      // Auto-extract chapters from EPUBs (they have nav.xhtml with TOC)
      // PDFs may or may not have outlines, so we only auto-load for EPUBs
      if (libraryPath.toLowerCase().endsWith('.epub')) {
        this.tryLoadOutline();
      }

      // Start on-demand page rendering (non-blocking, only renders visible pages)
      // Additional pages render as the user scrolls via the pdf-viewer effect
      if (!lightweight) {
        this.pageRenderService.startOnDemandRendering(quickResult.page_count);
      }

      // If text not ready (cache miss), start background extraction.
      // When text IS ready and this is a freshly-opened EPUB, consolidate its
      // per-line blocks into paragraph blocks (the not-ready case does this in
      // the text-ready callback instead).
      if (!quickResult.textReady) {
        this.startBackgroundTextExtraction(libraryPath, docId);
      } else if (libraryPath.toLowerCase().endsWith('.epub')) {
        this.autoSegmentEpubParagraphs();
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

  private setSelectionWithHistory(newIds: string[]): void {
    const before = [...this.selectedBlockIds()];
    const after = [...newIds];
    if (before.length === after.length && before.every(id => after.includes(id))) return;
    this.editorState.pushSelectionHistory(before, after);
    this.selectedBlockIds.set(newIds);
  }

  onBlockClick(event: { block: TextBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
    if (this.paragraphMode()) return;
    const { block, shiftKey, metaKey, ctrlKey } = event;
    const isCmdOrCtrl = metaKey || ctrlKey;

    if (isCmdOrCtrl && !shiftKey) {
      // Cmd/Ctrl+click (without shift): deselect if selected, otherwise add to selection
      const selected = [...this.selectedBlockIds()];
      const idx = selected.indexOf(block.id);
      if (idx >= 0) {
        // Already selected - deselect it
        selected.splice(idx, 1);
        this.setSelectionWithHistory(selected);
      } else {
        // Not selected - add to selection (additive)
        selected.push(block.id);
        this.setSelectionWithHistory(selected);
      }
    } else if (shiftKey) {
      // Shift+click: add to selection (always additive, never removes)
      const selected = [...this.selectedBlockIds()];
      if (!selected.includes(block.id)) {
        selected.push(block.id);
      }
      this.setSelectionWithHistory(selected);
    } else {
      // Single click (no modifiers): select just this block
      // This is the cycling behavior - each click highlights the next overlapping block
      this.setSelectionWithHistory([block.id]);
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
    if (this.reviewMode()) return;  // read-only during EPUB review
    const { block, metaKey, ctrlKey, screenX, screenY, screenWidth, screenHeight } = event;
    const mode = this.viewerInteraction();
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
    if (this.reviewMode()) return;  // read-only during EPUB review
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
    if (this.reviewMode()) return;  // read-only during EPUB review
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
   * Re-render a page with all edited blocks' original positions redacted.
   *
   * For PDFs, uses MuPDF's applyRedactions() to cleanly remove text at the
   * document level. For EPUBs, skips re-rendering entirely — white SVG fill
   * rects in the viewer occlude original text under edited/deleted blocks,
   * and actual content removal happens at export time.
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

    // EPUBs: skip re-rendering. MuPDF's applyRedactions corrupts EPUB layout.
    // The viewer renders white SVG rects over edited/deleted blocks instead.
    if (this.isCurrentDocumentEpub()) {
      return;
    }

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
      this.setSelectionWithHistory([...current]);
    } else {
      // Replace selection
      this.setSelectionWithHistory(matching);
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
      this.setSelectionWithHistory([...existing]);
    } else {
      // Replace selection
      this.setSelectionWithHistory(blockIds);
    }
  }

  onPageReorder(newOrder: number[]): void {
    // Use editor state for undo/redo support
    this.editorState.setPageOrder(newOrder);
  }

  deleteSelectedBlocks(): void {
    if (this.reviewMode()) return;  // read-only during EPUB review
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
    if (this.reviewMode()) return;  // read-only during EPUB review
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

  // ─── Category correction & re-detection ────────────────────────────────

  onSetBlockCategory(event: { blockIds: string[]; categoryId: string }): void {
    if (this.reviewMode()) return;  // read-only during EPUB review
    // If the target category doesn't exist in the document yet, create it
    const existing = this.categories();
    if (!existing[event.categoryId]) {
      const catInfo = this.autoDetectedCategoryList().find(c => c.id === event.categoryId);
      if (catInfo) {
        this.editorState.addCategory({
          id: catInfo.id,
          name: catInfo.name,
          description: '',
          color: catInfo.color,
          block_count: 0,
          char_count: 0,
          font_size: 0,
          region: 'body',
          sample_text: '',
          enabled: true,
        });
      }
    }

    if (event.blockIds.length === 1) {
      this.editorState.setCategoryCorrection(event.blockIds[0], event.categoryId);
    } else {
      this.editorState.setBulkCategoryCorrections(
        event.blockIds.map(id => ({ blockId: id, categoryId: event.categoryId }))
      );
    }
  }

  clearCategoryCorrections(): void {
    this.editorState.clearAllCategoryCorrections();
  }

  onThresholdChange(event: { path: string; value: number }): void {
    this.editorState.updateThreshold(event.path, event.value);
  }

  resetThresholds(): void {
    this.editorState.resetThresholdsToDefault();
  }

  recategorizeBlocks(): void {
    const blocks = this.blocks();
    const corrections = this.editorState.categoryCorrections();
    const pageDimensions = this.pageDimensions();
    const thresholds = this.editorState.classificationThresholds();
    const deletedBlockIds = this.deletedBlockIds();

    // If corrections exist, use re-detect (centroid-based) to propagate them.
    // Otherwise fall back to threshold-based heuristic re-classification.
    let newAssignments: Map<string, string>;
    if (corrections.size > 0) {
      try {
        newAssignments = redetectCategoriesFromLearner(blocks, corrections, pageDimensions, deletedBlockIds);
      } catch (err) {
        console.error('[recategorizeBlocks] Re-detect threw:', err);
        return;
      }
    } else {
      try {
        newAssignments = recategorizeWithThresholds(blocks, corrections, pageDimensions, thresholds, deletedBlockIds);
      } catch (err) {
        console.error('[recategorizeBlocks] Threshold classifier threw:', err);
        return;
      }
    }

    // Ensure all assigned categories exist
    const cats = this.categories();
    const catList = this.autoDetectedCategoryList();
    for (const categoryId of new Set(newAssignments.values())) {
      if (!cats[categoryId]) {
        const catInfo = catList.find(c => c.id === categoryId);
        if (catInfo) {
          this.editorState.addCategory({
            id: catInfo.id,
            name: catInfo.name,
            description: '',
            color: catInfo.color,
            block_count: 0,
            char_count: 0,
            font_size: 0,
            region: 'body',
            sample_text: '',
            enabled: true,
          });
        }
      }
    }

    // Build learned map (non-correction assignments)
    const learned = new Map<string, string>();
    let changedCount = 0;
    this.editorState.blocks.update(currentBlocks =>
      currentBlocks.map(b => {
        const newCatId = newAssignments.get(b.id);
        if (newCatId && newCatId !== b.category_id) {
          changedCount++;
          if (!corrections.has(b.id)) {
            learned.set(b.id, newCatId);
          }
          return { ...b, category_id: newCatId };
        }
        if (newCatId && !corrections.has(b.id)) {
          learned.set(b.id, newCatId);
        }
        return b;
      })
    );

    this.editorState.learnedCategories.set(learned);

    console.log(`[recategorizeBlocks] ${changedCount} blocks changed, ${learned.size} learned`);

    this.editorState.updateCategoryStats();
    this.editorState.markChanged();
  }

  deleteBlock(blockId: string): void {
    if (this.reviewMode()) return;  // read-only during EPUB review
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

  // ─── Split Block Popover ────────────────────────────────────────────────────

  async onSplitBlockRequest(block: TextBlock): Promise<void> {
    if (this.reviewMode()) return;  // read-only during EPUB review
    if (this.editorState.textLoading()) {
      this.showAlert({ title: 'Split Block', message: 'Text extraction is still in progress. Please wait for it to complete.', type: 'error' });
      return;
    }

    // Merged blocks are synthetic — no span data exists. Offer to unmerge instead.
    if (this.editorState.blockMerges().has(block.id)) {
      this.unmergeBlock(block.id);
      return;
    }

    let spans = await this.electronService.getSpansForBlock(block.id);
    if (!spans || spans.length === 0) {
      // Spans may be unavailable if the PDF worker was recycled (5-min idle timeout).
      // Try fetching all spans and filtering client-side as a fallback.
      const allSpans = await this.electronService.getSpans();
      if (allSpans && allSpans.length > 0) {
        spans = allSpans.filter(s => s.block_id === block.id);
        if (!spans || spans.length === 0) {
          console.warn('[onSplitBlockRequest] No spans match block', block.id, '— total spans:', allSpans.length);
          this.showAlert({ title: 'Split Block', message: 'No span data found for this block. The block may have been generated by OCR or a different analysis pass.', type: 'error' });
          return;
        }
      } else {
        this.showAlert({ title: 'Split Block', message: 'Span data is not available. The PDF text extraction may need to complete first, or try reopening the document.', type: 'error' });
        return;
      }
    }

    const lines = this.groupSpansByLine(spans);
    if (lines.length <= 1) {
      this.showAlert({ title: 'Split Block', message: 'Block has only one visual line — nothing to split.', type: 'error' });
      return;
    }

    this.splitPopoverBlock.set(block);
    this.splitPopoverLines.set(lines);
    this.splitPopoverPoints.set(new Set());
  }

  private groupSpansByLine(spans: Array<{
    x: number; y: number; width: number; height: number;
    text: string; font_size: number; font_name: string;
    is_bold: boolean; is_italic: boolean;
  }>): Array<{
    text: string; y: number; height: number;
    isBold: boolean; isItalic: boolean; fontSize: number; fontName: string;
    spans: typeof spans;
  }> {
    if (spans.length === 0) return [];

    const sorted = [...spans].sort((a, b) => a.y - b.y);
    const rawGroups: Array<{ spans: typeof spans; y: number }> = [];
    let cur = { spans: [sorted[0]], y: sorted[0].y };

    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - cur.y) <= 2) {
        cur.spans.push(sorted[i]);
      } else {
        rawGroups.push(cur);
        cur = { spans: [sorted[i]], y: sorted[i].y };
      }
    }
    rawGroups.push(cur);

    return rawGroups.map(g => {
      let boldChars = 0, italicChars = 0, totalChars = 0;
      const fontSizes = new Map<number, number>();
      const fontNames = new Map<string, number>();
      const texts: string[] = [];
      let y0 = Infinity, y1 = -Infinity;

      for (const s of g.spans) {
        const len = s.text.length;
        totalChars += len;
        if (s.is_bold) boldChars += len;
        if (s.is_italic) italicChars += len;
        fontSizes.set(s.font_size, (fontSizes.get(s.font_size) || 0) + len);
        fontNames.set(s.font_name, (fontNames.get(s.font_name) || 0) + len);
        texts.push(s.text);
        y0 = Math.min(y0, s.y);
        y1 = Math.max(y1, s.y + s.height);
      }

      let dominantSize = 10, maxCount = 0;
      for (const [size, count] of fontSizes) {
        if (count > maxCount) { maxCount = count; dominantSize = size; }
      }
      let dominantFont = 'unknown', maxFontCount = 0;
      for (const [font, count] of fontNames) {
        if (count > maxFontCount) { maxFontCount = count; dominantFont = font; }
      }

      return {
        text: texts.join(' '),
        y: y0,
        height: y1 - y0,
        isBold: totalChars > 0 && boldChars > totalChars * 0.5,
        isItalic: totalChars > 0 && italicChars > totalChars * 0.5,
        fontSize: dominantSize,
        fontName: dominantFont,
        spans: g.spans,
      };
    });
  }

  toggleSplitPoint(index: number): void {
    this.splitPopoverPoints.update(pts => {
      const next = new Set(pts);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  confirmSplit(): void {
    const block = this.splitPopoverBlock();
    const lines = this.splitPopoverLines();
    const points = this.splitPopoverPoints();
    if (!block || lines.length === 0 || points.size === 0) return;

    // Build segments from split points
    const sortedPoints = [...points].sort((a, b) => a - b);
    const segments: Array<typeof lines> = [];
    let start = 0;
    for (const sp of sortedPoints) {
      segments.push(lines.slice(start, sp));
      start = sp;
    }
    segments.push(lines.slice(start));

    // Build classification context
    const allBlocks = this.blocks();
    const pageDimensions = this.pageDimensions();
    const baselines = computeCategoryBaselines(allBlocks);
    const imagesByPage = new Map<number, TextBlock[]>();
    const blocksByPage = new Map<number, TextBlock[]>();
    for (const b of allBlocks) {
      if (b.is_image) {
        if (!imagesByPage.has(b.page)) imagesByPage.set(b.page, []);
        imagesByPage.get(b.page)!.push(b);
      }
      if (!blocksByPage.has(b.page)) blocksByPage.set(b.page, []);
      blocksByPage.get(b.page)!.push(b);
    }
    // Build repeatedTopTexts
    const topTextCounts = new Map<string, number>();
    for (const b of allBlocks) {
      if (b.region === 'header' && b.text.trim()) {
        const t = b.text.trim().toLowerCase();
        topTextCounts.set(t, (topTextCounts.get(t) || 0) + 1);
      }
    }
    const repeatedTopTexts = new Set<string>();
    for (const [t, count] of topTextCounts) {
      if (count >= 2) repeatedTopTexts.add(t);
    }

    const pageHeight = pageDimensions[block.page]?.height || 800;
    const childBlocks: TextBlock[] = [];
    const childBlockIds: string[] = [];

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const seg = segments[segIdx];
      if (seg.length === 0) continue;

      const segSpans = seg.flatMap(l => l.spans);
      const segText = seg.map(l => l.text).join(' ');
      if (!segText.trim()) continue;

      // Aggregate formatting
      let boldChars = 0, italicChars = 0, totalChars = 0;
      const fontSizes = new Map<number, number>();
      const fontNames = new Map<string, number>();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

      for (const s of segSpans) {
        const len = s.text.length;
        totalChars += len;
        if (s.is_bold) boldChars += len;
        if (s.is_italic) italicChars += len;
        fontSizes.set(s.font_size, (fontSizes.get(s.font_size) || 0) + len);
        fontNames.set(s.font_name, (fontNames.get(s.font_name) || 0) + len);
        x0 = Math.min(x0, s.x);
        y0 = Math.min(y0, s.y);
        x1 = Math.max(x1, s.x + s.width);
        y1 = Math.max(y1, s.y + s.height);
      }

      let dominantSize = 10, maxSizeCount = 0;
      for (const [size, count] of fontSizes) {
        if (count > maxSizeCount) { maxSizeCount = count; dominantSize = size; }
      }
      let dominantFont = 'unknown', maxFontCount = 0;
      for (const [font, count] of fontNames) {
        if (count > maxFontCount) { maxFontCount = count; dominantFont = font; }
      }

      const isBold = totalChars > 0 && boldChars > totalChars * 0.5;
      const isItalic = totalChars > 0 && italicChars > totalChars * 0.5;

      // Region detection
      const segY = y0, segHeight = y1 - y0;
      const yPct = segY / pageHeight;
      const trimmedText = segText.trim();
      const textLen = trimmedText.length;
      const lineCount = seg.length;
      const looksLikeBodyText = textLen > 100 ||
        /[.!?]["']?\s+[A-Z]/.test(trimmedText) ||
        (trimmedText.endsWith('.') && textLen > 60);
      let region = 'body';
      const bottomPct = (segY + segHeight) / pageHeight;
      if (lineCount <= 2 && (yPct < 0.10 || bottomPct < 0.15) && !looksLikeBodyText) {
        region = 'header';
      } else if (yPct > 0.90 || (yPct > 0.88 && textLen < 50)) {
        region = 'footer';
      } else if (yPct > 0.70) {
        region = 'lower';
      }

      // Deterministic ID from original block + segment index
      const blockId = this.simpleHash(`${block.id}:split:${segIdx}`);

      const childBlock: TextBlock = {
        id: blockId,
        page: block.page,
        x: x0,
        y: segY,
        width: x1 - x0,
        height: segHeight,
        text: segText,
        font_size: dominantSize,
        font_name: dominantFont,
        char_count: segText.length,
        region,
        category_id: '',
        is_bold: isBold,
        is_italic: isItalic,
        is_superscript: false,
        is_image: false,
        is_footnote_marker: false,
        line_count: lineCount,
      };

      // Auto-classify
      childBlock.category_id = classifyBlockHeuristic(
        childBlock, baselines, imagesByPage, blocksByPage, pageDimensions, repeatedTopTexts
      );

      // Ensure category exists
      const cats = this.categories();
      if (childBlock.category_id && !cats[childBlock.category_id]) {
        const catInfo = this.autoDetectedCategoryList().find(c => c.id === childBlock.category_id);
        if (catInfo) {
          this.editorState.addCategory({
            id: catInfo.id, name: catInfo.name, description: '',
            color: catInfo.color, block_count: 0, char_count: 0,
            font_size: 0, region: 'body', sample_text: '', enabled: true,
          });
        }
      }

      childBlocks.push(childBlock);
      childBlockIds.push(blockId);
    }

    if (childBlocks.length <= 1) {
      this.showAlert({ title: 'Split Block', message: 'Split produced only one block — nothing changed.', type: 'error' });
      this.splitPopoverBlock.set(null);
      return;
    }

    const definition: SplitDefinition = {
      originalBlockId: block.id,
      splitPoints: sortedPoints,
      childBlockIds,
      childBlocks,
    };

    this.editorState.splitBlock(definition);
    this.editorState.updateCategoryStats();
    this.splitPopoverBlock.set(null);
  }

  cancelSplit(): void {
    this.splitPopoverBlock.set(null);
  }

  /**
   * Restore block splits from persisted data by re-fetching spans and rebuilding
   * child blocks. Called during project restore (no history push).
   */
  private async restoreBlockSplits(splits: Array<{
    originalBlockId: string;
    splitPoints: number[];
    childBlockIds: string[];
  }>): Promise<void> {
    const allBlocks = this.blocks();
    const pageDimensions = this.pageDimensions();
    const baselines = computeCategoryBaselines(allBlocks);
    const imagesByPage = new Map<number, TextBlock[]>();
    const blocksByPage = new Map<number, TextBlock[]>();
    for (const b of allBlocks) {
      if (b.is_image) {
        if (!imagesByPage.has(b.page)) imagesByPage.set(b.page, []);
        imagesByPage.get(b.page)!.push(b);
      }
      if (!blocksByPage.has(b.page)) blocksByPage.set(b.page, []);
      blocksByPage.get(b.page)!.push(b);
    }
    const topTextCounts = new Map<string, number>();
    for (const b of allBlocks) {
      if (b.region === 'header' && b.text.trim()) {
        const t = b.text.trim().toLowerCase();
        topTextCounts.set(t, (topTextCounts.get(t) || 0) + 1);
      }
    }
    const repeatedTopTexts = new Set<string>();
    for (const [t, count] of topTextCounts) {
      if (count >= 2) repeatedTopTexts.add(t);
    }

    for (const split of splits) {
      const originalBlock = allBlocks.find(b => b.id === split.originalBlockId);
      if (!originalBlock) {
        console.warn('[restoreBlockSplits] Original block not found:', split.originalBlockId);
        continue;
      }

      const spans = await this.electronService.getSpansForBlock(split.originalBlockId);
      if (!spans || spans.length === 0) {
        console.warn('[restoreBlockSplits] No spans for block:', split.originalBlockId);
        continue;
      }

      const lines = this.groupSpansByLine(spans);
      if (lines.length <= 1) continue;

      // Build segments from persisted split points
      const sortedPoints = [...split.splitPoints].sort((a, b) => a - b);
      const segments: Array<typeof lines> = [];
      let start = 0;
      for (const sp of sortedPoints) {
        if (sp <= lines.length) {
          segments.push(lines.slice(start, sp));
          start = sp;
        }
      }
      segments.push(lines.slice(start));

      const pageHeight = pageDimensions[originalBlock.page]?.height || 800;
      const childBlocks: TextBlock[] = [];
      const childBlockIds: string[] = [];

      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const seg = segments[segIdx];
        if (seg.length === 0) continue;

        const segSpans = seg.flatMap(l => l.spans);
        const segText = seg.map(l => l.text).join(' ');
        if (!segText.trim()) continue;

        let boldChars = 0, italicChars = 0, totalChars = 0;
        const fontSizes = new Map<number, number>();
        const fontNames = new Map<string, number>();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

        for (const s of segSpans) {
          const len = s.text.length;
          totalChars += len;
          if (s.is_bold) boldChars += len;
          if (s.is_italic) italicChars += len;
          fontSizes.set(s.font_size, (fontSizes.get(s.font_size) || 0) + len);
          fontNames.set(s.font_name, (fontNames.get(s.font_name) || 0) + len);
          x0 = Math.min(x0, s.x);
          y0 = Math.min(y0, s.y);
          x1 = Math.max(x1, s.x + s.width);
          y1 = Math.max(y1, s.y + s.height);
        }

        let dominantSize = 10, maxSizeCount = 0;
        for (const [size, count] of fontSizes) {
          if (count > maxSizeCount) { maxSizeCount = count; dominantSize = size; }
        }
        let dominantFont = 'unknown', maxFontCount = 0;
        for (const [font, count] of fontNames) {
          if (count > maxFontCount) { maxFontCount = count; dominantFont = font; }
        }

        const isBold = totalChars > 0 && boldChars > totalChars * 0.5;
        const isItalic = totalChars > 0 && italicChars > totalChars * 0.5;

        const segY = y0, segHeight = y1 - y0;
        const yPct = segY / pageHeight;
        const trimmedText = segText.trim();
        const textLen = trimmedText.length;
        const lineCount = seg.length;
        const looksLikeBodyText = textLen > 100 ||
          /[.!?]["']?\s+[A-Z]/.test(trimmedText) ||
          (trimmedText.endsWith('.') && textLen > 60);
        let region = 'body';
        const bottomPct = (segY + segHeight) / pageHeight;
        if (lineCount <= 2 && (yPct < 0.10 || bottomPct < 0.15) && !looksLikeBodyText) {
          region = 'header';
        } else if (yPct > 0.90 || (yPct > 0.88 && textLen < 50)) {
          region = 'footer';
        } else if (yPct > 0.70) {
          region = 'lower';
        }

        const blockId = this.simpleHash(`${originalBlock.id}:split:${segIdx}`);

        const childBlock: TextBlock = {
          id: blockId,
          page: originalBlock.page,
          x: x0,
          y: segY,
          width: x1 - x0,
          height: segHeight,
          text: segText,
          font_size: dominantSize,
          font_name: dominantFont,
          char_count: segText.length,
          region,
          category_id: '',
          is_bold: isBold,
          is_italic: isItalic,
          is_superscript: false,
          is_image: false,
          is_footnote_marker: false,
          line_count: lineCount,
        };

        childBlock.category_id = classifyBlockHeuristic(
          childBlock, baselines, imagesByPage, blocksByPage, pageDimensions, repeatedTopTexts
        );

        const cats = this.categories();
        if (childBlock.category_id && !cats[childBlock.category_id]) {
          const catInfo = this.autoDetectedCategoryList().find(c => c.id === childBlock.category_id);
          if (catInfo) {
            this.editorState.addCategory({
              id: catInfo.id, name: catInfo.name, description: '',
              color: catInfo.color, block_count: 0, char_count: 0,
              font_size: 0, region: 'body', sample_text: '', enabled: true,
            });
          }
        }

        childBlocks.push(childBlock);
        childBlockIds.push(blockId);
      }

      if (childBlocks.length > 1) {
        this.editorState.splitBlock({
          originalBlockId: split.originalBlockId,
          splitPoints: sortedPoints,
          childBlockIds,
          childBlocks,
        }, false); // false = don't push to history
      }
    }

    this.editorState.updateCategoryStats();
  }

  private simpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return 'split_' + Math.abs(hash).toString(36);
  }

  /**
   * Detect and merge consecutive same-category blocks on each page.
   * Consolidates fragmented body text into unified paragraph blocks.
   */
  async mergeAdjacentBlocks(): Promise<void> {
    const blocks = this.blocks();
    const deletedBlockIds = this.deletedBlockIds();

    // Paragraph-aware merge: each merged block should be exactly one paragraph.
    // Make sure paragraph breaks have been detected first, otherwise consecutive
    // paragraphs of single-line blocks would collapse into one giant block.
    if (this.editorState.paragraphBreaks().size === 0) {
      this.detectParagraphs();
    }
    const paragraphBreaks = this.editorState.paragraphBreaks();

    console.log('[mergeAdjacentBlocks] Starting with', blocks.length, 'blocks,', deletedBlockIds.size, 'deleted,', paragraphBreaks.size, 'paragraph breaks');
    const groups = detectMergeableGroups(blocks, deletedBlockIds, paragraphBreaks);

    if (groups.length === 0) {
      await this.electronService.showConfirmDialog({
        title: 'Nothing to merge',
        message: 'No groups of single-line blocks were found to merge into paragraphs.',
        confirmLabel: 'OK',
        type: 'info',
      });
      return;
    }

    // Confirm before applying — let the user back out instead of merging.
    const blockCount = groups.reduce((sum, g) => sum + g.blockIds.length, 0);
    const { confirmed } = await this.electronService.showConfirmDialog({
      title: 'Merge blocks into paragraphs?',
      message: `Merge ${blockCount} single-line blocks into ${groups.length} paragraph${groups.length === 1 ? '' : 's'}?`,
      detail: 'Only adjacent single-line blocks of the same type are merged, split at paragraph boundaries. You can undo this afterwards.',
      confirmLabel: 'Merge',
      cancelLabel: 'Cancel',
      type: 'question',
    });
    if (!confirmed) {
      console.log('[mergeAdjacentBlocks] User cancelled merge');
      return;
    }

    console.log('[mergeAdjacentBlocks] Found', groups.length, 'groups to merge');
    this.applyMergeGroups(groups);
  }

  /** Turn detected merge groups into merged blocks and apply them. */
  private applyMergeGroups(groups: MergeGroup[]): void {
    const definitions: MergeDefinition[] = groups.map(group => {
      const mergedId = this.mergeHash('merge:' + group.blockIds.join(','));
      return {
        mergedBlockId: mergedId,
        sourceBlockIds: group.blockIds,
        sourceBlocks: group.blocks,
        mergedBlock: createMergedBlock(mergedId, group.blocks),
      };
    });

    this.editorState.mergeBlocks(definitions);
    this.editorState.updateCategoryStats();
  }

  /**
   * Freshly-ingested EPUBs arrive as one block per visual line because MuPDF
   * reflows the EPUB and drops the <p> structure. Detect paragraphs and merge
   * the single-line blocks back into one block per paragraph, automatically and
   * silently (no confirm popup — this is ingestion, not a user action).
   *
   * Idempotent and conservative: it does nothing if paragraph structure or
   * merges already exist (e.g. a saved project being restored) or if there is
   * nothing to merge, so it never clobbers existing state or touches PDFs.
   */
  private autoSegmentEpubParagraphs(): void {
    if (!this.isCurrentDocumentEpub()) return;
    if (this.editorState.blocks().length === 0) return;
    if (this.editorState.paragraphBreaks().size > 0) return;
    if (this.editorState.blockMerges().size > 0) return;

    // Detect paragraph boundaries first so each merged block is one paragraph.
    this.detectParagraphs();

    const groups = detectMergeableGroups(
      this.blocks(),
      this.deletedBlockIds(),
      this.editorState.paragraphBreaks()
    );
    if (groups.length === 0) return;

    console.log(`[autoSegmentEpubParagraphs] Consolidating line-blocks into ${groups.length} paragraphs`);
    this.applyMergeGroups(groups);
  }

  /**
   * Unmerge a merged block back into its original source blocks.
   */
  unmergeBlock(mergedBlockId: string): void {
    const def = this.editorState.blockMerges().get(mergedBlockId);
    if (!def) return;

    // Remove merged block from blocks array and re-add source blocks
    this.editorState.blocks.update(blocks => [
      ...blocks.filter(b => b.id !== mergedBlockId),
      ...def.sourceBlocks,
    ]);

    // Remove from blockMerges map
    this.editorState.blockMerges.update(map => {
      const next = new Map(map);
      next.delete(mergedBlockId);
      return next;
    });

    // Select the restored source blocks
    this.editorState.selectedBlockIds.set(def.sourceBlockIds);
    this.editorState.updateCategoryStats();
    this.editorState.markChanged();
  }

  private mergeHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return 'merge_' + Math.abs(hash).toString(36);
  }

  /**
   * Restore block merges from persisted data by finding source blocks
   * and rebuilding merged blocks. Called during project restore (no history push).
   */
  private restoreBlockMerges(merges: Array<{ mergedBlockId: string; sourceBlockIds: string[] }>): void {
    const allBlocks = this.blocks();
    const blocksById = new Map(allBlocks.map(b => [b.id, b]));

    const definitions: MergeDefinition[] = [];
    for (const merge of merges) {
      const sourceBlocks = merge.sourceBlockIds
        .map(id => blocksById.get(id))
        .filter((b): b is TextBlock => !!b);

      if (sourceBlocks.length < 2) {
        console.warn('[restoreBlockMerges] Not enough source blocks found for merge:', merge.mergedBlockId);
        continue;
      }

      definitions.push({
        mergedBlockId: merge.mergedBlockId,
        sourceBlockIds: merge.sourceBlockIds,
        sourceBlocks: sourceBlocks,
        mergedBlock: createMergedBlock(merge.mergedBlockId, sourceBlocks),
      });
    }

    if (definitions.length > 0) {
      this.editorState.mergeBlocks(definitions, false); // false = don't push to history
    }
  }

  /**
   * Handle click on a custom category highlight (click-through selection).
   * Toggles the deleted state of the highlight.
   */
  onHighlightClick(event: { catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void {
    // In analysis mode, scroll the sidebar to the matching flag instead of toggling deletion
    if (this.analysisMode() && event.catId.startsWith('analysis_')) {
      const categoryId = event.catId.replace('analysis_', '');
      // Find the flag that matches this page and category
      const flags = this.analysisFlags();
      const flagIndex = flags.findIndex(f =>
        f.categoryId === categoryId && f.page === event.pageNum
      );
      if (flagIndex >= 0) {
        this.selectedAnalysisFlagIndex.set(flagIndex);
      }
      return;
    }

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
    this.editorState.markChanged();
  }

  revertBlockText(blockId: string): void {
    if (this.reviewMode()) return;  // read-only during EPUB review
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

    this.setSelectionWithHistory([...existing]);
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

    this.setSelectionWithHistory([...newSelection]);
  }

  // Clear all selections
  clearSelection(): void {
    this.setSelectionWithHistory([]);
  }

  // Select all blocks (non-deleted)
  selectAllBlocks(): void {
    const deleted = this.deletedBlockIds();
    const allBlockIds = this.blocks()
      .filter(b => !deleted.has(b.id))
      .map(b => b.id);
    this.setSelectionWithHistory(allBlockIds);
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
    this.setSelectionWithHistory([...existing]);
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
    this.setSelectionWithHistory(newSelection);
  }

  // Scroll to a specific page (used by timeline)
  scrollToPage(pageNum: number): void {
    this.pdfViewer?.scrollToPage(pageNum);
  }

  /**
   * Handle navigation from the analysis panel (flag click or search result click).
   * Scrolls to the page and triggers a pulse animation on the matching rects.
   */
  onAnalysisNavigate(event: { page: number; categoryId?: string; color?: string; blockText?: string }): void {
    this.scrollToPage(event.page);

    const pulseRects: Array<{ page: number; x: number; y: number; w: number; h: number; color: string }> = [];
    const color = event.color || '#FFD54F';

    if (event.categoryId) {
      // Analysis flag — find rects from analysisHighlightCategories
      const catKey = 'analysis_' + event.categoryId;
      const analysisHighlights = this.analysisHighlightCategories();
      const cat = analysisHighlights[catKey];
      if (cat) {
        // Look up rects in combinedHighlights
        const combined = this.combinedHighlights();
        const pageMap = combined.get(catKey);
        if (pageMap) {
          const rects = pageMap[event.page];
          if (rects) {
            for (const r of rects) {
              pulseRects.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, color: cat.color || color });
            }
          }
        }
      }
    }

    if (event.blockText) {
      // Search result — find matching block by text and page to get its bounding rect
      const blocks = this.blocks();
      for (const block of blocks) {
        if (block.page === event.page && block.text === event.blockText) {
          pulseRects.push({
            page: block.page,
            x: block.x,
            y: block.y,
            w: block.width,
            h: block.height,
            color,
          });
          break;
        }
      }
    }

    if (pulseRects.length > 0) {
      this.triggerPulse(pulseRects);
    }
  }

  private triggerPulse(rects: Array<{ page: number; x: number; y: number; w: number; h: number; color: string }>): void {
    // Clear any existing pulse timer
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
    }
    this.pulseHighlightRects.set(rects);
    // Auto-clear after animation completes (7 pulses x 1.5s = 10.5s)
    this.pulseTimer = setTimeout(() => {
      this.pulseHighlightRects.set([]);
      this.pulseTimer = null;
    }, 11000);
  }

  async exportText(): Promise<void> {
    const pb = this.editorState.paragraphBreaks();
    const result = await this.exportService.exportText(
      this.getExportableBlocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.textCorrections(),
      this.deletedPages(),
      pb.size > 0 ? pb : undefined
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
    const epubPB = this.editorState.paragraphBreaks();
    const result = chapters.length > 0
      ? await this.exportService.exportEpubWithChapters(
          this.getExportableBlocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          epubPB.size > 0 ? epubPB : undefined
        )
      : await this.exportService.exportEpub(
          this.getExportableBlocks(),
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

    const txtPB = this.editorState.paragraphBreaks();
    const result = await this.exportService.exportText(
      this.getExportableBlocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.editorState.textCorrections(),
      this.deletedPages(),
      txtPB.size > 0 ? txtPB : undefined
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
    const exportPB = this.editorState.paragraphBreaks();
    const result = chapters.length > 0
      ? await this.exportService.exportEpubWithChapters(
          this.getExportableBlocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          exportPB.size > 0 ? exportPB : undefined
        )
      : await this.exportService.exportEpub(
          this.getExportableBlocks(),
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
          await this.router.navigate(['/studio']);

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

    const paragraphBreaks = this.editorState.paragraphBreaks();
    const result = await this.exportService.exportToAudiobook(
      this.getExportableBlocks(),
      this.deletedBlockIds(),
      chapters,
      this.pdfName(),
      this.projectPath() || '',  // Pass the BFP project path
      this.editorState.textCorrections(),
      this.deletedPages(),
      deletedHighlights,
      this.metadata(),  // Pass metadata for title, author, cover, etc.
      true, // Navigate to audiobook producer after
      undefined,
      undefined,
      paragraphBreaks.size > 0 ? paragraphBreaks : undefined
    );

    if (!result.success) {
      this.showAlert({
        title: 'Export Failed',
        message: result.message,
        type: 'error'
      });
    } else if (result.warning) {
      // Show warning about chapter mismatch - export succeeded but there's an issue
      this.showAlert({
        title: 'Chapter Warning',
        message: result.warning,
        type: 'warning'
      });
    }
  }

  /**
   * Save EPUB to a user-chosen location via Save As dialog.
   * Generates an EPUB from the current editor state (with all current deletions/corrections)
   * and lets the user pick where to save it. Does not affect the project's exported.epub.
   */
  async saveEpubAs(): Promise<void> {
    if (!this.pdfLoaded()) return;

    this.loading.set(true);
    this.loadingText.set('Preparing EPUB...');

    try {
      const saveAsPB = this.editorState.paragraphBreaks();
      const result = await this.exportService.saveEpubAs(
        this.getExportableBlocks(),
        this.deletedBlockIds(),
        this.chapters(),
        this.pdfName(),
        this.editorState.textCorrections(),
        this.deletedPages(),
        this.getDeletedHighlights(),
        this.metadata(),
        saveAsPB.size > 0 ? saveAsPB : undefined,
      );

      if (result.message === 'Canceled') {
        // User canceled the dialog — no alert needed
      } else if (!result.success) {
        this.showAlert({ title: 'Save Failed', message: result.message, type: 'error' });
      } else {
        this.showAlert({ title: 'EPUB Saved', message: result.message, type: 'success' });
      }
    } catch (err) {
      this.showAlert({ title: 'Save Failed', message: (err as Error).message, type: 'error' });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Finalize the project for audiobook processing (embedded mode).
   *
   * Finalize the project by exporting an EPUB to the audiobook folder.
   * The original source file is NEVER modified - a new EPUB is generated from the blocks.
   */
  async finalizeProject(): Promise<void> {
    const projectPath = this.projectPath();

    // Finalize requires a BFP project - we never modify original source files
    if (!projectPath) {
      this.finalized.emit({
        success: false,
        error: 'Please save the project first before finalizing'
      });
      return;
    }

    this.loading.set(true);
    this.loadingText.set('Saving...');

    // Persist editor state (chapters, undo/redo, deletions, etc.) to manifest
    await this.saveProjectToPath(projectPath, true);

    // Determine save target: if opened file is an EPUB (not original.epub), save back to it.
    // Non-EPUB sources (PDFs, etc.) always produce exported.epub.
    const overridePath = this.overrideSourcePath();
    const isOverrideEpub = overridePath?.toLowerCase().endsWith('.epub');
    const isOriginalEpub = overridePath?.replace(/\\/g, '/').endsWith('/original.epub');
    const savePath = (overridePath && isOverrideEpub && !isOriginalEpub)
      ? overridePath
      : undefined;

    try {
      const chapters = this.chapters();
      const deletedHighlights = this.getDeletedHighlights();

      // Export to audiobook folder - NEVER modifies the original source file
      const pBreaks = this.editorState.paragraphBreaks();
      const result = await this.exportService.exportToAudiobook(
        this.getExportableBlocks(),
        this.deletedBlockIds(),
        chapters,
        this.pdfName(),
        projectPath,
        this.editorState.textCorrections(),
        this.deletedPages(),
        deletedHighlights,
        this.metadata(),
        false, // Don't navigate to audiobook producer
        undefined, // categories
        savePath,
        pBreaks.size > 0 ? pBreaks : undefined
      );

      if (result.success) {
        // Determine the full path of the saved EPUB
        const fullEpubPath = savePath || `${projectPath}/source/exported.epub`;

        if (result.warning) {
          this.showAlert({
            title: 'Saved with Warning',
            message: result.warning,
            type: 'warning',
            onConfirm: () => this.enterParagraphFixMode(fullEpubPath)
          });
        } else {
          this.enterParagraphFixMode(fullEpubPath);
        }
      } else {
        this.finalized.emit({
          success: false,
          error: result.message || 'Failed to save'
        });

        this.showAlert({
          title: 'Save Failed',
          message: result.message || 'Failed to save EPUB',
          type: 'error'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.finalized.emit({
        success: false,
        error: errorMessage
      });

      this.showAlert({
        title: 'Save Failed',
        message: errorMessage,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pipeline Navigation (Select → Chapters → EPUB Review)
  // ─────────────────────────────────────────────────────────────────────────

  /** The bottom bar's primary button: advance one station, or finish at review. */
  pipelinePrimary(): void {
    switch (this.pipelineStep()) {
      case 'select':      this.goToStation('chapters'); break;
      case 'chapters':    this.goToStation('epub-review'); break;
      case 'epub-review': this.pipelineComplete(); break;
    }
  }

  /** The bottom bar's Back button: step one station toward the source. */
  pipelineBack(): void {
    switch (this.pipelineStep()) {
      case 'chapters':    this.enterStation('select'); break;
      case 'epub-review': this.pipelineReloadSource('chapters'); break;
    }
  }

  /**
   * Navigate to any station (chip clicks + primary/back route through here).
   * Free movement: chips let the user jump around. The only hard rule is that
   * Review can't be reached until both edit stations have been visited, and
   * leaving the read-only review reloads the source (review never edits).
   */
  goToStation(targetId: string): void {
    const target = targetId as PipelineStep;
    if (this.pipelineBusy()) return;
    const current = this.pipelineStep();
    if (target === current) return;

    // Leaving the read-only review back to an editable station: the review
    // shows the generated EPUB, so we must reload the source project.
    if (current === 'epub-review') {
      if (target === 'select' || target === 'chapters') {
        this.pipelineReloadSource(target);
      }
      return;
    }

    // Into review = generate the EPUB (gated on the edit stations being visited).
    if (target === 'epub-review') {
      if (!this.canReachReview()) return;
      this.pipelineExportAndReview();
      return;
    }

    // Moving between the two editable stations, in memory (no reload).
    // Forward into chapters auto-merges fragmented blocks into paragraphs.
    if (current === 'select' && target === 'chapters') {
      this.autoMergeForPipeline();
    }
    this.enterStation(target);
  }

  /** Set panel + step for an editable station and update visited/staleness. */
  private enterStation(target: PipelineStep): void {
    // Stations map to panels: chapters -> chapters panel; select/review -> default.
    this.activatePanel(target === 'chapters' ? 'chapters' : null);
    if (target !== 'chapters') this.viewerInteraction.set('select');
    this.pipelineStep.set(target);
    this.visitedStations.update(s => {
      const next = new Set(s);
      next.add(target);
      // Returning to editing invalidates any previously generated review.
      if (target === 'select' || target === 'chapters') next.delete('epub-review');
      return next;
    });
  }

  /**
   * Silent, paragraph-aware merge run automatically when advancing out of the
   * Remove-blocks station. No dialog — for a clean EPUB (already segmented at
   * ingestion) it finds nothing and no-ops; for a fragmented PDF it consolidates
   * single-line blocks into one block per paragraph.
   */
  private autoMergeForPipeline(): void {
    if (this.editorState.paragraphBreaks().size === 0) {
      this.detectParagraphs();
    }
    const groups = detectMergeableGroups(
      this.blocks(),
      this.deletedBlockIds(),
      this.editorState.paragraphBreaks()
    );
    if (groups.length === 0) return;
    console.log(`[autoMergeForPipeline] Consolidating into ${groups.length} paragraphs`);
    this.applyMergeGroups(groups);
  }

  /** Export EPUB and transition to review step. */
  private async pipelineExportAndReview(): Promise<void> {
    const projectPath = this.projectPath();
    if (!projectPath) {
      this.showAlert({
        title: 'Export Failed',
        message: 'No project path available. Please save the project first.',
        type: 'error'
      });
      return;
    }

    this.pipelineBusy.set(true);
    this.loading.set(true);
    this.loadingText.set('Exporting EPUB...');

    try {
      // Save project state first
      await this.saveProjectToPath(projectPath, true);

      // Pipeline always exports to exported.epub (the canonical finalized location)
      const pBreaks = this.editorState.paragraphBreaks();
      const result = await this.exportService.exportToAudiobook(
        this.getExportableBlocks(),
        this.deletedBlockIds(),
        this.chapters(),
        this.pdfName(),
        projectPath,
        this.editorState.textCorrections(),
        this.deletedPages(),
        this.getDeletedHighlights(),
        this.metadata(),
        false,
        undefined,
        undefined, // No savePath override — always creates exported.epub
        pBreaks.size > 0 ? pBreaks : undefined
      );

      if (!result.success) {
        this.showAlert({
          title: 'Export Failed',
          message: result.message || 'Failed to export EPUB',
          type: 'error'
        });
        return;
      }

      // Use the path the export ACTUALLY wrote — the on-disk layout differs between a
      // manifest project directory (source/exported.epub) and a legacy .bfp file
      // (output/exported.epub). Reconstructing `${projectPath}/source/exported.epub`
      // was wrong for legacy projects (projectPath is a file → ENOENT).
      if (!result.epubPath) {
        this.showAlert({
          title: 'Export Failed',
          message: 'Export did not report where the EPUB was written.',
          type: 'error'
        });
        return;
      }
      const epubPath = result.epubPath;

      // Remove current document from open tabs so loadPdf won't hit duplicate check
      const currentDocId = this.activeDocumentId();
      if (currentDocId) {
        this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
      }

      // Close PDF and load the exported EPUB
      this.pipelineTransitioning = true;
      this.closePdf();
      await this.loadPdf(epubPath);
      this.activatePanel(null);
      this.pipelineStep.set('epub-review');
      this.visitedStations.update(s => new Set(s).add('epub-review'));
      this.pipelineTransitioning = false;
    } catch (error) {
      this.pipelineTransitioning = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.showAlert({
        title: 'Export Failed',
        message: errorMessage,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
      this.pipelineBusy.set(false);
    }
  }

  /**
   * Leave the read-only review and reload the source project at an editable
   * station (Remove blocks or Mark chapters). The review shows the generated
   * EPUB; edits only ever happen on the source, so we reload it here.
   */
  private async pipelineReloadSource(target: 'select' | 'chapters'): Promise<void> {
    const bfp = this.bfpPath();
    if (!bfp) return;

    this.pipelineBusy.set(true);
    this.loading.set(true);
    this.loadingText.set('Reloading source...');

    try {
      // Remove current document from open tabs so loadProjectFromPath won't hit duplicate check
      const currentDocId = this.activeDocumentId();
      if (currentDocId) {
        this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
      }

      this.pipelineTransitioning = true;
      this.closePdf();
      await this.loadProjectFromPath(bfp);
      this.enterStation(target);
      this.pipelineTransitioning = false;
    } catch (error) {
      this.pipelineTransitioning = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.showAlert({
        title: 'Load Failed',
        message: errorMessage,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
      this.pipelineBusy.set(false);
    }
  }

  /** Complete the pipeline: save EPUB changes and emit finalized event. */
  private async pipelineComplete(): Promise<void> {
    const epubPath = this.effectivePath();
    if (!epubPath) return;

    this.pipelineBusy.set(true);
    this.loading.set(true);
    this.loadingText.set('Saving...');

    try {
      const pBreaks = this.editorState.paragraphBreaks();
      const result = await this.exportService.saveToEpub(
        this.blocks(),
        this.deletedBlockIds(),
        this.chapters(),
        this.pdfName(),
        epubPath,
        this.editorState.textCorrections(),
        this.deletedPages(),
        this.getDeletedHighlights(),
        this.metadata(),
        pBreaks.size > 0 ? pBreaks : undefined
      );

      if (result.success) {
        this.pipelineStep.set('select');
        this.visitedStations.set(new Set<PipelineStep>(['select']));
        this.finalized.emit({ success: true, epubPath });
        this.showAlert({
          title: 'Complete',
          message: 'EPUB saved successfully.',
          type: 'success'
        });
      } else {
        this.showAlert({
          title: 'Save Failed',
          message: result.message || 'Failed to save EPUB',
          type: 'error'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.showAlert({
        title: 'Save Failed',
        message: errorMessage,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
      this.pipelineBusy.set(false);
    }
  }

  /**
   * Save changes back to the source EPUB file.
   * Used when editing an EPUB directly (not via BFP project).
   */
  private async saveToSourceEpub(epubPath: string): Promise<void> {
    try {
      const chapters = this.chapters();
      const deletedHighlights = this.getDeletedHighlights();
      const blocks = this.blocks();
      const deletedBlockIds = this.deletedBlockIds();
      const deletedPages = this.deletedPages();

      console.log('[saveToSourceEpub] Starting save to:', epubPath);
      console.log('[saveToSourceEpub] Total blocks:', blocks.length);
      console.log('[saveToSourceEpub] Deleted block IDs:', deletedBlockIds.size);
      console.log('[saveToSourceEpub] Deleted pages:', deletedPages.size);
      console.log('[saveToSourceEpub] Chapters:', chapters.length);

      // Generate the EPUB with the same logic as export, but write to the source path
      const savePB = this.editorState.paragraphBreaks();
      const result = await this.exportService.saveToEpub(
        blocks,
        deletedBlockIds,
        chapters,
        this.pdfName(),
        epubPath, // Save back to the source file
        this.editorState.textCorrections(),
        deletedPages,
        deletedHighlights,
        this.metadata(),
        savePB.size > 0 ? savePB : undefined
      );

      if (result.success) {
        // Clear unsaved changes flag
        this.editorState.markSaved();

        // Enter paragraph fix mode to auto-detect and fix paragraph breaks
        this.enterParagraphFixMode(epubPath);
      } else {
        this.finalized.emit({
          success: false,
          error: result.message || 'Failed to save changes'
        });

        this.showAlert({
          title: 'Save Failed',
          message: result.message || 'Failed to save changes to EPUB',
          type: 'error'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.finalized.emit({
        success: false,
        error: errorMessage
      });

      this.showAlert({
        title: 'Save Failed',
        message: errorMessage,
        type: 'error'
      });
    }
  }

  /**
   * Library mode: Replace the existing ebook file with saved changes.
   */
  async librarySaveReplace(): Promise<void> {
    this.showLibrarySaveModal.set(false);
    await this.saveToSourceEpub(this.librarySourcePath()!);
  }

  /**
   * Library mode: Save changes as a new file alongside the original.
   */
  async librarySaveAsNew(): Promise<void> {
    this.showLibrarySaveModal.set(false);
    const originalPath = this.librarySourcePath()!;
    const newPath = await this.electronService.generateUniqueFilename(originalPath, 'edited');
    if (newPath) {
      await this.saveToSourceEpub(newPath);
    } else {
      this.showAlert({
        title: 'Save Failed',
        message: 'Could not generate a unique filename',
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
    this.setSelectionWithHistory(blockIds);

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

    // Manifest projects (directories) are the current model — an imported book is
    // ALWAYS one. Bind to its directory so downstream saves/exports use the manifest
    // layout (source/exported.epub). Skipping this is what let the editor mint a
    // phantom legacy .bfp sibling and bind to it, breaking "Generate & review".
    const manifestMatch = await this.electronService.findManifestProjectBySource(
      currentFileHash,
      currentLibraryPath || pdfPath,
    );
    if (manifestMatch.found && manifestMatch.projectPath) {
      await this.restoreProjectState(manifestMatch.projectPath);
      return;
    }

    // Fall back to a legacy .bfp project (un-migrated). Match only — never create.
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

    // No existing project → create a MANIFEST project (never a legacy .bfp). The
    // importer copies the source into archive/ and writes manifest.json; its
    // duplicate guard binds to an existing project if one already matches by hash.
    const created = await this.electronService.audiobookImportEpub(pdfPath);
    const createdDir = created.projectPath || created.bfpPath || created.existingProjectPath;
    if (createdDir) {
      await this.restoreProjectState(createdDir);
    } else {
      console.error('[autoCreateProject] Could not create a manifest project:', created.error);
      this.showAlert({
        title: 'Could not create project',
        message: created.error || 'Failed to create a project for this document.',
        type: 'error',
      });
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
    this.projectCreatedAt = project.created_at || null;

    // Restore deleted block IDs
    if (project.deleted_block_ids && project.deleted_block_ids.length > 0) {
      this.editorState.deletedBlockIds.set(new Set(project.deleted_block_ids));
    }

    // Restore persistent crop regions
    this.editorState.cropRegions.set(this.deserializeCropRegions(project.crop_regions));

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

    // Restore chapters (or auto-extract from EPUB if none saved)
    if (project.chapters && project.chapters.length > 0) {
      this.chapters.set(project.chapters);
      this.chaptersSource.set(project.chapters_source || 'manual');
    } else if (project.source_path?.toLowerCase().endsWith('.epub')) {
      // No chapters in project, but it's an EPUB - try to extract from nav.xhtml
      this.tryLoadOutline();
    }

    // Restore paragraph breaks
    if (project.paragraph_breaks && project.paragraph_breaks.length > 0) {
      this.editorState.paragraphBreaks.set(new Set(project.paragraph_breaks));
    }

    // Restore category corrections and learned categories (applied to blocks later)
    if (project.category_corrections && project.category_corrections.length > 0) {
      this.editorState.categoryCorrections.set(new Map(project.category_corrections));
    }
    if (project.learned_categories && project.learned_categories.length > 0) {
      this.editorState.learnedCategories.set(new Map(project.learned_categories));
    }

    // Restore classification thresholds
    if (project.classification_thresholds) {
      this.editorState.classificationThresholds.set(project.classification_thresholds);
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
      const ocrPages = [...new Set(project.ocr_blocks.map(b => b.page))];
      this.editorState.replaceTextBlocksOnPages(ocrPages, project.ocr_blocks);

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

      if (project.ocr_categories) {
        this.editorState.categories.set(project.ocr_categories);
      }
    }

    // Restore block edits (text corrections, position/size changes)
    if (project.block_edits) {
      this.editorState.blockEdits.set(new Map(Object.entries(project.block_edits)));
    }

    // Restore remove backgrounds state
    if (project.remove_backgrounds) {
      this.editorState.removeBackgrounds.set(true);
    }

    // Apply category corrections AFTER all block mutations (OCR blocks, block edits)
    // are done. Otherwise, replaceTextBlocksOnPages or categories.set will overwrite
    // the corrected category_ids.
    if (this.editorState.categoryCorrections().size > 0) {
      this.editorState.applyCategoryCorrections();
      this.editorState.updateCategoryStats();
    }

    // Restore block splits: re-fetch spans and rebuild child blocks
    if (project.block_splits && project.block_splits.length > 0) {
      await this.restoreBlockSplits(project.block_splits);
    }

    // Restore block merges: find source blocks and rebuild merged blocks
    if (project.block_merges && project.block_merges.length > 0) {
      this.restoreBlockMerges(project.block_merges);

      // Clean up deletedBlockIds: old saves stored merge source IDs there,
      // but mergeBlocks() now removes source blocks from the array instead.
      // Remove any stale source IDs from deletedBlockIds so they don't cause issues.
      const mergeSourceIds = new Set<string>();
      for (const m of project.block_merges) {
        for (const srcId of m.sourceBlockIds) mergeSourceIds.add(srcId);
      }
      if (mergeSourceIds.size > 0) {
        this.editorState.deletedBlockIds.update(deleted => {
          const next = new Set(deleted);
          for (const srcId of mergeSourceIds) next.delete(srcId);
          return next;
        });
      }
    }

    // Suppress auto-save triggered by replaceTextBlocksOnPages() during restore.
    // Loading existing state should not be treated as a user change.
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }
    this.editorState.markSaved();

    console.log('[restoreProjectState] Restored project from:', projectFilePath,
      'chapters:', project.chapters?.length || 0,
      'ocrBlocks:', project.ocr_blocks?.length || 0,
      'ocrCategories:', project.ocr_categories ? Object.keys(project.ocr_categories).length : 0,
      'blockSplits:', project.block_splits?.length || 0,
      'blockMerges:', project.block_merges?.length || 0);
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
      // No project bound yet (edit landed before binding completed) — establish a
      // MANIFEST project, then persist the current edits into it. Never mints a .bfp.
      await this.autoCreateProject(this.pdfPath() || this.libraryPath(), this.pdfName());
      const bound = this.projectPath();
      if (bound) await this.saveProjectToPath(bound, true);
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
      // No project bound yet — establish a MANIFEST project, then save into it.
      await this.autoCreateProject(this.pdfPath() || this.libraryPath(), this.pdfName());
      const bound = this.projectPath();
      if (bound) await this.saveProjectToPath(bound);
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
      ocr_categories: ocrBlocks.length > 0 ? this.categories() : undefined,
      chapters: chapters.length > 0 ? chapters : undefined,
      chapters_source: chapters.length > 0 ? chaptersSource : undefined,
      deleted_pages: this.deletedPages().size > 0 ? [...this.deletedPages()] : undefined,
      metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
      paragraph_breaks: this.editorState.paragraphBreaks().size > 0 ? [...this.editorState.paragraphBreaks()] : undefined,
      category_corrections: this.editorState.categoryCorrections().size > 0 ? [...this.editorState.categoryCorrections().entries()] : undefined,
      learned_categories: this.editorState.learnedCategories().size > 0 ? [...this.editorState.learnedCategories().entries()] : undefined,
      classification_thresholds: isDefaultThresholds(this.editorState.classificationThresholds())
        ? undefined : this.editorState.classificationThresholds(),
      block_merges: this.editorState.blockMerges().size > 0
        ? [...this.editorState.blockMerges().values()].map(m => ({
            mergedBlockId: m.mergedBlockId,
            sourceBlockIds: m.sourceBlockIds,
          }))
        : undefined,
      crop_regions: this.serializeCropRegions(),
      created_at: this.projectCreatedAt ?? new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    const suggestedName = this.pdfName().replace(/\.[^.]+$/, '') + '.bfp';
    const result = await this.electronService.saveProject(projectData, suggestedName);

    if (result.success && result.filePath) {
      this.projectPath.set(result.filePath);
      this.projectCreatedAt = projectData.created_at;
      this.editorState.markSaved();
    } else if (result.error) {
      this.showAlert({
        title: 'Save Failed',
        message: 'Failed to save project: ' + result.error,
        type: 'error'
      });
    }
  }

  /** Serialize persistent crop regions (Map → plain Record) for project save. */
  private serializeCropRegions(): BookForgeProject['crop_regions'] | undefined {
    const regions = this.editorState.cropRegions();
    if (regions.size === 0) return undefined;
    const out: NonNullable<BookForgeProject['crop_regions']> = {};
    for (const [page, region] of regions) {
      out[String(page)] = {
        rect: { ...region.rect },
        deletedBlockIds: [...region.deletedBlockIds],
      };
    }
    return out;
  }

  /** Restore persistent crop regions (plain Record → Map) from a loaded project. */
  private deserializeCropRegions(data: BookForgeProject['crop_regions']): Map<number, CropRegion> {
    const regions = new Map<number, CropRegion>();
    if (!data) return regions;
    for (const [pageStr, region] of Object.entries(data)) {
      regions.set(Number(pageStr), {
        rect: { ...region.rect },
        deletedBlockIds: [...region.deletedBlockIds],
      });
    }
    return regions;
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
    // Snapshot the change generation so we only clear the dirty flag if no
    // new edit happened while the save IPC was in flight
    const generationAtSerialize = this.editorState.changeGeneration();
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
      deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : [],
      page_order: order.length > 0 ? order : [],
      block_edits: blockEditsRecord,
      remove_backgrounds: this.removeBackgrounds() || false,
      deleted_pages: [...this.deletedPages()],
      ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
      ocr_categories: categoriesToSave,
      custom_categories: customCategories.length > 0 ? customCategories : undefined,
      undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
      redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
      chapters: chapters.length > 0 ? chapters : undefined,
      chapters_source: chapters.length > 0 ? chaptersSource : undefined,
      metadata: Object.keys(this.metadata()).length > 0 ? this.metadata() : undefined,
      paragraph_breaks: this.editorState.paragraphBreaks().size > 0 ? [...this.editorState.paragraphBreaks()] : undefined,
      category_corrections: this.editorState.categoryCorrections().size > 0 ? [...this.editorState.categoryCorrections().entries()] : undefined,
      learned_categories: this.editorState.learnedCategories().size > 0 ? [...this.editorState.learnedCategories().entries()] : undefined,
      classification_thresholds: isDefaultThresholds(this.editorState.classificationThresholds())
        ? undefined : this.editorState.classificationThresholds(),
      block_splits: this.editorState.blockSplits().size > 0
        ? [...this.editorState.blockSplits().values()].map(s => ({
            originalBlockId: s.originalBlockId,
            splitPoints: s.splitPoints,
            childBlockIds: s.childBlockIds,
          }))
        : undefined,
      block_merges: this.editorState.blockMerges().size > 0
        ? [...this.editorState.blockMerges().values()].map(m => ({
            mergedBlockId: m.mergedBlockId,
            sourceBlockIds: m.sourceBlockIds,
          }))
        : undefined,
      crop_regions: this.serializeCropRegions(),
      created_at: this.projectCreatedAt ?? new Date().toISOString(),
      modified_at: new Date().toISOString()
    };

    console.log('[saveProjectToPath]', filePath,
      'category_corrections:', projectData.category_corrections?.length ?? 0,
      'paragraph_breaks:', projectData.paragraph_breaks?.length ?? 0,
      'block_splits:', projectData.block_splits?.length ?? 0,
      'block_merges:', projectData.block_merges?.length ?? 0);

    const result = await this.electronService.saveProjectToPath(filePath, projectData);

    if (result.success) {
      console.log('[saveProjectToPath] SUCCESS');
      this.projectCreatedAt = projectData.created_at;
      // Only clear the dirty flag if no edit occurred while the save was in
      // flight — otherwise the newer changes would be silently marked saved
      if (this.editorState.changeGeneration() === generationAtSerialize) {
        this.editorState.markSaved();
      } else {
        console.log('[saveProjectToPath] Edits occurred during save; keeping dirty flag set');
        // The auto-save effect won't refire (the signal never went false), so
        // explicitly reschedule to persist the newer edits
        this.scheduleAutoSave();
      }
    } else {
      console.error('[saveProjectToPath] FAILED:', result.error, 'path:', filePath);
      if (!silent) {
        this.showAlert({
          title: 'Save Failed',
          message: 'Failed to save project: ' + result.error,
          type: 'error'
        });
      }
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

    // Normalize field names (handle legacy camelCase variants)
    const sourcePath = project.source_path || (project as any).sourcePath;
    const sourceName = project.source_name || (project as any).sourceName;
    const libraryPath = project.library_path || (project as any).libraryPath;
    const fileHash = project.file_hash || (project as any).fileHash;

    // Validate project data
    if (!project.version || !sourcePath) {
      console.error('[openProject] Invalid project data:', {
        version: project.version,
        source_path: project.source_path,
        sourcePath: (project as any).sourcePath,
        keys: Object.keys(project)
      });
      this.showAlert({
        title: 'Invalid Project',
        message: `This file does not appear to be a valid BookForge project.\n\nMissing: ${!project.version ? 'version' : ''} ${!sourcePath ? 'source_path' : ''}`.trim(),
        type: 'error'
      });
      return;
    }

    // Apply normalized values back
    project.source_path = sourcePath;
    project.source_name = sourceName;
    project.library_path = libraryPath;
    project.file_hash = fileHash;

    // Load the source file - try original first, fall back to exported EPUB
    this.loading.set(true);
    this.loadingText.set('Loading project...');

    let pdfPathToLoad: string | undefined;

    // First, try to resolve the original source file
    if (sourcePath) {
      const resolveResult = await this.electronService.libraryResolveSource({
        libraryPath: libraryPath,
        sourcePath: sourcePath,
        fileHash: fileHash,
        sourceName: sourceName
      });

      if (resolveResult.success && resolveResult.resolvedPath) {
        pdfPathToLoad = resolveResult.resolvedPath;
      }
    }

    // If original source not found, fall back to exported EPUB (single source of truth)
    if (!pdfPathToLoad) {
      const exportedEpubPath = (project as any).audiobook?.exportedEpubPath;
      if (exportedEpubPath) {
        const exists = await this.electronService.fsExists(exportedEpubPath);
        if (exists) {
          pdfPathToLoad = exportedEpubPath;
          console.log('[openProject] Using exported EPUB as source:', exportedEpubPath);
        } else {
          // Try cross-platform path translation (BFP from another OS)
          const translated = await this.electronService.libraryTranslatePath(exportedEpubPath);
          if (translated.success && translated.translated) {
            pdfPathToLoad = translated.translated;
            console.log('[openProject] Using cross-platform translated exported EPUB:', translated.translated);
          }
        }
      }
    }

    if (!pdfPathToLoad) {
      this.loading.set(false);
      const exportedPath = (project as any).audiobook?.exportedEpubPath;
      this.showAlert({
        title: 'Source File Not Found',
        message: `Could not find any source file for this project.\n\nOriginal: ${sourceName || sourcePath || 'not set'}\nExported: ${exportedPath || 'not set'}\n\nThe file may need to be imported to your library on this machine.`,
        type: 'error'
      });
      return;
    }

    try {
      const unsubProgress = this.electronService.onAnalyzeProgress((progress) => {
        this.loadingText.set(progress.message);
      });
      let quickResult;
      try {
        quickResult = await this.pdfService.analyzePdfQuick(pdfPathToLoad);
      } finally {
        unsubProgress();
      }

      // Cache hit may carry warnings recorded when the analysis was produced
      this.surfaceAnalysisWarnings(quickResult.warnings);

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

      // Load document state via service — use full data on cache hit, empty on miss
      this.editorState.loadDocument({
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
        pdfName: quickResult.pdf_name,
        pdfPath: sourcePath || pdfPathToLoad,
        libraryPath: pdfPathToLoad,
        fileHash: fileHash || '',
        deletedBlockIds: new Set(project.deleted_block_ids || []),
        deletedPages: new Set<number>(project.deleted_pages || []),
        pageOrder: project.page_order || [],
        blockEdits: quickResult.textReady ? blockEditsMap : undefined,
        paragraphBreaks: project.paragraph_breaks?.length ? new Set(project.paragraph_breaks) : undefined,
        categoryCorrections: project.category_corrections?.length ? new Map(project.category_corrections) : undefined,
        learnedCategories: project.learned_categories?.length ? new Map(project.learned_categories) : undefined,
        classificationThresholds: project.classification_thresholds || undefined,
        cropRegions: this.deserializeCropRegions(project.crop_regions),
      });

      // Restore undo/redo history from project (loadDocument clears it)
      if (project.undo_stack || project.redo_stack) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      // Reset per-document component state so the previous document's data
      // doesn't leak into this project (the restores below are conditional)
      this.chapters.set([]);
      this.chaptersSource.set('manual');
      this.metadata.set({});
      this.categoryHighlights.set(new Map());
      this.deletedHighlightIds.set(new Set());
      this.splitConfig.set(this.defaultSplitConfig());
      this.splitApplied.set(false);
      this.blankedPages.set(new Set());
      this.projectCreatedAt = project.created_at || null;

      // Restore custom categories
      if (project.custom_categories && project.custom_categories.length > 0) {
        this.restoreCustomCategories(project.custom_categories);
      }

      // Restore deleted highlight IDs
      if (project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
        this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
      }

      // Restore chapters (or auto-extract from EPUB if none saved)
      if (project.chapters && project.chapters.length > 0) {
        this.chapters.set(project.chapters);
        this.chaptersSource.set(project.chapters_source || 'manual');
      } else if (pdfPathToLoad.toLowerCase().endsWith('.epub')) {
        // No chapters in project, but it's an EPUB - try to extract from nav.xhtml
        this.tryLoadOutline();
      }

      // Restore metadata
      if (project.metadata) {
        this.metadata.set(project.metadata);
      }

      // Restore paragraph breaks
      if (project.paragraph_breaks && project.paragraph_breaks.length > 0) {
        this.editorState.paragraphBreaks.set(new Set(project.paragraph_breaks));
      }

      // Restore category corrections and apply to blocks (AFTER all block mutations)
      if (project.category_corrections && project.category_corrections.length > 0) {
        this.editorState.categoryCorrections.set(new Map(project.category_corrections));
        if (quickResult.textReady) {
          this.editorState.applyCategoryCorrections();
          this.editorState.updateCategoryStats();
        }
      }

      // Restore classification thresholds
      if (project.classification_thresholds) {
        this.editorState.classificationThresholds.set(project.classification_thresholds);
      }

      this.pageRenderService.clear();
      this.projectService.projectPath.set(result.filePath || null);

      // Initialize page rendering - starts in background, doesn't block
      this.pageRenderService.initialize(this.effectivePath(), quickResult.page_count);

      // Start on-demand page rendering (only visible pages)
      this.pageRenderService.startOnDemandRendering(quickResult.page_count);

      // If text not ready (cache miss), start background extraction
      // Store project config so text-ready handler can apply block edits later
      if (!quickResult.textReady) {
        // Generate a docId to track — openProject doesn't use the tab system the same way,
        // so we use a synthetic ID based on the project path
        const syntheticDocId = 'project_' + Date.now().toString(36);
        // Store block edits to apply when text arrives
        const pendingEdits = blockEditsMap;
        const pendingDeletedBlockIds = new Set(project.deleted_block_ids || []);
        const pendingCatCorrections = project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined;

        this.editorState.textLoading.set(true);
        const unsub = this.electronService.onTextReady((data) => {
          // Ignore text-ready events for other documents (a missing pdfPath is
          // treated as a match for safety during the transition period)
          if (data.pdfPath && data.pdfPath !== pdfPathToLoad) {
            return;
          }

          unsub();
          this.textReadyUnsubs.delete(syntheticDocId);
          this.surfaceAnalysisWarnings(data.warnings);
          this.editorState.updateTextData({
            blocks: data.blocks as TextBlock[],
            categories: data.categories as Record<string, Category>,
          });
          // Apply deferred block edits and deleted block IDs now that blocks exist
          if (pendingEdits) {
            this.editorState.blockEdits.set(pendingEdits);
          }
          if (pendingDeletedBlockIds.size > 0) {
            this.editorState.deletedBlockIds.set(pendingDeletedBlockIds);
          }
          // Apply category corrections now that blocks exist
          if (pendingCatCorrections && pendingCatCorrections.size > 0) {
            this.editorState.applyCategoryCorrections();
            this.editorState.updateCategoryStats();
          }
        });

        // Track for cleanup on component destroy
        this.textReadyUnsubs.set(syntheticDocId, unsub);

        // Fire-and-forget text extraction
        this.pdfService.analyzePdfText(pdfPathToLoad).catch(err => {
          console.error('[openProject] Background text extraction failed:', err);
          this.editorState.textLoading.set(false);
          unsub();
          this.textReadyUnsubs.delete(syntheticDocId);
        });
      }

      // Suppress auto-save triggered during restore — loading state is not a user change
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
      }
      this.editorState.markSaved();
    } catch (err) {
      console.error('Failed to load project source file:', err);
      const errorMsg = (err as Error).message || String(err);
      this.showAlert({
        title: 'Failed to Load Source',
        message: `Could not load:\n${pdfPathToLoad}\n\n${errorMsg}`,
        type: 'error'
      });
    } finally {
      this.loading.set(false);
    }
  }

  async loadProjectFromPath(filePath: string, lightweight: boolean = false): Promise<void> {
    // Clear sourceFilePath when loading via BFP - we want finalize to use the BFP export flow
    this.sourceFilePath.set(null);
    if (!this.pipelineTransitioning) {
      this.pipelineStep.set('select');
      this.visitedStations.set(new Set<PipelineStep>(['select']));
    }

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

    // Normalize field names (handle legacy camelCase variants)
    const sourcePath = project.source_path || (project as any).sourcePath;
    const sourceName = project.source_name || (project as any).sourceName;
    const libraryPath = project.library_path || (project as any).libraryPath;
    const fileHash = project.file_hash || (project as any).fileHash;

    // Validate project data
    if (!project.version || !sourcePath) {
      console.error('[loadProjectFromPath] Invalid project data:', {
        version: project.version,
        source_path: project.source_path,
        sourcePath: (project as any).sourcePath,
        keys: Object.keys(project)
      });
      this.showAlert({
        title: 'Invalid Project',
        message: `This file does not appear to be a valid BookForge project.\n\nMissing: ${!project.version ? 'version' : ''} ${!sourcePath ? 'source_path' : ''}`.trim(),
        type: 'error'
      });
      return;
    }

    // Apply normalized values back
    project.source_path = sourcePath;
    project.source_name = sourceName;
    project.library_path = libraryPath;
    project.file_hash = fileHash;

    // EPUBs are now handled by the PDF picker via mupdf (renders them as pages)
    // No special routing needed - both PDFs and EPUBs load the same way

    // Save current document state before loading new one
    this.saveCurrentDocumentState();

    // Load the source file - check override, then original, then fall back to exported EPUB
    this.loading.set(true);
    this.loadingText.set('Loading project...');

    let pdfPathToLoad: string | undefined;
    let usingExportedEpub = false;

    // First, check if an override source path was provided (from version picker)
    const overridePath = this.overrideSourcePath();
    if (overridePath) {
      const exists = await this.electronService.fsExists(overridePath);
      if (exists) {
        pdfPathToLoad = overridePath;
      }
    }

    // Second, try to resolve the original source file
    if (!pdfPathToLoad && project.source_path) {
      const resolveResult = await this.electronService.libraryResolveSource({
        libraryPath: project.library_path,
        sourcePath: project.source_path,
        fileHash: project.file_hash,
        sourceName: project.source_name
      });

      if (resolveResult.success && resolveResult.resolvedPath) {
        pdfPathToLoad = resolveResult.resolvedPath;
      }
    }

    // Third, fall back to exported EPUB (single source of truth)
    if (!pdfPathToLoad) {
      const exportedEpubPath = (project as any).audiobook?.exportedEpubPath;
      if (exportedEpubPath) {
        const exists = await this.electronService.fsExists(exportedEpubPath);
        if (exists) {
          pdfPathToLoad = exportedEpubPath;
          usingExportedEpub = true;
        } else {
          const translated = await this.electronService.libraryTranslatePath(exportedEpubPath);
          if (translated.success && translated.translated) {
            pdfPathToLoad = translated.translated;
            usingExportedEpub = true;
          }
        }
      }
    }

    if (!pdfPathToLoad) {
      this.loading.set(false);
      const exportedPath = (project as any).audiobook?.exportedEpubPath;
      this.showAlert({
        title: 'Source File Not Found',
        message: `Could not find any source file for this project.\n\nOriginal: ${project.source_name || project.source_path || 'not set'}\nExported: ${exportedPath || 'not set'}\n\nThe file may need to be imported to your library on this machine.`,
        type: 'error'
      });
      return;
    }

    try {
      const unsubProgress = this.electronService.onAnalyzeProgress((progress) => {
        this.loadingText.set(progress.message);
      });
      let quickResult;
      try {
        quickResult = await this.pdfService.analyzePdfQuick(pdfPathToLoad);
      } finally {
        unsubProgress();
      }

      // Cache hit may carry warnings recorded when the analysis was produced
      this.surfaceAnalysisWarnings(quickResult.warnings);

      // Create new document for tabs
      const docId = this.generateDocumentId();

      // Determine if we're loading the original source or a derived version (exported/cleaned)
      const resolvedOriginalPath = project.library_path || project.source_path;
      const isLoadingOriginal = !usingExportedEpub && (
        !this.overrideSourcePath() ||  // No override = loading original
        pdfPathToLoad === resolvedOriginalPath ||  // Override matches original
        pdfPathToLoad === project.library_path  // Override is the library copy
      );

      const deletedBlockIds = isLoadingOriginal
        ? new Set<string>(project.deleted_block_ids || [])
        : new Set<string>();
      const deletedPages = isLoadingOriginal
        ? new Set<number>(project.deleted_pages || [])
        : new Set<number>();
      const pageOrder = isLoadingOriginal ? (project.page_order || []) : [];
      // Crop is an original-only concern (derived versions already have the crop
      // baked into their blocks), mirroring deletedBlockIds' gating.
      const cropRegions = isLoadingOriginal
        ? this.deserializeCropRegions(project.crop_regions)
        : new Map<number, CropRegion>();

      const newDoc: OpenDocument = {
        id: docId,
        path: project.source_path || pdfPathToLoad,
        libraryPath: pdfPathToLoad,
        fileHash: project.file_hash || '',
        name: project.source_name || quickResult.pdf_name,
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
        deletedBlockIds: deletedBlockIds,
        deletedPages: deletedPages,
        cropRegions: cropRegions,
        selectedBlockIds: [],
        pageOrder: pageOrder,
        pageImages: new Map(),
        hasUnsavedChanges: false,
        projectPath: actualProjectPath,
        undoStack: project.undo_stack || [],
        redoStack: project.redo_stack || [],
        lightweightMode: lightweight,
        categoryCorrections: isLoadingOriginal && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined,
        learnedCategories: isLoadingOriginal && project.learned_categories?.length
          ? new Map(project.learned_categories) : undefined,
        paragraphBreaks: isLoadingOriginal && project.paragraph_breaks?.length
          ? new Set(project.paragraph_breaks) : undefined,
        createdAt: project.created_at || undefined,
      };

      // Add to open documents
      this.openDocuments.update(docs => [...docs, newDoc]);
      this.activeDocumentId.set(docId);

      // Reset per-document component state so the previous tab's data doesn't
      // leak into this project (the restores below are conditional)
      this.chapters.set([]);
      this.chaptersSource.set('manual');
      this.metadata.set({});
      this.categoryHighlights.set(new Map());
      this.deletedHighlightIds.set(new Set());
      this.splitConfig.set(this.defaultSplitConfig());
      this.splitApplied.set(false);
      this.blankedPages.set(new Set());
      this.projectCreatedAt = project.created_at || null;

      // Convert block edits Record to Map if present, fall back to text_corrections for legacy
      // Only load block edits when loading the original - edits are baked into exported versions
      let blockEditsMap: Map<string, BlockEdit> | undefined;
      if (isLoadingOriginal) {
        if (project.block_edits) {
          blockEditsMap = new Map(Object.entries(project.block_edits));
        } else if (project.text_corrections) {
          // Legacy: convert text_corrections to blockEdits
          blockEditsMap = new Map();
          Object.entries(project.text_corrections).forEach(([blockId, text]) => {
            blockEditsMap!.set(blockId, { text });
          });
        }
      }

      // Load document state via service — defer block edits if text not ready
      this.editorState.loadDocument({
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
        pdfName: project.source_name || quickResult.pdf_name,
        pdfPath: project.source_path || pdfPathToLoad,
        libraryPath: pdfPathToLoad,
        fileHash: project.file_hash || '',
        deletedBlockIds: quickResult.textReady ? deletedBlockIds : new Set(),
        deletedPages: deletedPages,
        pageOrder: pageOrder,
        blockEdits: quickResult.textReady ? blockEditsMap : undefined,
        paragraphBreaks: isLoadingOriginal && project.paragraph_breaks?.length
          ? new Set(project.paragraph_breaks) : undefined,
        categoryCorrections: isLoadingOriginal && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined,
        learnedCategories: isLoadingOriginal && project.learned_categories?.length
          ? new Map(project.learned_categories) : undefined,
        // cropRegions is display + reversal metadata; it doesn't depend on
        // blocks being present, so it can be set even before text is ready
        // (updateTextData preserves it). Deletions are applied via deletedBlockIds.
        cropRegions,
      });

      // Restore undo/redo history from project (loadDocument clears it)
      // Only load history when loading the original - it's not relevant for exported versions
      if (isLoadingOriginal && (project.undo_stack || project.redo_stack)) {
        this.editorState.setHistory({
          undoStack: project.undo_stack || [],
          redoStack: project.redo_stack || []
        });
      }

      // Restore custom categories - keep these for non-original versions too
      // as they define patterns that might still be useful
      if (project.custom_categories && project.custom_categories.length > 0) {
        this.restoreCustomCategories(project.custom_categories);
      }

      // Restore deleted highlight IDs - only for original, baked into exported
      if (isLoadingOriginal && project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
        this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
      }

      // Restore chapters - for non-original EPUBs, always extract from the file's TOC
      // since the exported version has its own structure
      if (isLoadingOriginal && project.chapters && project.chapters.length > 0) {
        this.chapters.set(project.chapters);
        this.chaptersSource.set(project.chapters_source || 'manual');
      } else if (pdfPathToLoad.toLowerCase().endsWith('.epub')) {
        // Extract chapters from EPUB's nav.xhtml
        this.tryLoadOutline();
      }

      // Restore metadata
      if (project.metadata) {
        this.metadata.set(project.metadata);
      }

      // Restore OCR blocks and categories - only for original source file
      // OCR blocks are from the original PDF and don't match derived files (EPUB pages differ)
      // Only apply immediately when text is ready; defer if text is loading
      if (quickResult.textReady && isLoadingOriginal && project.ocr_blocks && project.ocr_blocks.length > 0) {
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

      // Restore remove backgrounds state - only for original source file
      if (isLoadingOriginal && project.remove_backgrounds) {
        this.editorState.removeBackgrounds.set(true);
      }

      // Restore paragraph breaks
      if (isLoadingOriginal && project.paragraph_breaks && project.paragraph_breaks.length > 0) {
        this.editorState.paragraphBreaks.set(new Set(project.paragraph_breaks));
      }

      // Restore category corrections and apply them to blocks (AFTER all block mutations)
      if (isLoadingOriginal && project.category_corrections && project.category_corrections.length > 0) {
        this.editorState.categoryCorrections.set(new Map(project.category_corrections));
        if (quickResult.textReady) {
          this.editorState.applyCategoryCorrections();
          this.editorState.updateCategoryStats();
        }
      }

      // Restore block splits: re-fetch spans and rebuild child blocks
      if (isLoadingOriginal && quickResult.textReady && project.block_splits && project.block_splits.length > 0) {
        await this.restoreBlockSplits(project.block_splits);
      }

      // Restore block merges: find source blocks and rebuild merged blocks
      if (isLoadingOriginal && quickResult.textReady && project.block_merges && project.block_merges.length > 0) {
        this.restoreBlockMerges(project.block_merges);

        // Clean up deletedBlockIds: remove any stale source IDs
        const mergeSourceIds = new Set<string>();
        for (const m of project.block_merges) {
          for (const srcId of m.sourceBlockIds) mergeSourceIds.add(srcId);
        }
        if (mergeSourceIds.size > 0) {
          this.editorState.deletedBlockIds.update(deleted => {
            const next = new Set(deleted);
            for (const srcId of mergeSourceIds) next.delete(srcId);
            return next;
          });
        }
      }

      // Restore classification thresholds
      if (isLoadingOriginal && project.classification_thresholds) {
        this.editorState.classificationThresholds.set(project.classification_thresholds);
      }

      this.pageRenderService.clear();
      this.projectService.projectPath.set(actualProjectPath);

      // Set lightweight mode
      this.lightweightMode.set(lightweight);

      // Always initialize page rendering (so OCR can work)
      // But only load pages if NOT in lightweight mode
      const renderPath = this.effectivePath();
      this.pageRenderService.initialize(renderPath, quickResult.page_count);

      // Show document immediately
      this.pdfLoaded.set(true);

      // Start on-demand page rendering (skip if lightweight mode)
      if (!lightweight) {
        // If background removal is enabled, apply it after initial pages load
        if (project.remove_backgrounds) {
          this.pageRenderService.startOnDemandRendering(quickResult.page_count).then(() => {
            this.applyRemoveBackgrounds(true);
          });
        } else {
          this.pageRenderService.startOnDemandRendering(quickResult.page_count);
        }
      }

      // If text not ready (cache miss), start background extraction
      if (!quickResult.textReady) {
        // Store project config so text-ready handler can apply deferred state
        const pendingBlockEdits = blockEditsMap;
        const pendingDeletedBlockIds = deletedBlockIds;
        const pendingOcrBlocks = isLoadingOriginal ? project.ocr_blocks : undefined;
        const pendingOcrCategories = isLoadingOriginal ? project.ocr_categories : undefined;
        const pendingCategoryCorrections = isLoadingOriginal && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined;
        const pendingBlockSplits = isLoadingOriginal ? project.block_splits : undefined;
        const pendingBlockMerges = isLoadingOriginal ? project.block_merges : undefined;

        this.editorState.textLoading.set(true);
        const unsub = this.electronService.onTextReady(async (data) => {
          // Ignore text-ready events for other documents (a missing pdfPath is
          // treated as a match for safety during the transition period)
          if (data.pdfPath && data.pdfPath !== pdfPathToLoad) {
            return;
          }

          unsub();
          this.textReadyUnsubs.delete(docId);

          // Surface non-fatal extraction problems (e.g. images failed) to the user
          this.surfaceAnalysisWarnings(data.warnings);

          // Update blocks/categories from extraction
          if (this.activeDocumentId() === docId) {
            this.editorState.updateTextData({
              blocks: data.blocks as TextBlock[],
              categories: data.categories as Record<string, Category>,
            });

            // Now apply deferred project state
            if (pendingBlockEdits) {
              this.editorState.blockEdits.set(pendingBlockEdits);
            }
            if (pendingDeletedBlockIds.size > 0) {
              this.editorState.deletedBlockIds.set(pendingDeletedBlockIds);
            }

            // Apply OCR blocks now that text blocks exist
            if (pendingOcrBlocks && pendingOcrBlocks.length > 0) {
              const ocrPages = [...new Set(pendingOcrBlocks.map((b: any) => b.page))];
              this.editorState.replaceTextBlocksOnPages(ocrPages, pendingOcrBlocks);
              for (const pageNum of ocrPages) {
                const pageBlocks = pendingOcrBlocks.filter((b: any) => b.page === pageNum);
                const ocrBlocksForSpans = pageBlocks.map((b: any) => ({
                  x: b.x, y: b.y, width: b.width, height: b.height,
                  text: b.text, font_size: b.font_size, id: b.id
                }));
                this.electronService.updateSpansForOcr(pageNum, ocrBlocksForSpans);
              }
              if (pendingOcrCategories) {
                this.editorState.categories.set(pendingOcrCategories);
              }
            }

            // Apply category corrections AFTER all block mutations
            if (pendingCategoryCorrections && pendingCategoryCorrections.size > 0) {
              this.editorState.applyCategoryCorrections();
              this.editorState.updateCategoryStats();
            }

            // Apply deferred block splits
            if (pendingBlockSplits && pendingBlockSplits.length > 0) {
              await this.restoreBlockSplits(pendingBlockSplits);
            }

            // Apply deferred block merges
            if (pendingBlockMerges && pendingBlockMerges.length > 0) {
              this.restoreBlockMerges(pendingBlockMerges);
              const mergeSourceIds = new Set<string>();
              for (const m of pendingBlockMerges) {
                for (const srcId of m.sourceBlockIds) mergeSourceIds.add(srcId);
              }
              if (mergeSourceIds.size > 0) {
                this.editorState.deletedBlockIds.update(deleted => {
                  const next = new Set(deleted);
                  for (const srcId of mergeSourceIds) next.delete(srcId);
                  return next;
                });
              }
            }
          }

          // Also update the OpenDocument in tabs
          this.openDocuments.update(docs => docs.map(d => {
            if (d.id === docId) {
              return { ...d, blocks: data.blocks as TextBlock[], categories: data.categories as Record<string, Category> };
            }
            return d;
          }));

          // Run deferred analysis matching now that text/spans are ready
          if (this.pendingAnalysisMatch()) {
            this.pendingAnalysisMatch.set(false);
            this.matchAnalysisFlagsToPdf(this.analysisFlags(), this.analysisCategories());
          }
        });

        this.textReadyUnsubs.set(docId, unsub);

        // Fire-and-forget text extraction
        this.pdfService.analyzePdfText(pdfPathToLoad).catch(err => {
          console.error('[loadProjectFromPath] Background text extraction failed:', err);
          this.editorState.textLoading.set(false);
          this.textReadyUnsubs.get(docId)?.();
          this.textReadyUnsubs.delete(docId);
        });
      }

      // Suppress auto-save triggered by replaceTextBlocksOnPages() during restore.
      // Loading existing state should not be treated as a user change.
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
      }
      this.editorState.markSaved();

      // Load analysis results (fire-and-forget — highlights appear when ready)
      this.loadAnalysisResults(actualProjectPath);
    } catch (err) {
      console.error('Failed to load project source file:', err);
      const errorMsg = (err as Error).message || String(err);
      this.showAlert({
        title: 'Failed to Load Source',
        message: `Could not load:\n${pdfPathToLoad}\n\n${errorMsg}`,
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

    this.editorState.markChanged();
    this.exitSampleMode();

    // Collapse the custom-category section
    this.cleanupPanel?.collapseCustomSection();

    this.showAlert({
      title: 'Category Created',
      message: `Created "${categoryName}" with ${total} matched items across ${pageCount} pages.`,
      type: 'success'
    });
  }

  private generateCategoryId(name: string): string {
    return 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20) + '_' + Date.now().toString(36);
  }

  // Regex category builder wiring. The builder owns the form and emits a single
  // criteria object; the shell keeps match computation + viewer highlighting.

  /** The regex form's expand/collapse toggle (controls the viewer overlay). */
  onRegexExpandedChange(expanded: boolean): void {
    this.regexPanelExpanded.set(expanded);
    if (!expanded) {
      // Closing: drop the edit request and clear the live preview.
      this.editingCategoryId.set(null);
      this.regexEditCriteria.set(null);
      this.regexMatches.set([]);
      this.regexMatchCount.set(0);
    } else {
      // Opening fresh (not an edit-load): the builder resets its own form and
      // emits the default criteria; here we just make sure edit state is clear.
      this.editingCategoryId.set(null);
      this.regexEditCriteria.set(null);
    }
  }

  /** New criteria from the builder (debounced there) → recompute matches. */
  onRegexCriteriaChange(criteria: RegexCriteria): void {
    this.regexCriteria.set(criteria);
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
    const criteria = this.regexCriteria();
    let pattern = criteria.pattern;
    const minSize = criteria.minFontSize;
    // Treat 0 as "no max filter" (use 999)
    const maxSize = criteria.maxFontSize || 999;
    const minBaseline = criteria.minBaseline;
    const maxBaseline = criteria.maxBaseline;
    const caseSensitive = criteria.caseSensitive;
    const literalMode = criteria.literalMode;

    // Filter settings
    const categoryFilter = criteria.categoryFilter;
    const pageFilterType = criteria.pageFilterType;
    const pageRangeStart = criteria.pageRangeStart;
    const pageRangeEnd = criteria.pageRangeEnd;
    const specificPages = criteria.specificPages;

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

  /** Builder emitted `create` with its final criteria — commit it. */
  onRegexCreate(criteria: RegexCriteria): void {
    this.regexCriteria.set(criteria);
    void this.createRegexCategory();
  }

  async createRegexCategory(): Promise<void> {
    const criteria = this.regexCriteria();
    const pattern = criteria.pattern;
    const name = criteria.name;
    const color = criteria.color;
    const minSize = criteria.minFontSize;
    // Treat 0 as "no max filter" (use 999)
    const maxSize = criteria.maxFontSize || 999;
    const minBaseline = criteria.minBaseline;
    const maxBaseline = criteria.maxBaseline;
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

      this.editorState.markChanged();
      this.regexPanelExpanded.set(false);
      this.editingCategoryId.set(null);
      this.regexEditCriteria.set(null);
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
    this.editorState.markChanged();

    // Close modal and clear editing state
    this.regexPanelExpanded.set(false);
    this.editingCategoryId.set(null);
    this.regexEditCriteria.set(null);

    // Collapse the custom-category section
    this.cleanupPanel?.collapseCustomSection();

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
    this.editorState.markChanged();

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
    this.editorState.markChanged();
  }

  editCustomCategory(categoryId: string): void {
    const cat = this.categories()[categoryId];
    if (!cat) return;

    // Build a fresh criteria carrying the category's name/color. We don't store
    // the original pattern, so it stays empty — the user can re-enter a pattern
    // to update matches, or just rename/recolor. A new object reference makes the
    // builder's editCriteria effect fire and load the form.
    const criteria: RegexCriteria = {
      ...defaultRegexCriteria(),
      name: cat.name,
      color: cat.color,
      categoryFilter: Object.keys(this.categories()),
    };

    this.editingCategoryId.set(categoryId);
    this.regexCriteria.set(criteria);
    this.regexEditCriteria.set(criteria);
    this.regexMatches.set([]);
    this.regexMatchCount.set(0);

    // Expand the overlay (the builder's form is controlled by this signal)
    this.regexPanelExpanded.set(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Panel activation & rail handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Activate a task panel (or `null` for the default cleanup panel), carrying
   * the migrated per-panel side effects. OCR has no side effect now — it is a
   * real panel, not a modal trigger.
   */
  activatePanel(id: PanelId | null): void {
    const previous = this.activePanel();
    if (id === previous) return;

    // Entering crop: save layout and force vertical; reset the crop rect.
    if (id === 'crop' && previous !== 'crop') {
      this.previousLayout = this.layout();
      this.layout.set('vertical');
      this.cropCurrentPage.set(0);
      this.currentCropRect.set(null);
    }

    // Leaving crop: restore layout and clear the crop overlay.
    if (previous === 'crop' && id !== 'crop') {
      this.layout.set(this.previousLayout);
      this.pdfViewer?.clearCrop();
      this.currentCropRect.set(null);
    }

    // Entering split: auto-enable splitting and reset the preview page.
    if (id === 'split' && previous !== 'split') {
      this.splitConfig.update(config => ({ ...config, enabled: true }));
      this.splitPreviewPage.set(0);
    }

    // Entering chapters: try to auto-load the outline on first entry.
    if (id === 'chapters' && previous !== 'chapters') {
      if (this.chapters().length === 0) {
        this.tryLoadOutline();
      }
    }

    this.activePanel.set(id);
  }

  /** Rail task click — toggles the panel (clicking the active task closes it). */
  onRailPanelClick(id: PanelId): void {
    this.activatePanel(this.activePanel() === id ? null : id);
  }

  /** Toggle a rail group's collapsed state (persisted via effect). */
  toggleGroupCollapsed(groupId: string): void {
    this.collapsedGroups.update(groups => {
      const next = new Set(groups);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  // Crop methods (for backward compatibility with panel)
  enterCropMode(): void {
    this.activatePanel('crop');
  }

  exitCropMode(): void {
    this.activatePanel(null);
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
    // Sync the panel's "current page" to the page the rect was actually drawn
    // on, so "Current page only" targets the drawn page rather than page 0.
    this.cropCurrentPage.set(cropRect.pageNum);
  }

  applyCropFromPanel(event: { pages: number[]; cropRect: CropRect }): void {
    this.applyCropToPages(event.pages, event.cropRect);
    this.exitCropMode();
  }

  /** Panel "Clear crop" — remove crop on the targeted pages and restore blocks. */
  clearCropFromPanel(pages: number[]): void {
    this.editorState.clearCrop(pages);
  }

  /**
   * Apply a crop drawn on `cropRect.pageNum` to every page in `pageNums`.
   * The rect is normalized against the drawn page's dimensions and re-scaled to
   * each target page (then clamped to that page's bounds) so a single drawn
   * rectangle maps correctly across pages of differing sizes. Blocks that fall
   * fully outside their page's rect (among currently-live blocks) are removed;
   * straddling blocks are kept whole. All of it lands as ONE undoable action.
   */
  private applyCropToPages(pageNums: number[], cropRect: CropRect): void {
    const dims = this.pageDimensions();
    const drawn = dims[cropRect.pageNum];
    if (!drawn || drawn.width <= 0 || drawn.height <= 0) {
      console.error('[crop] drawn page dimensions missing/invalid for page', cropRect.pageNum);
      return;
    }

    // Normalize the drawn rect to fractions of the drawn page. When the drawn
    // page is itself a target, re-scaling reproduces the exact rect (no drift).
    const nx = cropRect.x / drawn.width;
    const ny = cropRect.y / drawn.height;
    const nw = cropRect.width / drawn.width;
    const nh = cropRect.height / drawn.height;

    const deleted = this.deletedBlockIds();
    const blocks = this.blocks();
    const entries = new Map<number, { x: number; y: number; width: number; height: number }>();
    const allToDelete: string[] = [];

    for (const page of pageNums) {
      const pd = dims[page];
      if (!pd || pd.width <= 0 || pd.height <= 0) {
        console.error('[crop] target page dimensions missing/invalid for page', page);
        continue;
      }

      // Scale to this page, then clamp so the rect stays within page bounds.
      let rx = nx * pd.width;
      let ry = ny * pd.height;
      rx = Math.max(0, Math.min(rx, pd.width));
      ry = Math.max(0, Math.min(ry, pd.height));
      const rw = Math.max(0, Math.min(nw * pd.width, pd.width - rx));
      const rh = Math.max(0, Math.min(nh * pd.height, pd.height - ry));
      const rect = { x: rx, y: ry, width: rw, height: rh };
      entries.set(page, rect);

      for (const block of blocks) {
        if (block.page !== page) continue;
        if (deleted.has(block.id)) continue;
        if (isBlockFullyOutside(block, rect)) {
          allToDelete.push(block.id);
        }
      }
    }

    if (entries.size === 0) return;
    this.editorState.applyCrop(entries, allToDelete);
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
    this.activatePanel(null);
  }

  // Cancel split mode - discard changes and disable split
  cancelSplitMode(): void {
    this.splitConfig.update(config => ({ ...config, enabled: false }));
    this.splitApplied.set(false);
    this.activatePanel(null);
  }

  // Apply split settings and exit split mode
  applySplit(): void {
    // Keep split enabled, mark as changed, and exit mode
    this.splitApplied.set(true);
    this.editorState.markChanged();
    this.activatePanel(null);
  }

  onSplitConfigChange(config: SplitConfig): void {
    this.splitConfig.set(config);
    this.editorState.markChanged();
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
    this.editorState.markChanged();
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
    this.editorState.markChanged();
  }

  // Deskew methods for split mode
  async deskewCurrentPage(): Promise<void> {
    const pageNum = this.splitPreviewPage();
    await this.deskewPage(pageNum);
  }

  async deskewAllPages(): Promise<void> {
    this.deskewing.set(true);
    const total = this.totalPages();
    let analyzed = 0;

    for (let i = 0; i < total; i++) {
      if (await this.deskewPage(i)) {
        analyzed++;
      }
    }

    this.deskewing.set(false);
    if (analyzed === 0) {
      this.showAlert({
        title: 'Deskew Failed',
        message: `Could not analyze any of the ${total} pages — no skew angles were detected and no pages were changed.`,
        type: 'error'
      });
    } else {
      this.showAlert({
        title: 'Deskew Analysis Complete',
        message: `Analyzed ${analyzed} of ${total} pages. Detected skew angles are NOT applied — rotation correction is not implemented yet, so all pages are unchanged.`,
        type: 'warning'
      });
    }
  }

  /**
   * Detect (but NOT apply) the skew angle for one page.
   * Returns true if the analysis ran successfully, false if it failed.
   */
  private async deskewPage(pageNum: number): Promise<boolean> {
    this.deskewing.set(true);

    try {
      // Get the page image for OCR analysis
      const pageImage = this.pageImages().get(pageNum);
      if (!pageImage) {
        console.warn(`No image cached for page ${pageNum}`);
        this.deskewing.set(false);
        return false;
      }

      // Detect skew angle using Tesseract
      const result = await this.electronService.ocrDetectSkew(pageImage);

      // null = detection FAILED — do not record a fabricated 0° or count the
      // page as analyzed (0° from a failure is indistinguishable from "straight")
      if (!result) {
        console.warn(`Skew detection failed for page ${pageNum}`);
        this.deskewing.set(false);
        return false;
      }

      this.lastDeskewAngle.set(result.angle);
      // TODO: Apply the rotation to the page (only meaningful when |angle| > 0.1)
      // This would require either:
      // 1. Modifying the PDF itself (complex, requires PDF manipulation)
      // 2. Applying CSS transform to the displayed page (visual only)
      // 3. Storing rotation info to be applied during export
      // For now, we just detect and report the angle
    } catch (err) {
      console.error('Deskew detection failed:', err);
      this.showAlert({
        title: 'Deskew Failed',
        message: 'Could not detect page orientation. Make sure Tesseract is installed.',
        type: 'error'
      });
      this.deskewing.set(false);
      return false;
    }

    this.deskewing.set(false);
    return true;
  }

  // Chapter methods
  async tryLoadOutline(): Promise<void> {
    try {
      const outline = await this.electronService.extractOutline();
      if (outline && outline.length > 0) {
        const chapters = await this.electronService.outlineToChapters(outline, this.deletedPages());
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
      const chapters = await this.electronService.detectChapters(this.deletedPages());
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

  async findSimilarChapters(): Promise<void> {
    const existing = this.chapters();
    // Collect blockIds from existing chapters
    const blockIds = existing
      .map(c => c.blockId)
      .filter((id): id is string => !!id);

    if (blockIds.length < 2) {
      this.showAlert({
        title: 'Need More Examples',
        message: 'Mark at least 2 chapter headings by clicking on text blocks, then try again.',
        type: 'info'
      });
      return;
    }

    this.detectingChapters.set(true);
    try {
      const detected = await this.electronService.detectChaptersFromExamples(blockIds, this.deletedPages());
      if (detected.length > 0) {
        // Filter out duplicates by page proximity (within 50px on same page)
        const newChapters = detected.filter(d => {
          return !existing.some(e =>
            e.page === d.page && Math.abs((e.y || 0) - (d.y || 0)) < 50
          );
        });

        if (newChapters.length > 0) {
          this.chapters.set([...existing, ...newChapters].sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return (a.y || 0) - (b.y || 0);
          }));
          this.chaptersSource.set('mixed');
          this.editorState.markChanged();
        } else {
          this.showAlert({
            title: 'No New Chapters',
            message: 'All similar blocks are already marked as chapters.',
            type: 'info'
          });
        }
      } else {
        this.showAlert({
          title: 'No Similar Blocks Found',
          message: 'Could not find blocks matching your example chapters. Try marking different examples.',
          type: 'info'
        });
      }
    } catch (err) {
      console.error('Failed to find similar chapters:', err);
      this.showAlert({
        title: 'Detection Failed',
        message: 'Could not find similar chapters: ' + (err as Error).message,
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
    this.editorState.markChanged();
  }

  /**
   * Create a single chapter heading from one or more (typically consecutive)
   * blocks. All of the blocks are recorded as the chapter's anchor + merged
   * title blocks, which excludes them from body text at export time so the
   * chapter name isn't read twice by TTS. Their text is joined as the title.
   */
  addChapterFromBlocks(blocks: TextBlock[], level: number = 1): void {
    const sorted = [...blocks].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return a.y - b.y;
    });
    if (sorted.length === 0) return;
    if (sorted.length === 1) {
      this.addChapterFromBlock(sorted[0], level);
      return;
    }

    const anchor = sorted[0];
    const joined = sorted.map(b => b.text.trim()).filter(Boolean).join(' ');
    const chapterId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newChapter: Chapter = {
      id: chapterId,
      title: joined.length > 80 ? joined.substring(0, 77) + '...' : joined,
      page: anchor.page,
      blockId: anchor.id,
      mergedBlockIds: sorted.map(b => b.id),
      y: anchor.y,
      level,
      source: 'manual',
    };

    const chapters = [...this.chapters(), newChapter].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    this.chapters.set(chapters);
    this.selectedChapterId.set(chapterId);
    this.chaptersSource.set(this.chapters().some(c => c.source !== 'manual') ? 'mixed' : 'manual');
    this.editorState.markChanged();
  }

  /**
   * Gutter-handle drop: create a chapter at the drop point. If the drop landed on
   * a block that's part of the current multi-selection, merge the whole selection
   * into one chapter; otherwise anchor to the single dropped block, or place a
   * blank chapter if dropped on empty space. Auto-switches the right nav to the
   * Chapters tab.
   */
  onChapterGutterDrop(event: { pageNum: number; y: number; snapToBlock?: TextBlock }): void {
    if (event.snapToBlock) {
      const selected = this.selectedBlockIds();
      if (selected.length > 1 && selected.includes(event.snapToBlock.id)) {
        const blocks = this.blocks().filter(b => selected.includes(b.id));
        this.addChapterFromBlocks(blocks, 1);
      } else {
        const existing = this.chapters().find(c => c.blockId === event.snapToBlock!.id);
        if (!existing) {
          this.addChapterFromBlock(event.snapToBlock, 1);
        }
      }
    } else {
      this.onChapterPlacement({ pageNum: event.pageNum, y: event.y, level: 1 });
    }
    this.activatePanel('chapters');
  }

  /**
   * Context-menu "Mark as chapter": convert the given block ids into one chapter
   * heading (removing them from body) and reveal the Chapters tab.
   */
  onChapterFromBlocks(event: { blockIds: string[] }): void {
    const blocks = this.blocks().filter(b => event.blockIds.includes(b.id));
    if (blocks.length === 0) return;
    this.addChapterFromBlocks(blocks, 1);
    this.activatePanel('chapters');
  }

  removeChapter(chapterId: string): void {
    this.chapters.update(chapters => chapters.filter(c => c.id !== chapterId));
    if (this.selectedChapterId() === chapterId) {
      this.selectedChapterId.set(null);
    }
    this.editorState.markChanged();
  }

  renameChapter(event: { chapterId: string; newTitle: string }): void {
    this.chapters.update(chapters =>
      chapters.map(c =>
        c.id === event.chapterId
          ? { ...c, title: event.newTitle }
          : c
      )
    );
    this.editorState.markChanged();
  }

  changeChapterLevel(event: { chapterId: string; level: number }): void {
    this.chapters.update(chapters =>
      chapters.map(c =>
        c.id === event.chapterId
          ? { ...c, level: event.level }
          : c
      )
    );
    this.editorState.markChanged();
  }

  onMetadataChange(newMetadata: BookMetadata): void {
    this.metadata.set(newMetadata);
    this.editorState.markChanged();
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
    this.editorState.markChanged();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Paragraph detection
  // ─────────────────────────────────────────────────────────────────────────

  detectParagraphs(): void {
    const blocks = this.blocks();
    const deletedIds = this.deletedBlockIds();
    const manualBreaks = this.editorState.paragraphBreaks();
    const chapterBlockIds = new Set(this.chapters().map(c => {
      // Find nearest block to each chapter marker
      const pageBlocks = blocks.filter(b => b.page === c.page && !deletedIds.has(b.id) && !b.is_image && b.region === 'body');
      const closest = pageBlocks.reduce<TextBlock | null>((best, b) => {
        if (!best) return b;
        return Math.abs(b.y - (c.y || 0)) < Math.abs(best.y - (c.y || 0)) ? b : best;
      }, null);
      return closest?.id;
    }).filter((id): id is string => !!id));

    const baselines = computeBaselines(blocks, deletedIds);

    let config: DetectionConfig | undefined;
    if (this.userDetectionConfig) {
      config = this.userDetectionConfig;
    }

    const sdz = config?.shortLineDeadZone ?? getDefaultConfig().shortLineDeadZone;
    const model = learnFromBreaks(blocks, manualBreaks, baselines, deletedIds, sdz);

    // If no user config, build one from auto-learned model + defaults
    if (!config) {
      const defaults = getDefaultConfig();
      config = {
        ...defaults,
        weights: model.weights,
        threshold: model.threshold,
      };
    }

    const result = detectParagraphBreaks(blocks, model, baselines, deletedIds, chapterBlockIds, manualBreaks, config);

    this.editorState.setParagraphBreaks(result.breaks);
    this.paragraphDetectionStats.set(result.stats);
    this.paragraphDetectionConfig.set(result.config);
    this.paragraphBaselines.set(result.baselines);
  }

  onParagraphConfigChange(config: DetectionConfig): void {
    this.userDetectionConfig = config;
  }

  clearParagraphs(): void {
    this.editorState.clearParagraphBreaks();
    this.paragraphDetectionStats.set(null);
    this.paragraphDetectionConfig.set(null);
    this.paragraphBaselines.set(null);
    this.userDetectionConfig = null;
  }

  toggleParagraphBreak(blockId: string): void {
    this.editorState.toggleParagraphBreak(blockId);
  }

  deleteParagraphBreak(blockId: string): void {
    const breaks = this.editorState.paragraphBreaks();
    if (breaks.has(blockId)) {
      const newBreaks = new Set(breaks);
      newBreaks.delete(blockId);
      this.editorState.setParagraphBreaks(newBreaks);
    }
  }

  moveParagraphBreak(move: { fromBlockId: string; toBlockId: string }): void {
    const breaks = this.editorState.paragraphBreaks();
    const newBreaks = new Set(breaks);
    newBreaks.delete(move.fromBlockId);
    newBreaks.add(move.toBlockId);
    if (newBreaks.size !== breaks.size || !breaks.has(move.toBlockId) || !breaks.has(move.fromBlockId)) {
      this.editorState.setParagraphBreaks(newBreaks);
    }
  }

  /**
   * Enter paragraph fix mode after a save operation.
   * Closes the current document (e.g., the PDF), reopens the exported EPUB
   * so paragraph detection runs on EPUB text blocks (which map to <p> tags),
   * then auto-detects paragraph breaks.
   */
  private async enterParagraphFixMode(epubPath: string): Promise<void> {
    this.paragraphFixEpubPath.set(epubPath);
    this.paragraphFixMode.set(true);

    // Remove the current document from open tabs so loadPdf won't hit
    // the duplicate-tab check (the EPUB path may differ from the original source)
    const currentDocId = this.activeDocumentId();
    if (currentDocId) {
      this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
    }

    // Close the current document (frees WASM memory, resets editor state)
    this.closePdf();

    // Re-set fix mode state after closePdf resets it
    this.paragraphFixMode.set(true);
    this.paragraphFixEpubPath.set(epubPath);

    // Load the exported EPUB — blocks will correspond to <p> tags. This is a
    // DERIVED artifact of the already-bound project, so suppress auto-project
    // binding (projectPath must stay the manifest project, not rebind here).
    this.pipelineTransitioning = true;
    try {
      await this.loadPdf(epubPath);
    } finally {
      this.pipelineTransitioning = false;
    }

    // Switch to paragraph mode and auto-detect
    this.activatePanel('paragraphs');
    this.detectParagraphs();
  }

  /**
   * Finish paragraph fix mode — save corrected paragraphs and emit finalized.
   */
  async finishParagraphFix(): Promise<void> {
    const epubPath = this.paragraphFixEpubPath();
    if (!epubPath) return;

    this.loading.set(true);
    this.loadingText.set('Saving paragraph corrections...');

    try {
      const chapters = this.chapters();
      const deletedHighlights = this.getDeletedHighlights();
      const blocks = this.blocks();
      const deletedBlockIds = this.deletedBlockIds();
      const deletedPages = this.deletedPages();
      const pBreaks = this.editorState.paragraphBreaks();

      const result = await this.exportService.saveToEpub(
        blocks,
        deletedBlockIds,
        chapters,
        this.pdfName(),
        epubPath,
        this.editorState.textCorrections(),
        deletedPages,
        deletedHighlights,
        this.metadata(),
        pBreaks.size > 0 ? pBreaks : undefined
      );

      // Exit paragraph fix mode
      this.paragraphFixMode.set(false);
      this.paragraphFixEpubPath.set(null);
      this.activatePanel(null);

      if (result.success) {
        this.finalized.emit({ success: true, epubPath });
        this.showAlert({
          title: 'Saved',
          message: 'EPUB saved with corrected paragraphs.',
          type: 'success'
        });
      } else {
        this.finalized.emit({ success: false, error: result.message || 'Failed to save' });
        this.showAlert({
          title: 'Save Failed',
          message: result.message || 'Failed to save EPUB',
          type: 'error'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.paragraphFixMode.set(false);
      this.paragraphFixEpubPath.set(null);
      this.finalized.emit({ success: false, error: errorMessage });
      this.showAlert({ title: 'Save Failed', message: errorMessage, type: 'error' });
    } finally {
      this.loading.set(false);
    }
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
        title: 'Chapters Saved',
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
    if (this.reviewMode()) return;  // read-only during EPUB review
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
    if (this.reviewMode()) return;  // read-only during EPUB review
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
    this.tocMode.set(false);
    this.tocBlockIds.set([]);
    this.tocStep.set('blocks');
    this.tocLines.set([]);
    this.tocCheckedIndexes.set(new Set());
    this.activatePanel(null);
  }

  toggleTocMode(): void {
    const newMode = !this.tocMode();
    this.tocMode.set(newMode);
    if (!newMode) {
      this.tocBlockIds.set([]);
      this.tocStep.set('blocks');
      this.tocLines.set([]);
      this.tocCheckedIndexes.set(new Set());
    }
  }

  async splitTocBlocks(): Promise<void> {
    const tocIds = this.tocBlockIds();
    if (tocIds.length === 0) return;

    this.detectingChapters.set(true);
    try {
      const lines = await this.electronService.splitTocBlocks(tocIds);
      this.tocLines.set(lines);

      // Pre-check non-page-number lines
      const checked = new Set<number>();
      lines.forEach((line, i) => {
        if (!line.isPageNumber) checked.add(i);
      });
      this.tocCheckedIndexes.set(checked);
      this.tocStep.set('lines');
    } catch (err) {
      console.error('Failed to split TOC blocks:', err);
      this.showAlert({
        title: 'TOC Split Failed',
        message: 'Could not split TOC blocks: ' + (err as Error).message,
        type: 'error'
      });
    } finally {
      this.detectingChapters.set(false);
    }
  }

  toggleTocLineCheck(index: number): void {
    const current = new Set(this.tocCheckedIndexes());
    if (current.has(index)) {
      current.delete(index);
    } else {
      current.add(index);
    }
    this.tocCheckedIndexes.set(current);
  }

  tocGoBackToBlocks(): void {
    this.tocStep.set('blocks');
    this.tocLines.set([]);
    this.tocCheckedIndexes.set(new Set());
  }

  async mapTocEntries(): Promise<void> {
    // Collect checked titles from line picker
    const lines = this.tocLines();
    const checked = this.tocCheckedIndexes();
    const titles = lines
      .filter((_, i) => checked.has(i))
      .map(l => l.text);

    if (titles.length === 0) return;

    // Collect TOC pages from the selected blocks
    const tocPages = [...new Set(lines.map(l => l.blockPage))];

    this.detectingChapters.set(true);
    try {
      const result = await this.electronService.mapTitlesToChapters(titles, tocPages, this.deletedPages());
      const existing = this.chapters();

      if (result.chapters.length > 0) {
        // Filter out duplicates by page proximity
        const newChapters = result.chapters.filter(d =>
          !existing.some(e => e.page === d.page && Math.abs((e.y || 0) - (d.y || 0)) < 50)
        );

        if (newChapters.length > 0) {
          this.chapters.set([...existing, ...newChapters].sort((a, b) => {
            if (a.page !== b.page) return a.page - b.page;
            return (a.y || 0) - (b.y || 0);
          }));
          this.chaptersSource.set(existing.length > 0 ? 'mixed' : 'toc');
          this.editorState.markChanged();
        }

        const mapped = result.chapters.length;
        const unmappedCount = result.unmapped.length;
        const msg = unmappedCount > 0
          ? `Mapped ${mapped} chapter${mapped !== 1 ? 's' : ''}. ${unmappedCount} entr${unmappedCount !== 1 ? 'ies' : 'y'} could not be matched.`
          : `Mapped ${mapped} chapter${mapped !== 1 ? 's' : ''}.`;

        this.showAlert({ title: 'TOC Mapping Complete', message: msg, type: unmappedCount > 0 ? 'info' : 'success' });
      } else {
        this.showAlert({
          title: 'No Chapters Matched',
          message: 'Could not match any TOC entries to headings in the document. Try selecting different TOC blocks.',
          type: 'info'
        });
      }

      // Exit TOC mode
      this.tocMode.set(false);
      this.tocBlockIds.set([]);
      this.tocStep.set('blocks');
      this.tocLines.set([]);
      this.tocCheckedIndexes.set(new Set());

    } catch (err) {
      console.error('Failed to map TOC entries:', err);
      this.showAlert({
        title: 'TOC Mapping Failed',
        message: 'Could not map TOC entries: ' + (err as Error).message,
        type: 'error'
      });
    } finally {
      this.detectingChapters.set(false);
    }
  }

  onChapterClick(event: { block: TextBlock; level: number }): void {
    // In TOC mode, toggle block selection for TOC mapping
    if (this.tocMode()) {
      const blockId = event.block.id;
      const current = this.tocBlockIds();
      if (current.includes(blockId)) {
        this.tocBlockIds.set(current.filter(id => id !== blockId));
      } else {
        this.tocBlockIds.set([...current, blockId]);
      }
      return;
    }

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
    this.editorState.markChanged();
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

    this.editorState.markChanged();
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

    // Page images are rendered at a scale that depends on document size
    // (matches effectiveScale in pdf-analyzer.ts renderPages)
    const totalPageCount = this.totalPages();
    const renderScale = totalPageCount > 200 ? 1.5 : totalPageCount > 100 ? 2.0 : 2.5;

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

    // Post-process OCR blocks: merge lines into paragraphs and apply smart categorization
    const processedResult = this.ocrPostProcessor.processOcrBlocks(newBlocks, pageDims);
    const newCategories = processedResult.categories;

    // Respect existing crop regions: OCR reads the untouched raster, so it would
    // otherwise re-introduce text that a crop deleted. Drop incoming blocks that
    // fall fully outside a cropped page's rect (same geometry test as apply).
    let processedBlocks = processedResult.blocks;
    const cropRegions = this.editorState.cropRegions();
    if (cropRegions.size > 0) {
      let dropped = 0;
      processedBlocks = processedBlocks.filter(b => {
        const region = cropRegions.get(b.page);
        if (region && isBlockFullyOutside(b, region.rect)) {
          dropped++;
          return false;
        }
        return true;
      });
      if (dropped > 0) {
        console.info(`[crop] dropped ${dropped} OCR block(s) that fell outside an existing crop region`);
      }
    }

    // Merge new OCR categories with existing categories
    const existingCategories = this.categories();
    const mergedCategories = { ...existingCategories, ...newCategories };
    this.editorState.categories.set(mergedCategories);

    // Only replace blocks on pages that have OCR results
    // Pages with no OCR results keep their existing blocks
    if (pagesWithOcrResults.length > 0) {
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

      // Note: OCR fill regions (white backgrounds behind OCR text) are rendered as
      // SVG overlays in the pdf-viewer, not baked into the page image. This allows
      // toggling OCR text off to reveal the original scanned page underneath.
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
      const engine = parts[2];
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
            textLines: r.textLines
          }));

          // Process the OCR results - this will apply them to the document
          this.onOcrCompleted({ results: ocrPageResults });

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

  /**
   * Restore a background job by reopening the OCR settings modal
   */
  onRestoreBackgroundJob(_jobId: string): void {
    this.showOcrSettings.set(true);
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

    // Auto-save if there are unsaved changes — but only when closing the
    // ACTIVE document. saveProject() serializes the active tab's editor state,
    // so saving for a background tab would write the wrong document's data.
    if (doc.hasUnsavedChanges) {
      if (tab.id !== this.activeDocumentId()) {
        // Background tab with unsaved changes: we CANNOT save it (see above),
        // and closing would silently drop the changes. Make the user decide.
        this.showAlert({
          title: 'Unsaved Changes',
          message: `"${doc.name}" has unsaved changes that cannot be saved while it is in the background. Switch to that tab to save it, or discard the changes and close it.`,
          type: 'warning',
          confirmText: 'Discard Changes',
          cancelText: 'Cancel',
          onConfirm: () => this.removeClosedTab(tab)
        });
        return;
      }
      if (this.projectService.projectPath()) {
        // Save in background before closing
        this.saveProject().catch(err => console.error('Auto-save on close failed:', err));
      }
    }

    this.removeClosedTab(tab);
  }

  /** Actually remove a tab from the open-documents list (after any unsaved-changes handling). */
  private removeClosedTab(tab: DocumentTab): void {
    const docs = this.openDocuments();
    const docIndex = docs.findIndex(d => d.id === tab.id);
    if (docIndex === -1) return;

    // Clean up background text extraction subscription
    this.textReadyUnsubs.get(tab.id)?.();
    this.textReadyUnsubs.delete(tab.id);

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
    // In embedded mode, Cmd+W should emit exit request (let parent handle it)
    if (this.embedded()) {
      this.exitRequested.emit();
      return;
    }

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
            redoStack: history.redoStack,
            paragraphBreaks: this.editorState.paragraphBreaks(),
            categoryCorrections: this.editorState.categoryCorrections(),
            learnedCategories: this.editorState.learnedCategories(),
            chapters: this.chapters(),
            chaptersSource: this.chaptersSource(),
            metadata: this.metadata(),
            categoryHighlights: this.categoryHighlights(),
            deletedHighlightIds: this.deletedHighlightIds(),
            splitConfig: this.splitConfig(),
            splitApplied: this.splitApplied(),
            cropRegions: this.editorState.cropRegions(),
            blankedPages: this.blankedPages(),
            createdAt: this.projectCreatedAt ?? undefined,
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
      deletedPages: doc.deletedPages,
      pageOrder: doc.pageOrder,
      paragraphBreaks: doc.paragraphBreaks,
      categoryCorrections: doc.categoryCorrections,
      learnedCategories: doc.learnedCategories,
      cropRegions: doc.cropRegions ?? new Map(),
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

    // Restore per-document component state (reset to empty defaults when the
    // document has none, so the previous tab's data doesn't leak in)
    this.chapters.set(doc.chapters ?? []);
    this.chaptersSource.set(doc.chaptersSource ?? 'manual');
    this.metadata.set(doc.metadata ?? {});
    this.categoryHighlights.set(doc.categoryHighlights ?? new Map());
    this.deletedHighlightIds.set(doc.deletedHighlightIds ?? new Set());
    this.splitConfig.set(doc.splitConfig ?? this.defaultSplitConfig());
    this.splitApplied.set(doc.splitApplied === true);
    // cropRegions is restored via loadDocument() above (it lives on editorState).
    this.blankedPages.set(doc.blankedPages ?? new Set());
    this.projectCreatedAt = doc.createdAt ?? null;

    // Note: paragraphBreaks and categoryCorrections are now passed directly to
    // loadDocument() above, which applies corrections to blocks automatically.
  }

  /** Default split configuration for a freshly opened document */
  private defaultSplitConfig(): SplitConfig {
    return {
      enabled: false,
      oddPageSplit: 0.5,
      evenPageSplit: 0.5,
      pageOverrides: {},
      skippedPages: new Set<number>(),
      readingOrder: 'left-to-right'
    };
  }

  private clearDocumentState(): void {
    this.activeDocumentId.set(null);
    this.editorState.reset();
    this.pageRenderService.closeDocument(); // Also frees the backend cached render doc
    this.electronService.closePdf(); // Free the main analysis document WASM memory
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

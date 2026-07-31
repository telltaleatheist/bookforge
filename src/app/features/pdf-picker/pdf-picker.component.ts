import { Component, inject, signal, computed, HostListener, ViewChild, ElementRef, effect, DestroyRef, ChangeDetectionStrategy, input, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService, Chapter, TocLine, EpubExportBlock, EpubExportChapter, EpubPreservingEdits, RubricRunState, CorpusBookInfo } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction, BlockEdit, SplitDefinition, MergeDefinition, CropRegion } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
import { ExportService, DeletedHighlight, ExportResult as EpubExportResult } from './services/export.service';
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
import { recategorize as recategorizeBlocksFromLearner, classifyBlockHeuristic, computeBaselines as computeCategoryBaselines, isDefaultThresholds, detectMergeableGroups, createMergedBlock, type BlockAssignment, type CategoryBaselines, type ClassificationThresholds, type MergeGroup } from './services/category-learner';
import { TrainingExportService } from './services/training-export.service';
import { LibraryViewComponent, ProjectFile } from './components/library-view/library-view.component';
import { TabBarComponent, DocumentTab } from './components/tab-bar/tab-bar.component';
import { OcrSettingsModalComponent, OcrSettings, OcrPageResult, OcrCompletionEvent } from './components/ocr-settings-modal/ocr-settings-modal.component';
import { InlineTextEditorComponent, TextEditResult } from './components/inline-text-editor/inline-text-editor.component';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, ExportFormat } from './components/export-settings-modal/export-settings-modal.component';
import { BackgroundProgressComponent, BackgroundJob } from './components/background-progress/background-progress.component';
import { OcrJobService, OcrJob } from './services/ocr-job.service';
import { TaskRailComponent } from './components/task-rail/task-rail.component';
import { DetectPanelComponent, DetectRunState, DetectBackend } from './components/detect-panel/detect-panel.component';
import { encodeBook, parseAnswer, toRawPrompt, RUBRIC_STOP, RubricVersion, rubricVersionFor } from './services/rubric-encoder';
import { BLOCK_CATEGORIES, normalizeCategories } from '@shared/ocr/block-categories';
import { OCR_RENDER_SCALE } from '@shared/ocr/ocr-render';
import { OcrPanelComponent } from './components/ocr-panel/ocr-panel.component';
import {
  TASK_GROUPS,
  TASK_ORDER,
  TASK_LABELS,
  STATUS_GLYPH,
  CHAPTERS_EXPORT_MINIMUM,
  TaskId,
  PanelId,
  TaskStatus,
  taskForDigit,
  deriveAllTaskStatuses,
  countPagesWithoutText,
  isBlockFullyOutside,
} from './tasks/task.model';
import { parsePageRange } from './shared/page-range.util';

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
  /**
   * Full SHA-256 of the file THIS document's blocks were analyzed from, straight
   * off the analyzer. Per-document because block ids only mean anything against
   * the bytes they came out of — a tab switch must not carry one book's hash into
   * another book's project file.
   */
  sourceSha256?: string;
  /**
   * True when this document is bound to a project whose saved edits were
   * deliberately NOT applied, because they belong to a different file. Nothing in
   * the session may then save project state — see projectStateNotApplied. Held
   * per-document because one tab can hold a derived version while another holds
   * the original, and only the derived one is forbidden to save.
   */
  projectStateNotApplied?: boolean;
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
  /**
   * Full SHA-256 of the file the blocks below were analyzed from.
   *
   * Everything in this project is keyed to block ids, and block ids only exist
   * relative to one analysis of one exact file. Recording that file's hash makes
   * the binding checkable: on load, a project whose source has changed underneath
   * it starts clean instead of painting a stale set of deletions onto a different
   * book (opening exported.epub used to inherit the archive's deleted pages).
   *
   * ABSENT in projects saved before this field existed — those predate the
   * invariant and are applied as they always were, never treated as a mismatch.
   */
  source_file_sha256?: string;
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
    // Text-mode splits (no span geometry) can't be rebuilt from spans on reload,
    // so their full child block data is persisted directly.
    textMode?: boolean;
    childBlocks?: TextBlock[];
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

/**
 * Single-key category assignment, active only while blocks are selected.
 *
 * Labelling a book by right-clicking into a submenu costs seconds per block;
 * across a training set that is the dominant time sink. The scheme is
 * base key = primary category, Shift = its paired variant.
 */
const CATEGORY_SHORTCUTS: Record<string, string> = {
  'b': 'body',
  'c': 'chapter',
  't': 'title',
  'h': 'heading',
  'shift+h': 'subheading',
  'q': 'quote',
  'p': 'caption',
  'f': 'footnote',
  'r': 'header',          // running head
  'shift+r': 'footer',    // running foot
  'i': 'image',
  'l': 'list',
  'shift+t': 'table',
};
// Thirteen keys for thirteen classes. `m`/`shift+m` (front_matter/back_matter)
// and `shift+f` (footnote_ref) are deliberately absent, not merely unbound:
// those classes were retired Jul 2026 and a live shortcut is the easiest way to
// put one back into the corpus by accident. See autoDetectedCategoryList.

// The resolution every OCR pass runs at (OCR_RENDER_SCALE = OCR_DPI / 72, since PDF
// user space is 72 dpi) comes from shared/ocr/ocr-render.ts — imported above, no
// longer a hand-kept mirror of the main process's copy. That mirror is exactly how
// the bug it warned about happened in reverse: the constant stayed in step, but the
// picker converted OCR boxes back to points with a DIFFERENT scale derived from the
// document's page count. See OCR_RENDER_SCALE's own comment.

/** Below this classifier confidence a block is worth a human look. */
const UNCERTAIN_CONFIDENCE = 0.15;

/**
 * Stations on the embedded audiobook-prep path, in order.
 *
 * There is one editing station: everything the user does to the book — modes,
 * crop, chapters, paragraphs — happens in the rail while 'select' is the step.
 * Chapters used to be a station of its own, which forced every book through a
 * chapter-marking screen whether or not it needed one; it is a rail row now,
 * and the export gate is what makes sure it was not simply forgotten.
 */
type PipelineStep = 'select' | 'epub-review';

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
    DetectPanelComponent,
    OcrPanelComponent,
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <!--
      Corpus banner. Permanent and unmissable, because the one thing that must
      never happen here is mistaking a corpus book for a library project and
      expecting an audiobook out of it.
    -->
    @if (corpusMode()) {
      <div class="corpus-banner" [class.corpus-banner-blocked]="!!corpusReadOnlyReason()">
        <span class="corpus-tag">TRAINING CORPUS</span>
        @if (corpusBook(); as book) {
          <span class="corpus-slug">{{ book.slug }}</span>
          @if (book.from === 'book.json') {
            <!--
              Added but never OCR'd: book.json and a referenced PDF, no blocks.
              A normal starting state rather than a fault, so it is stated as a
              next step and NOT as the read-only/blocked style — nothing is
              wrong here, there is simply nothing recorded yet.
            -->
            <span class="corpus-detail">
              Not OCR'd yet — run OCR to record blocks.json for this book.
            </span>
          } @else {
            <span class="corpus-detail">
              <!--
                Counted from the blocks on screen rather than from the loaded
                snapshot: after an OCR pass the two are the same set, and the
                snapshot field is whatever was read at open time.
              -->
              {{ blocks().length | number }} blocks ·
              {{ editorState.categoryCorrections().size | number }} labelled ·
              from {{ book.from }}
              @if (!book.labelled) { <em>(never labelled — saving creates labels.json)</em> }
              @if (corpusRetiredLabelCount() > 0) {
                · <em>{{ corpusRetiredLabelCount() }} use a retired class and show as
                unlabelled; they are preserved when you save</em>
              }
            </span>
          }
        } @else {
          <span class="corpus-detail">Loading…</span>
        }
        @if (corpusReadOnlyReason()) {
          <span class="corpus-blocked">Read-only — {{ corpusReadOnlyReason() }}</span>
        } @else if (hasUnsavedChanges()) {
          <!-- No autosave here, so "unsaved" has to be visible at all times. -->
          <span class="corpus-unsaved">● Unsaved label edits — ⌘S to write them</span>
        } @else {
          <span class="corpus-detail">Not a library project — nothing here is imported.</span>
        }
      </div>
    }

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
              [current]="railCurrent()"
              [disabledTasks]="disabledTasks()"
              [collapsedGroups]="collapsedGroups()"
              (panelClick)="onRailPanelClick($event)"
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
                [hiddenCategoryIds]="hiddenCategoryIds()"
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
              [categoryOverride]="detectPaintOverride()"
              [overrideOnly]="detectMode()"
              [showCategoryColors]="showCategoryColors() || detectMode()"
              [labelMode]="labelMode()"
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
            @case ('detect') {
              <app-detect-panel
                [state]="detectState()"
                [endpoint]="detectEndpoint()"
                [backend]="detectBackend()"
                [model]="detectModel()"
                [models]="detectModelOptions()"
                [isTrainedModel]="detectModelIsTrained()"
                [categories]="autoDetectedCategoryList()"
                [predictions]="detectPredictions()"
                [selectedBlockIds]="selectedBlockIds()"
                (endpointChange)="setDetectEndpoint($event)"
                (backendChange)="setDetectBackend($event)"
                (modelChange)="setDetectModel($event)"
                (loadCategories)="runDetection()"
                (stop)="cancelDetection()"
                (selectCategory)="selectPredictedCategory($event)"
                (clear)="clearDetection()"
                (adopt)="adoptDetectPredictions()"
                (done)="activatePanel(null)"
              />
            }
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
                [hiddenCategoryIds]="hiddenCategoryIds()"
                [deletedBlockIds]="deletedBlockIds()"
                [blocks]="textLayerFilteredBlocks()"
                [selectedBlockIds]="selectedBlockIds()"
                [includedChars]="includedChars()"
                [excludedChars]="excludedChars()"
                [categoryCorrections]="editorState.categoryCorrections()"
                [showCategoryColors]="showCategoryColors()"
                [uncertainCount]="uncertainBlocks().length"
                [labelMode]="labelMode()"
                [labelSourceName]="labelSourceBasename()"
                [corpusMode]="corpusMode()"
                [corpusDir]="corpusPath() || ''"
                [corpusReadOnly]="!!corpusReadOnlyReason()"
                (saveCorpusLabels)="saveCorpusLabels()"
                [thresholds]="editorState.classificationThresholds()"
                [baselines]="computedBaselines()"
                [regexMatches]="regexMatches()"
                [regexMatchCount]="regexMatchCount()"
                [regexEditCriteria]="regexEditCriteria()"
                [regexIsEditing]="!!editingCategoryId()"
                [regexExpanded]="regexPanelExpanded()"
                (close)="activatePanel(null)"
                (clearCorrections)="clearCategoryCorrections()"
                [hasLabelSnapshot]="hasLabelSnapshot()"
                (exportTrainingData)="exportTrainingData()"
                (resetLabels)="resetTrainingSession()"
                (restoreLabels)="restoreLabelSnapshot()"
                (alignFromEpub)="alignFromEpub()"
                (assignCategory)="assignSelectedToCategory($event)"
                (showCategoryColorsChange)="showCategoryColors.set($event)"
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

      <!-- Bottom control bar: the audiobook-prep path (embedded pipeline only).
           Never for a corpus book — every station of it writes into a project. -->
      @if (embedded() && !corpusMode()) {
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
          @if (splitPopoverTextMode()) {
            <div class="split-hint">
              No layout data for this block (OCR/synthetic). Click a divider to split
              its text — e.g. separate a chapter title from the body paragraph.
            </div>
          }
          <div class="split-lines" [class.text-mode]="splitPopoverTextMode()">
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
                @if (!splitPopoverTextMode()) {
                  <span class="split-line-meta">{{ line.fontSize }}pt</span>
                }
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
        [unaddressed]="exportUnaddressed()"
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

    /* Corpus banner — deliberately loud, and deliberately not the app's accent
       colour, so a corpus window can never be mistaken for a project window. */
    .corpus-banner {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--ui-spacing-sm) var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      background: #4a3a10;
      color: #ffe9a8;
      border-bottom: 2px solid #d8a12a;
      font-size: 12px;
      flex-shrink: 0;
    }

    .corpus-banner-blocked {
      background: #4a1414;
      color: #ffd4d4;
      border-bottom-color: #d84a4a;
    }

    .corpus-tag {
      font-weight: 700;
      letter-spacing: 0.08em;
      padding: 2px 8px;
      border-radius: 4px;
      background: #d8a12a;
      color: #2a1e00;
      white-space: nowrap;
    }

    .corpus-banner-blocked .corpus-tag {
      background: #d84a4a;
      color: #2a0000;
    }

    .corpus-slug {
      font-weight: 600;
    }

    .corpus-detail {
      opacity: 0.85;
    }

    .corpus-blocked {
      font-weight: 600;
    }

    .corpus-unsaved {
      font-weight: 600;
      color: #fff3d0;
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

      .split-hint {
        margin: 0 $spacing-4 $spacing-2;
        padding: $spacing-2 $spacing-3;
        font-size: $font-size-sm;
        line-height: 1.4;
        color: var(--text-secondary);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: $radius-sm;
      }

      /* Text-fallback mode: flow words inline with thin clickable split bars
         between them (a compact text-position picker). */
      .split-lines.text-mode {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 1px;

        .split-line {
          margin: 0;
          padding: 2px 4px;
          background: transparent;
        }

        .split-divider {
          flex: 0 0 auto;
          width: 12px;
          padding: 0;
          justify-content: center;
          opacity: 1;

          .split-divider-line { display: none; }
          .split-divider-label { width: 0; overflow: hidden; opacity: 0; }

          &::before {
            content: '';
            width: 2px;
            height: 16px;
            background: var(--border-default);
            border-radius: 1px;
            transition: background $duration-fast, width $duration-fast;
          }
          &:hover::before { background: var(--accent); }
          &.active::before { background: var(--accent); width: 3px; }
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

  /**
   * Optional: the absolute path of a TRAINING-CORPUS book folder
   * (~/Documents/BookForge/training/<slug>/), set only by the File menu's
   * "Open Corpus Book…".
   *
   * A corpus book is opened to review and correct its labels and NOTHING else.
   * It is not a project, it must not become one, and every path in this
   * component that creates, binds to or writes a project is gated on
   * `corpusMode()` — see `loadCorpusBook`. Its blocks come from the corpus
   * snapshot rather than from the PDF, because the labels are keyed to those
   * exact block ids.
   */
  readonly corpusPath = input<string | null>(null);

  /**
   * The importer asked "detect page-layout categories?" and the user said yes.
   *
   * PDFs only — an EPUB carries its own structure, so there is nothing for the
   * rubric model to recover and the importer never asks. The flag arrives on the
   * route because this window is created by the import, so there is no earlier
   * moment at which to tell it. See `runImportDetection`.
   */
  readonly detectOnOpen = input<boolean>(false);

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

  /**
   * Rejoin the classification run for whichever book just finished opening.
   *
   * An effect rather than a call at the end of each load path, because there are
   * several (project, PDF, restored tab) and a reattach missed on one of them
   * looks exactly like the bug this whole mechanism exists to fix. Keyed on the
   * book identity so it fires once per book, not once per block mutation.
   */
  private reattachedRunKey = '';
  private readonly detectReattachEffect = effect(() => {
    const key = this.editorState.fileHash() || this.pdfPath();
    const ready = this.blocks().length > 0;
    if (!key || !ready || this.reattachedRunKey === key) return;
    this.reattachedRunKey = key;
    void this.reattachDetectionRun();
  });

  /**
   * Fire the import-time detection once the book is actually open.
   *
   * An effect rather than a call inside the load path for the same reason as
   * `detectReattachEffect`: several paths finish a load. Readiness is
   * `pdfLoaded`, NOT a non-empty block list — a scan has no blocks until it has
   * been OCR'd, which is precisely the work this is here to start.
   */
  private importDetectionStarted = false;
  private readonly importDetectionEffect = effect(() => {
    if (!this.detectOnOpen() || this.importDetectionStarted) return;
    if (!this.pdfLoaded() || this.totalPages() === 0) return;
    this.importDetectionStarted = true;
    void this.runImportDetection();
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
    // Keyed on the file actually loaded into the viewer, NOT pdfName —
    // pdfName is restored from the project file's source_name, i.e. whatever
    // an earlier session edited. Opening a PDF variant of a project last
    // touched as an EPUB left pdfName ending .epub, which grayed out OCR on
    // an open PDF (and would have blocked the whole labelling pipeline).
    const loaded = this.editorState.effectivePath() || this.pdfName();
    return loaded.toLowerCase().endsWith('.epub');
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
    // Before anything loads: main may already be classifying a book from before
    // this renderer existed, and its progress events must not fall on the floor
    // while the document opens.
    this.watchDetectionRun();
    this.destroyRef.onDestroy(() => {
      this.detectRunUnsubscribe?.();
      this.detectRunUnsubscribe = null;
    });

    const corpusDir = this.corpusPath();
    if (corpusDir) {
      // Training-corpus book: blocks and labels come from the corpus folder,
      // never from a project. Checked FIRST so no project path can run for it.
      setTimeout(() => void this.loadCorpusBook(corpusDir), 0);
    } else if (this.embedded() && this.bfpPath()) {
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

    // Ctrl/Cmd + E for export (not while typing in a field). Corpus books have
    // nothing to export — they are label data, not a book being produced.
    if ((event.metaKey || event.ctrlKey) && event.key === 'e'
        && !this.isTextInputTarget(event.target)) {
      event.preventDefault();
      if (this.pdfLoaded() && !this.corpusMode()) {
        this.showExportSettings.set(true);
      }
    }

    // Ctrl/Cmd + S writes a corpus book's labels. Only in corpus mode — an
    // ordinary document autosaves, so binding it there would mean nothing.
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 's'
        && this.corpusMode() && !this.isTextInputTarget(event.target)) {
      event.preventDefault();
      void this.saveCorpusLabels();
      return;
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

      // Digits activate the rail row bound to them (the pointer modes keep S/E).
      if (key >= '1' && key <= '9') {
        const taskId = taskForDigit(Number(key));
        if (taskId && !this.disabledTasks().has(taskId)) {
          event.preventDefault();
          this.onRailPanelClick(taskId);
        }
        return;
      }

      // Category assignment — label mode only. Normal editing keeps these keys
      // free: someone cleaning a book shouldn't be able to reassign a category
      // by brushing a letter key with blocks selected.
      if (this.labelMode() && this.selectedBlockIds().length > 0 && !this.reviewMode()) {
        const categoryId = CATEGORY_SHORTCUTS[event.shiftKey ? `shift+${key}` : key];
        if (categoryId) {
          event.preventDefault();
          this.onSetBlockCategory({ blockIds: [...this.selectedBlockIds()], categoryId });
          return;
        }
      }

      // Walk the blocks the classifier was least sure about.
      if (key === 'n' && this.labelMode()) {
        event.preventDefault();
        this.goToUncertainBlock(event.shiftKey ? -1 : 1);
        return;
      }

      switch (key) {
        case 's': // Pointer: select
          event.preventDefault();
          this.onRailPanelClick('select');
          break;
        case 'e': // Pointer: edit
          event.preventDefault();
          this.onRailPanelClick('edit');
          break;
        case 'd': // Detect: the category model's predictions, as a preview
          event.preventDefault();
          this.onRailPanelClick('detect');
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

  /**
   * Was the EPUB now under review produced by the markup-preserving export?
   *
   * The review station always has an EPUB loaded, so the loaded file's extension
   * cannot answer this — a PDF's rebuilt exported.epub looks identical to a
   * preserved one. It decides whether finishing the pipeline may write the review's
   * edits back into the file (a rebuild, fine for a PDF) or must refuse to
   * (it would flatten a preserved book). Cleared on return to editing.
   */
  private reviewExportWasPreserving = false;

  // ── Bottom-bar station model ──────────────────────────────────────────────
  // The path is Prepare → Review. 'select' is visited from the start. Returning
  // to editing after a generate clears the 'epub-review' visit (the output is
  // now stale → must regenerate).
  readonly visitedStations = signal<Set<PipelineStep>>(new Set<PipelineStep>(['select']));

  /** True while showing the read-only generated EPUB for final approval. */
  readonly reviewMode = computed(() => this.pipelineStep() === 'epub-review');

  /** Busy spinner state for the bottom bar during generate/reload/save. */
  readonly pipelineBusy = signal(false);

  private readonly pipelineStationMeta: Record<PipelineStep, { label: string; context: string }> = {
    'select':      { label: 'Prepare book', context: 'Work through the rail on the left: crop, split, OCR, remove what you don’t want, and mark chapters.' },
    'epub-review': { label: 'Review',       context: 'The final text for TTS. Approve, or go back to fix.' },
  };

  /** Chips for the bottom bar, in path order, with per-station state. */
  readonly pipelineStations = computed<PipelineStation[]>(() => {
    const order: PipelineStep[] = ['select', 'epub-review'];
    const current = this.pipelineStep();
    const visited = this.visitedStations();
    return order.map(id => {
      let state: PipelineStation['state'];
      if (id === current) state = 'current';
      else if (visited.has(id)) state = 'done';
      else state = 'todo';
      return { id, label: this.pipelineStationMeta[id].label, state };
    });
  });

  readonly pipelineContext = computed(() => this.pipelineStationMeta[this.pipelineStep()].context);

  readonly pipelinePrimaryLabel = computed(() => {
    switch (this.pipelineStep()) {
      case 'select':      return 'Generate EPUB →';
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
  // True when the split popover is operating in text-fallback mode (block has no
  // span geometry — e.g. OCR-glued title + paragraph). Split points are picked
  // over the block's text (by line breaks, else by word boundaries) and child
  // block geometry is synthesised from the original block's bounding box.
  readonly splitPopoverTextMode = signal<boolean>(false);

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
  /**
   * Categories whose highlights are hidden in the viewer. Purely a view toggle
   * (Cmd-click a custom category), and deliberately SEPARATE from what gets
   * exported — those were the same flag until Jul 2026, so hiding a category's
   * highlights also dropped its blocks from the EPUB with nothing on screen
   * saying so. Not persisted: it is a glance, not a decision about the book.
   */
  readonly hiddenCategoryIds = signal<Set<string>>(new Set());

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

    // Hide the highlights of categories the user has toggled off. This is a
    // VIEW concern and nothing else: it used to share the `enabled` flag with
    // export inclusion, so hiding a custom category's highlights also silently
    // dropped its blocks from the EPUB. Two jobs, now two pieces of state.
    const hidden = this.hiddenCategoryIds();
    const analysisHighlightCats = this.analysisHighlightCategories();
    const filtered = new Map<string, Record<number, MatchRect[]>>();
    for (const [categoryId, pageHighlights] of base) {
      // Check both regular categories and analysis highlight categories
      const cat = categories[categoryId] || analysisHighlightCats[categoryId];
      if (cat && !hidden.has(categoryId)) {
        filtered.set(categoryId, pageHighlights);
      }
    }

    return filtered;
  });

  // Categories extended with preview category (for pdf-viewer when regex modal is open)
  readonly categoriesWithPreview = computed<Record<string, Category>>(() => {
    // In label mode categoriesArray() unions in the standard categories, so
    // the viewer can resolve a colour for EVERY assignable category — without
    // this, a block labelled with a category the detector never created fell
    // back to the viewer's orange placeholder colour.
    const base = this.labelMode()
      ? Object.fromEntries(this.categoriesArray().map(c => [c.id, c]))
      : this.categories();
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
        // AnalysisCategory, NOT a block Category — a different type with its own
        // `enabled`, untouched by the block-category change.
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

  /**
   * The one rail row shown as current: the open panel, or — with no panel open
   * — whichever pointer mode is live. The rail is the mode switcher, so this is
   * what tells the user where they are.
   */
  readonly railCurrent = computed<PanelId>(() => this.activePanel() ?? this.viewerInteraction());

  /**
   * Label mode: assign a training category to the selected blocks by clicking
   * the palette or pressing its key. It is a mode like Crop, reachable from the
   * rail on any open book.
   *
   * Labels are ordinary project state (`category_corrections`), the same field
   * Select and Edit read, so a category set here shows up everywhere and
   * survives in the book's project file. Training sessions under
   * ~/Documents/BookForge/training/ are treated as READ-ONLY history: they are
   * imported into a project that has no labels yet, and never rewritten.
   */
  readonly labelMode = computed(() => this.activePanel() === 'label');

  /**
   * Detect mode: run the fine-tuned category model over the book and paint what
   * it predicts. A PREVIEW — predictions are held here in memory, never written
   * to `category_corrections` and never saved, so looking at the model cannot
   * damage the hand-labelling it is trained from. Closing the book drops them.
   */
  readonly detectMode = computed(() => this.activePanel() === 'detect');
  readonly detectPredictions = signal<Map<string, string>>(new Map());

  /**
   * What Detect mode actually PAINTS: the predictions, with any hand label
   * overriding the model.
   *
   * Predictions are a snapshot of one run and never learn about corrections made
   * afterwards, so painting them raw meant the colours drifted out of agreement
   * with the panel the longer someone worked. The panel's highlight counts
   * `block.category_id`, which corrections DO update — so a corrected block was
   * painted the model's colour while the row that lit up was the real label. On
   * Nuremberg that hit 133 blocks, 83 of them corrected from `heading` to `list`:
   * an orange block that lights the olive row, which reads as the palette being
   * broken rather than as the prediction being stale.
   *
   * Corrections win, matching the rule the rest of the labelling path already
   * follows — a human judgement is never overwritten by a model's.
   */
  readonly detectPaintOverride = computed(() => {
    const merged = new Map(this.detectPredictions());
    for (const [id, categoryId] of this.editorState.categoryCorrections()) {
      merged.set(id, categoryId);
    }
    return merged;
  });
  // Defaults to the BUILT-IN runtime: the downloaded GGUF on the llama-server
  // that ships with the app. It used to default to Ollama, which meant Detect
  // silently required a separate install plus a hand-built `ollama create` —
  // not a thing to ask of someone who wants to make an audiobook. Ollama and
  // the remote GPU service remain for anyone already set up that way, and for
  // trying a checkpoint before it has been quantized.
  readonly detectBackend = signal<DetectBackend>(
    (localStorage.getItem('bookforge-rubric-backend') as DetectBackend) || 'local');
  // Default to the model that actually exists. Ollama's model list is the
  // authority here, and a default naming something absent would fail on the
  // first click for no reason.
  /**
   * No hardcoded model name as the fallback. There used to be one — 'rubric-v1'
   * — and it aged into a trap: v1 answers with the retired front_matter/back_matter
   * taxonomy, so a fresh install silently defaulted to the WORST installed model
   * and to a class list the app no longer paints. Empty means "not chosen yet",
   * and refreshDetectModels() resolves it against what is actually installed.
   */
  readonly detectModel = signal<string>(
    localStorage.getItem('bookforge-rubric-model') || '');
  readonly detectEndpoint = signal<string>(
    localStorage.getItem('bookforge-rubric-endpoint') || 'http://localhost:11434');
  private readonly detectRunning = signal(false);
  private readonly detectDone = signal(0);
  private readonly detectTotal = signal(0);
  private readonly detectError = signal('');
  private readonly detectAdapter = signal('');
  /** Model names Ollama currently holds, refreshed when Detect is opened. */
  private readonly detectAvailableModels = signal<readonly string[]>([]);

  /**
   * What the model answered, kept so a later hand label can be compared against
   * it. `detectPredictions` is cleared whenever a run starts and is what the
   * overlay paints; this survives leaving Detect mode, because the corrections
   * happen afterwards in Label mode.
   *
   * Diagnostics only — see `writeModelCorrections`. Nothing here is training
   * data, and it never reaches `category_corrections`.
   */
  private readonly detectPredictionSnapshot = signal<Map<string, string>>(new Map());
  private readonly detectSnapshotAdapter = signal('');

  /**
   * Whether a pre-adopt label snapshot exists on disk for this book, gating the
   * Restore button. Set when adopting writes one, and checked once on open so a
   * snapshot from a previous session is still reachable after a reload — which
   * is the entire reason it is on disk rather than in the undo stack.
   */
  readonly hasLabelSnapshot = signal(false);

  /**
   * A block-category fine-tune, by name. The prompt is written for THIS model
   * family — a general chat model receives Qwen3 control tokens it may not even
   * share and answers with prose, so the picker separates the two rather than
   * letting a plausible-looking wrong choice hide among the rest.
   */
  private static isRubricName(name: string): boolean {
    return /^rubric/i.test(name);
  }

  /**
   * Pick the best available block-category model.
   *
   * Highest prompt version wins, because a version is a TAXONOMY: v1 and v2
   * still answer with `front_matter`/`back_matter`, classes v3 retired after
   * they were found to be swallowing 18% of the corpus. An older adapter is not
   * a slightly worse model, it is a model answering a different question.
   *
   * Ties are broken by Ollama's own order, which is newest-modified first — so
   * the most recently exported model of the current taxonomy wins, which is
   * what someone who has just finished a training run expects to see selected.
   */
  private static bestRubricModel(models: readonly string[]): string | undefined {
    const trained = models.filter(m => PdfPickerComponent.isRubricName(m));
    if (!trained.length) return undefined;
    let best = trained[0];
    let bestVersion = rubricVersionFor(best);
    for (const m of trained.slice(1)) {
      const v = rubricVersionFor(m);
      if (v > bestVersion) { best = m; bestVersion = v; }
    }
    return best;
  }

  readonly detectModelOptions = computed(() => {
    const all = this.detectAvailableModels();
    const trained = all.filter(n => PdfPickerComponent.isRubricName(n));
    const other = all.filter(n => !PdfPickerComponent.isRubricName(n));
    const groups: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [];
    if (trained.length) {
      groups.push({ label: 'Block-category models', options: trained.map(n => ({ value: n, label: n })) });
    }
    if (other.length) {
      groups.push({ label: 'Not trained for this', options: other.map(n => ({ value: n, label: n })) });
    }
    return groups;
  });

  readonly detectModelIsTrained = computed(() => {
    const chosen = this.detectModel();
    return !chosen || PdfPickerComponent.isRubricName(chosen);
  });

  readonly detectState = computed<DetectRunState>(() => ({
    running: this.detectRunning(),
    done: this.detectDone(),
    total: this.detectTotal(),
    error: this.detectError(),
    predicted: this.detectPredictions().size,
    adapter: this.detectAdapter(),
  }));

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

  // Full SHA-256 of the file the CURRENT document's blocks were analyzed from,
  // straight off the analyzer (per-document, saved/restored on tab switch via
  // OpenDocument.sourceSha256). Persisted as source_file_sha256 so a project's
  // edits can be proven to belong to the file they were made against.
  private readonly analyzedSourceSha256 = signal<string | null>(null);

  /**
   * The analyzed file's hash, for writing into a project. Every analyzer path
   * returns one, so absence here means the document was loaded some other way —
   * a bug that must not be papered over by saving edits with no file to bind them
   * to (that is exactly the state this field exists to make impossible).
   */
  private requireAnalyzedSourceSha256(): string {
    const sha = this.analyzedSourceSha256();
    if (!sha) {
      throw new Error(
        `Cannot save the project: no SHA-256 is known for the analyzed source file `
        + `(${this.effectivePath() || 'no path'}). The document was not loaded through the analyzer.`,
      );
    }
    return sha;
  }

  /**
   * Set when the bound project's saved edits were NOT applied to this document,
   * because they belong to a different file (a derived version such as
   * source/exported.epub, or a source that changed under the project).
   *
   * It exists to stop the session from DESTROYING what it declined to load. The
   * save path serializes the live editor state wholesale: manifest saves overwrite
   * manifest.source.deletedBlockIds / .editor.* / .chapters outright, and the
   * legacy .bfp merge in main preserves only audiobook, audiobookFolder and
   * created_at. So a session that (correctly) shows none of the project's
   * deletions would write an EMPTY edit set over the user's real editing work the
   * first time anything autosaved. While this is set, nothing saves project state.
   *
   * Per-document: snapshot/restored via OpenDocument.projectStateNotApplied, and
   * cleared whenever a document is loaded or closed.
   */
  private readonly projectStateNotApplied = signal(false);

  /** Told to the user both when the edits are declined and when a save is refused. */
  private readonly PROJECT_STATE_NOT_APPLIED_MESSAGE =
    'This document is a different version of the project\'s source file, so the project\'s '
    + 'saved edits — deleted pages, text corrections, chapters — were not loaded into it.\n\n'
    + 'Saving from here would replace those edits with what this session shows instead, so '
    + 'the project is left untouched. Open the project\'s own source file to change its edits.';

  /**
   * Why a project's saved edits do NOT belong to the file that was just analyzed —
   * or null when they do (or when nothing on file can prove otherwise).
   *
   * Every deletion, correction and chapter marker is keyed to a block id, and block
   * ids exist only relative to ONE analysis of ONE exact file. Applied to any other
   * file they address a different book, so they paint arbitrary damage onto it —
   * that is how opening source/exported.epub came up wearing the archive original's
   * deleted pages.
   *
   * ONE signal, and only one: `source_file_sha256`, the digest of the exact file the
   * edits were made against, written by this editor for precisely this purpose. If it
   * agrees the edits belong here no matter which path the file was opened from; if it
   * disagrees they provably do not. Absence means "cannot check", which applies the
   * edits exactly as before rather than inventing a mismatch.
   *
   * `manifest.source.fileHash` was tried as a second signal and is WRONG for this
   * question, so do not reintroduce it. It records the file the project was CREATED
   * from — for duplicate detection — which is not the same claim as "the file these
   * edits were made against": re-import or replace an archive and the two diverge
   * while the edits remain perfectly valid. Measured against the real library
   * (2026-07-30): 266 of 377 projects carry no fileHash at all, and 7 EPUB projects
   * carried one that disagreed with their own archive, so the guard refused to load
   * or save their edits — a false positive on real work, including a book the user
   * was actively editing. A guard that blocks legitimate saves is worse than the
   * cosmetic bug it was added to fix.
   */
  private projectEditsMismatchReason(
    project: BookForgeProject,
    analyzedSha256: string,
  ): string | null {
    const editedFileSha = project.source_file_sha256;
    if (!editedFileSha) return null; // nothing on file can prove otherwise

    return editedFileSha === analyzedSha256
      ? null
      : `the project's edits were made against the file with SHA-256 ${editedFileSha}, `
        + `but this document was analyzed from ${analyzedSha256}`;
  }

  // Page deletion - delegate to editor state (has undo/redo support)
  get deletedPages() { return this.editorState.deletedPages; }

  // Organize mode state (page selection, deletion, reordering). Active on the
  // default/cleanup/merge/OCR panels — i.e. any panel that does not commandeer
  // the pointer (crop/split/chapters/paragraphs/analysis do).
  readonly organizeMode = computed(() => {
    const panel = this.activePanel();
    return panel === null || panel === 'ocr' || panel === 'cleanup'
      || panel === 'merge' || panel === 'label';
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
      // A corpus book is opened to correct its labels; there is no EPUB to make
      // and nowhere for one to go, so it gets the Save-labels action instead.
      const actionItems: ToolbarItem[] = this.corpusMode()
        ? [
            { id: 'saveCorpusLabels', type: 'button', icon: '💾', label: 'Save labels',
              tooltip: 'Write labels back to this corpus book (Cmd+S)',
              disabled: !!this.corpusReadOnlyReason() },
          ]
        : inFixMode
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
    const splitConfig = this.splitConfig();
    return deriveAllTaskStatuses({
      removedBlockCount: deletedBlockIds.size,
      textEditCount: this.editorState.blockEdits().size,
      labelCount: this.editorState.categoryCorrections().size,
      detectPredictionCount: this.detectPredictions().size,
      crop: { croppedPageCount: this.editorState.cropRegions().size },
      split: {
        applied: this.splitApplied(),
        enabled: splitConfig.enabled,
        skippedCount: splitConfig.skippedPages.size,
        pageDimensions: this.pageDimensions(),
      },
      ocr: { blocks, deletedBlockIds, totalPages: this.totalPages() },
      cleanup: { blocks, deletedBlockIds },
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
   *
   * Select and Edit are never disabled. They are how the pointer behaves rather
   * than work to be done, and a rail whose current row is disabled would have
   * nowhere to put the user.
   */
  readonly disabledTasks = computed<Map<TaskId, string>>(() => {
    const disabled = new Map<TaskId, string>();
    const isEpub = this.isCurrentDocumentEpub();
    const lightweight = this.lightweightMode();
    const step = this.pipelineStep();

    // A corpus book is open for two jobs: recognizing its blocks, and checking
    // and correcting the labels on them. Everything else on the rail produces
    // project output there is no project to hold.
    //
    // OCR is allowed because it is how a book that has only been ADDED gets any
    // blocks at all, and `persistCorpusOcr` writes the result straight back to
    // the book's own folder. It is refused the moment labels exist, though: a
    // fresh OCR pass mints new block ids (`ocr_p3_k2x9f1_17` — the suffix is per
    // run), so it does not move those labels onto new blocks, it orphans every
    // one of them. The backend refuses the same case, and this gate exists so
    // the user is told before the pass runs rather than after.
    //
    // Both the file on disk and the editor count. Normally they are the same
    // set — the snapshot's labels ARE the editor's corrections — but they come
    // apart in the two cases that matter: labels typed since the last save, and
    // a snapshot that could not be applied because it describes a different
    // document. Labels typed since the last save are exactly as easy to destroy
    // as saved ones, so either being non-empty closes the door.
    if (this.corpusMode()) {
      const snapshot = this.corpusBook()?.session;
      const savedLabels = snapshot ? Object.keys(snapshot.labels).length : 0;
      const editorLabels = this.editorState.categoryCorrections().size;
      for (const id of TASK_ORDER) {
        if (id === 'select' || id === 'label' || id === 'detect') continue;
        if (id === 'ocr') {
          if (savedLabels === 0 && editorLabels === 0) continue;
          disabled.set(
            id,
            `This book already carries ${Math.max(savedLabels, editorLabels)} hand labels — a new `
            + 'OCR pass would mint new block ids and orphan every one of them',
          );
          continue;
        }
        disabled.set(id, 'Not available for a training-corpus book');
      }
      return disabled;
    }

    for (const id of TASK_ORDER) {
      if (id === 'select' || id === 'edit') continue;
      if (isEpub && (id === 'crop' || id === 'split' || id === 'ocr')) {
        disabled.set(id, 'PDF only — not available for EPUB');
        continue;
      }
      // An EPUB's blocks come from its own markup, already carrying the
      // structure the classifier exists to recover. Labelling them would train
      // the model on the answer sheet.
      if (isEpub && id === 'label') {
        disabled.set(id, 'Scans only — an EPUB already carries its structure');
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

  /**
   * Factual "Before you export" summary lines for the export modal. Lists
   * tasks whose status is required-missing (⚠) or suggested (●), each as
   * "<glyph> <task label>: <factual detail>". Informational only — it never
   * gates export. Empty array → the modal renders no box.
   */
  readonly exportUnaddressed = computed<string[]>(() => {
    const statuses = this.taskStatuses();
    const disabled = this.disabledTasks();
    const lines: string[] = [];
    for (const id of TASK_ORDER) {
      // Disabled tasks aren't actionable in this context — don't surface them.
      if (disabled.has(id)) continue;
      const status = statuses.get(id);
      if (!status) {
        throw new Error(`taskStatuses is missing the ${id} entry`);
      }
      if (status.kind === 'required-missing' || status.kind === 'suggested') {
        lines.push(`${STATUS_GLYPH[status.kind]} ${TASK_LABELS[id]}: ${status.detail}`);
      }
    }
    return lines;
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
    const existing = Object.values(this.categories()).sort((a, b) => b.char_count - a.char_count);
    if (!this.labelMode()) return existing;
    // Label mode assigns categories by clicking them in this list, so every
    // assignable category must appear — not just the ones the detector (or a
    // restored session) happened to create entries for. Missing ones get live
    // counts from the blocks so the list doubles as a labelling progress view.
    const have = new Set(existing.map(c => c.id));
    const blocks = this.blocks();
    const missing = this.autoDetectedCategoryList()
      .filter(c => !have.has(c.id))
      .map(c => {
        const mine = blocks.filter(b => b.category_id === c.id && !b.is_image);
        return {
          id: c.id, name: c.name, description: '', color: c.color,
          block_count: mine.length,
          char_count: mine.reduce((s, b) => s + (b.char_count || 0), 0),
          font_size: 0, region: 'body',
          sample_text: mine[0]?.text?.slice(0, 80) ?? '',
        };
      });
    return [...existing, ...missing];
  });

  readonly computedBaselines = computed(() => {
    const blocks = this.blocks();
    if (blocks.length === 0) return null;
    return computeCategoryBaselines(blocks);
  });

  // All standard category types for the "Set Category" submenu.
  // Always shows every type — not just ones the auto-detector happened to assign.
  readonly autoDetectedCategoryList = computed(() =>
    // THIRTEEN, and shared/ocr/block-categories.ts is the contract — including
    // the colours, which are NOT taken from `this.categories()`. They used to
    // be ("the user may have customized"), but nothing can customize them and
    // the records that arrive from OCR and from old projects carry a palette
    // that disagrees with the contract, so reading colour from them made the
    // swatches lie about what a colour means.
    //
    // This matters beyond the menu: `saveTrainingSession` records
    // `labelSet: autoDetectedCategoryList()`, so whatever is offered here is
    // what a newly-labelled book declares it was labelled under.
    BLOCK_CATEGORIES.map(cat => ({ id: cat.id, name: cat.name, color: cat.color })));

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
      case 'saveCorpusLabels':
        void this.saveCorpusLabels();
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
      // Enable: mark the background images deleted. Nothing is re-rendered —
      // the viewer whites the page image out in CSS the moment the flag flips
      // (.pdf-image.hidden-for-export), so the scan is gone in one frame.
      //
      // This used to queue a re-render of every affected page through the
      // mupdf worker pool. On a 384-page scan that is 384 render jobs behind a
      // 4-worker pool, and because rerenderPageWithEdits() returns void the
      // `await` in the loop resolved instantly — so the spinner cleared while
      // the renders churned in the background for twenty minutes, swapping
      // images in underneath the user. None of it was needed: the redacted
      // renders were never read back for viewing (CSS already hid the page)
      // and never read back for export either, since exportPdfNoBackgrounds()
      // re-renders in the main process from the deletion list.
      const backgroundImageIds = this.detectBackgroundImages();
      if (backgroundImageIds.length > 0) {
        this.editorState.deleteBlocks(backgroundImageIds);
      }
      this.editorState.removeBackgrounds.set(true);
    } else {
      // Disable: restore the images and drop the flag. Equally instant, and
      // for the same reason — there are no doctored renders to undo, so the
      // full-document reload this used to do had nothing to restore.
      const deletedIds = this.deletedBlockIds();
      const imageBlockIds = this.blocks()
        .filter(b => b.is_image && deletedIds.has(b.id))
        .map(b => b.id);

      if (imageBlockIds.length > 0) {
        this.editorState.restoreBlocks(imageBlockIds);
      }
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
  readonly getPageImageForOcrFn = (pageNum: number): Promise<string | null> => this.getPageImageForOcr(pageNum);

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
    this.analyzedSourceSha256.set(null);
    // No document, nothing declined — the next load decides this again.
    this.projectStateNotApplied.set(false);

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
      // The file is already part of a BFP project.
      // A corpus book is never imported either: importing is what "open it
      // without importing it into BookForge" exists to avoid.
      if (this.embedded() || this.corpusMode()) {
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
        lightweightMode: lightweight,
        sourceSha256: quickResult.sourceSha256,
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
      this.analyzedSourceSha256.set(quickResult.sourceSha256);
      // A fresh document is bound to no project yet, so nothing has been declined.
      // autoCreateProject → restoreProjectState (below) sets this if it has to.
      this.projectStateNotApplied.set(false);

      // A corpus book is not something the user "has open" in the library sense —
      // listing it under recent books is the first step towards it looking like
      // a project.
      if (!this.corpusMode()) {
        this.saveRecentFile(path, quickResult.pdf_name);
      }

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
      //
      // Skipped for a corpus book: its blocks come from the corpus snapshot the
      // labels are keyed to, and a late text-ready event would replace them with
      // freshly extracted ones that no label matches.
      if (this.corpusMode()) {
        // Nothing is extracting, so the spinner must not be left running.
        this.editorState.textLoading.set(false);
      } else if (!quickResult.textReady) {
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

  /**
   * Delete every live block of a class, and restore every deleted one. This is
   * how a class stops reaching exported.epub: `category.enabled` used to do it
   * invisibly and behind the user's back, so the decision is now an explicit,
   * undoable edit like any other.
   *
   * One `deleteBlocks` call on purpose — it is one history entry, so one Cmd-Z
   * puts the whole class back.
   */
  /**
   * Convert a pre-Jul-2026 project's disabled categories into real deletions.
   *
   * `category.enabled === false` used to exclude every block of a class from the
   * export. That flag is gone, and its removal is not neutral for books already
   * on disk: 8 projects in the library carry it, covering 2,366 `header` and 612
   * `footer` blocks. Loading one of those and exporting would narrate the running
   * head and page number on every page — up to 492 of them in one book — with
   * nothing in the editor showing that anything had changed, because none of
   * those blocks are in `deletedBlockIds`.
   *
   * Disabling a class WAS the user saying "leave this out of my book", so that
   * decision is preserved by re-expressing it in the mechanism that now carries
   * it. This is a one-way migration of intent, not a compatibility shim: the
   * blocks become ordinary deletions the user can see, undo, and restore, and
   * the stale flag is dropped from the record so it stops being re-saved as a
   * lie about the project's state.
   *
   * Runs after blocks AND categories are restored — it needs both.
   */
  private migrateDisabledCategoriesToDeletions(
    rawCategories: Record<string, unknown> | undefined,
  ): void {
    if (!rawCategories) return;

    const disabled = new Set(
      Object.entries(rawCategories)
        .filter(([, cat]) => !!cat && (cat as { enabled?: unknown }).enabled === false)
        .map(([id]) => id),
    );
    if (disabled.size === 0) return;

    const toDelete = this.blocks().filter(b => disabled.has(b.category_id));
    if (toDelete.length > 0) {
      const next = new Set(this.editorState.deletedBlockIds());
      for (const b of toDelete) next.add(b.id);
      this.editorState.deletedBlockIds.set(next);
      console.log(
        `[picker] migrated ${toDelete.length} blocks from ${disabled.size} disabled ` +
        `categories (${[...disabled].join(', ')}) into explicit deletions`,
      );
    }

    // Drop the flag so it is not re-saved. normalizeCategories spreads the record
    // verbatim, so an untouched `enabled` would survive every future write.
    this.editorState.categories.update(cats => {
      const out: typeof cats = {};
      for (const [id, cat] of Object.entries(cats)) {
        const { enabled: _dropped, ...rest } = cat as typeof cat & { enabled?: boolean };
        out[id] = rest as typeof cat;
      }
      return out;
    });
  }

  deleteAllBlocksInCategory(categoryId: string): void {
    if (this.reviewMode()) return;
    const deleted = this.deletedBlockIds();
    const toDelete = this.blocks().filter(b => b.category_id === categoryId && !deleted.has(b.id));
    if (toDelete.length === 0) return;

    const affectedPages = new Set(toDelete.map(b => b.page));
    this.editorState.deleteBlocks(toDelete.map(b => b.id));
    this.editorState.clearSelection();
    for (const pageNum of affectedPages) this.rerenderPageWithEdits(pageNum);
  }

  restoreAllBlocksInCategory(categoryId: string): void {
    if (this.reviewMode()) return;
    const deleted = this.deletedBlockIds();
    const toRestore = this.blocks().filter(b => b.category_id === categoryId && deleted.has(b.id));
    if (toRestore.length === 0) return;

    const affectedPages = new Set(toRestore.map(b => b.page));
    this.editorState.restoreBlocks(toRestore.map(b => b.id));
    this.editorState.clearSelection();
    for (const pageNum of affectedPages) this.rerenderPageWithEdits(pageNum);
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

  // Category colour layer: paints every block with its category colour so a
  // re-categorization is visible without selecting blocks one at a time.
  // On by default while labelling — seeing every block's category at a glance
  // IS the job there, whereas during production cleanup it's just noise over
  // the page image.
  readonly showCategoryColors = signal(false);
  private colourLayerDefaulted = false;

  /**
   * Turn the category colour layer on the first time we enter label mode,
   * without fighting the user if they switch it back off.
   */
  private readonly defaultColourLayerForLabelMode = effect(() => {
    if (this.labelMode() && !this.colourLayerDefaulted) {
      this.colourLayerDefaulted = true;
      this.showCategoryColors.set(true);
    }
  });

  /**
   * Align the current OCR blocks against a paired EPUB and apply the derived
   * labels. Hand-set labels always win: any block the user has already
   * categorized is excluded before the aligner's answer is applied, so a
   * re-run can never overwrite review work. Weak-tier labels (island captions,
   * unmarked below-flow footnotes) land with low confidence so the N-walk
   * takes the user straight to them.
   */
  async alignFromEpub(): Promise<void> {
    // The paired EPUB is usually attached to the project as an edition — offer
    // that first, one click, before falling back to a file picker (which still
    // opens in the project's archive so a manual pick is short).
    const projectDir = this.trainingProjectDir();
    let epubPath: string | null = null;
    if (projectDir) {
      const listed = await this.electronService.trainingListEpubs(projectDir);
      const epubs = listed.epubs ?? [];
      if (epubs.length === 1) {
        const name = epubs[0].split(/[/\\]/).pop();
        const { confirmed } = await this.electronService.showConfirmDialog({
          title: 'Align against this edition?',
          message: `${name}`,
          detail: 'This EPUB is attached to the project. Choose Cancel to pick a different file.',
          confirmLabel: 'Align',
          cancelLabel: 'Pick another…',
          type: 'question',
        });
        if (confirmed) epubPath = epubs[0];
      }
      if (!epubPath) {
        const picked = await this.electronService.trainingPickEpub(
          epubs[0] ?? `${projectDir}/archive`);
        if (!picked.success || !picked.path) return;
        epubPath = picked.path;
      }
    } else {
      const picked = await this.electronService.trainingPickEpub();
      if (!picked.success || !picked.path) return;
      epubPath = picked.path;
    }

    const blocks = this.blocks().filter(b => !b.is_image);
    if (blocks.length === 0) {
      this.showAlert({ title: 'Nothing to align', message: 'Run OCR first — alignment labels the OCR blocks.' });
      return;
    }

    this.loading.set(true);
    this.loadingText.set('Aligning against EPUB…');
    let result;
    try {
      result = await this.electronService.trainingAlign({
        epubPath,
        blocks: blocks.map(b => ({
          id: b.id, page: b.page, x: b.x, y: b.y, width: b.width, height: b.height,
          text: b.text, font_size: b.font_size, line_count: b.line_count,
          ocr_confidence: b.ocr_confidence,
        })),
        pageDimensions: this.pageDimensions(),
      });
    } finally {
      this.loading.set(false);
      this.loadingText.set('');
    }

    if (!result.success || !result.labels) {
      this.showAlert({ title: 'Alignment failed', message: result.error || 'Unknown error', type: 'error' });
      return;
    }

    // The health metric is PROSE matches — blocks whose text was actually
    // found in the EPUB stream. Elimination labels (headers, footnotes,
    // captions) are derived FROM the prose envelope, so counting them as
    // "matched" once masked a total collapse: a scan whose embedded text
    // layer was garbage OCR reported 75.8% "matched" with zero body labels,
    // and the title page came out labelled footnote.
    const proseMatches = result.tierCount?.['matched'] ?? 0;
    const prosePct = result.total ? (100 * proseMatches / result.total) : 0;
    if (prosePct < 30) {
      const hasOcrBlocks = blocks.some(b => b.is_ocr);
      this.showAlert({
        title: 'Alignment refused — the texts barely match',
        message:
          `Only ${prosePct.toFixed(0)}% of blocks matched the EPUB's prose, so no labels were applied. ` +
          (hasOcrBlocks
            ? 'That usually means a translation, a different edition, or the wrong book.'
            : 'OCR has not been run — this aligned the PDF\'s embedded text layer, which in scanned ' +
              'books is often broken OCR from whoever made the file. Run OCR (all pages), Merge, ' +
              'then align again.'),
        type: 'warning',
      });
      return;
    }
    const matchedPct = prosePct;

    const existing = this.editorState.categoryCorrections();
    const entries: Array<{ blockId: string; categoryId: string }> = [];
    const weakIds: string[] = [];
    for (const [blockId, info] of Object.entries(result.labels)) {
      if (existing.has(blockId)) continue;         // hand labels are inviolable
      entries.push({ blockId, categoryId: info.category });
      if (info.tier.startsWith('weak:')) weakIds.push(blockId);
    }
    if (entries.length > 0) {
      this.editorState.setBulkCategoryCorrections(entries);
    }
    // Weak labels surface through the uncertainty walk.
    this.editorState.categoryConfidence.update(map => {
      const next = new Map(map);
      for (const id of weakIds) next.set(id, 0.05);
      return next;
    });
    // Aligner labels are project state like any other label; the ordinary
    // autosave persists them.
    this.scheduleAutoSave();

    const skipped = Object.keys(result.labels).length - entries.length;
    this.showAlert({
      title: 'Alignment applied',
      message:
        `${entries.length} blocks labeled from the EPUB (${matchedPct.toFixed(1)}% matched).` +
        (weakIds.length ? `\n${weakIds.length} weak guesses — press N to review them.` : '') +
        (skipped ? `\n${skipped} kept your existing hand labels.` : ''),
    });
  }

  /** Apply a category to the current selection (label-mode palette click). */
  assignSelectedToCategory(categoryId: string): void {
    const selected = this.selectedBlockIds();
    if (selected.length === 0) return;
    this.onSetBlockCategory({ blockIds: [...selected], categoryId });
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

  // ── Detect mode: the fine-tuned category model ──────────────────────────

  setDetectEndpoint(endpoint: string): void {
    this.detectEndpoint.set(endpoint);
    localStorage.setItem('bookforge-rubric-endpoint', endpoint);
  }

  /**
   * Ask the chosen runtime what models it has.
   *
   * For the built-in runtime that is the DOWNLOADED catalog — main answers from
   * disk, so this works with no server running and costs nothing. For Ollama it
   * is a live `/api/tags`. Silent on failure either way: the picker stays empty
   * and pressing Load surfaces the real error.
   */
  async refreshDetectModels(): Promise<void> {
    const backend = this.detectBackend();
    if (backend === 'service') { this.detectAvailableModels.set([]); return; }
    const res = await this.electronService.rubricModels(this.detectEndpoint().trim(), backend);
    const models = res.success && res.models ? res.models : [];
    this.detectAvailableModels.set(models);

    // Ollama reports fully-tagged names ("rubric-v1:latest") while a stored
    // or default choice is usually bare ("rubric-v1"). A dropdown matches its
    // value exactly, so without this the picker opens showing nothing selected
    // even though the model is right there.
    const chosen = this.detectModel();
    if (chosen && !models.includes(chosen)) {
      const tagged = models.find(m => m.split(':')[0] === chosen.split(':')[0]);
      if (tagged) this.setDetectModel(tagged);
    }
    // Nothing chosen yet, or the choice is gone: land on the BEST trained model
    // rather than whichever one Ollama happened to list first.
    if (!this.detectModel() || !models.includes(this.detectModel())) {
      const trained = PdfPickerComponent.bestRubricModel(models);
      if (trained) this.setDetectModel(trained);
    }
  }

  setDetectModel(model: string): void {
    this.detectModel.set(model);
    localStorage.setItem('bookforge-rubric-model', model);
  }

  /**
   * Switching backend moves the endpoint to that backend's default, since a
   * GPU-service URL is never a valid Ollama one and vice versa.
   *
   * The built-in runtime has no user-visible endpoint at all — rubric-server
   * owns its port — so switching to it leaves the stored one alone rather than
   * overwriting a remote URL the user would have to retype on the way back.
   */
  setDetectBackend(backend: DetectBackend): void {
    this.detectBackend.set(backend);
    localStorage.setItem('bookforge-rubric-backend', backend);
    if (backend === 'ollama') this.setDetectEndpoint('http://localhost:11434');
    else if (backend === 'service') this.setDetectEndpoint('http://owens-pc:8770');
    // A model chosen for one runtime rarely names one in another: Ollama reports
    // "rubric-v3-4b:latest", the catalog says "rubric-v3-4b". Cleared so
    // refreshDetectModels lands on something that exists here.
    this.detectModel.set('');
    void this.refreshDetectModels();
  }

  clearDetection(): void {
    this.detectPredictions.set(new Map());
    this.detectError.set('');
  }

  /**
   * Stop the run. Keeps the pages already classified — they cost GPU time and
   * are a valid partial result — and lets the chunk in flight land, so a later
   * re-run resumes from there instead of re-asking.
   */
  async cancelDetection(): Promise<void> {
    await this.electronService.rubricRunCancel(this.detectBookKey());
  }

  /**
   * Copy the model's predictions into `category_corrections` so Label mode can
   * edit them — the point of pre-labelling a book.
   *
   * Detect is a preview until this runs, which is what makes it safe to look at
   * the model on any book. Adopting is therefore explicit, and on a book that
   * already carries labels it CONFIRMS FIRST and writes a snapshot to disk
   * beforehand. Hand labels are the expensive artifact in this project and
   * in-memory undo does not survive a reload.
   *
   * The prediction snapshot is deliberately left in place: `writeModelCorrections`
   * compares final labels against it, so adopting then flipping N blocks records
   * exactly those N as corrections and nothing else.
   *
   * `silent` suppresses the confirmation alert for the automatic path — entering
   * Label mode should not have to be dismissed. The overwrite warning is NOT
   * suppressed by it; that one is a decision, not a notification.
   */
  async adoptDetectPredictions(silent = false): Promise<void> {
    const predictions = this.detectPredictions();
    if (predictions.size === 0) return;

    const existing = this.editorState.categoryCorrections();
    if (existing.size > 0) {
      const choice = await this.electronService.showConfirmDialog({
        title: 'Replace existing labels?',
        message: `This book already has ${existing.size} categor`
          + `${existing.size === 1 ? 'y' : 'ies'} set by hand. Using the model's `
          + `${predictions.size} predictions will overwrite the ones that overlap.`,
        detail: 'Your current labels are saved first, and "Restore labels" in the '
          + 'Label panel brings them back.',
        confirmLabel: 'Use predictions',
        cancelLabel: 'Cancel',
        type: 'warning',
      });
      if (!choice.confirmed) return;

      const projectDir = this.trainingProjectDir();
      if (projectDir) {
        const snap = await this.electronService.trainingSnapshotLabels(projectDir, {
          savedAt: new Date().toISOString(),
          reason: `before adopting ${predictions.size} predictions from `
            + `${this.detectAdapter() || this.detectModel()}`,
          labels: Object.fromEntries(existing),
        });
        // A snapshot that failed to write is the one case worth stopping for:
        // proceeding would destroy the labels the dialog just promised to keep.
        if (!snap.success) {
          this.showAlert({
            title: 'Could not save your labels',
            message: `Nothing was changed.\n${snap.error ?? ''}`.trim(),
            type: 'error',
          });
          return;
        }
        this.hasLabelSnapshot.set(true);
      }
    }

    // REGISTER THE CATEGORIES FIRST. A block whose category_id names a category
    // the document does not carry has no colour to be drawn in, so it silently
    // shows as unlabelled — the assignment succeeded and nothing appeared.
    // Single-block assignment does this too (onSetBlockCategory); adopting a
    // whole book hits it far harder, because the model uses classes the
    // heuristic never assigned and so never registered.
    const existingCategories = this.categories();
    for (const categoryId of new Set(predictions.values())) {
      if (existingCategories[categoryId]) continue;
      const info = this.autoDetectedCategoryList().find(c => c.id === categoryId);
      if (!info) continue;   // not one of the thirteen — ignore rather than invent
      this.editorState.addCategory({
        id: info.id,
        name: info.name,
        description: '',
        color: info.color,
        block_count: 0,
        char_count: 0,
        font_size: 0,
        region: 'body',
        sample_text: '',
      });
    }

    this.editorState.setBulkCategoryCorrections(
      [...predictions].map(([blockId, categoryId]) => ({ blockId, categoryId })));

    // Label mode paints from the category colour layer; without it the labels
    // are there but invisible, which reads as "nothing transferred".
    this.showCategoryColors.set(true);

    // These are real labels now, so drop the preview overlay: leaving it would
    // paint the same answer twice, and clearing it is also what stops the
    // automatic path re-adopting every time Label mode is entered. The snapshot
    // that the correction log compares against is a separate signal and survives.
    this.detectPredictions.set(new Map());

    if (silent) return;
    this.showAlert({
      title: 'Predictions copied',
      message: `${predictions.size} categories are now editable in Label mode. `
        + `Correct them there — what you change is recorded so we can tell which `
        + `categories the model is weakest at.`,
    });
  }

  /**
   * Note whether this book has a restorable snapshot. Called on open, because a
   * snapshot's whole purpose is surviving the reload that clears the undo stack —
   * if the button only appeared in the session that wrote it, it would be gone
   * exactly when it is needed.
   */
  private async refreshLabelSnapshotState(): Promise<void> {
    const projectDir = this.trainingProjectDir();
    if (!projectDir) { this.hasLabelSnapshot.set(false); return; }
    const result = await this.electronService.trainingReadLabelSnapshot(projectDir);
    this.hasLabelSnapshot.set(!!(result.success && result.snapshot));
  }

  /** Put back the labels saved before predictions were adopted. */
  async restoreLabelSnapshot(): Promise<void> {
    const projectDir = this.trainingProjectDir();
    if (!projectDir) return;
    const result = await this.electronService.trainingReadLabelSnapshot(projectDir);
    if (!result.success || !result.snapshot) {
      this.showAlert({
        title: 'Nothing to restore',
        message: 'No labels have been overwritten for this book.',
      });
      return;
    }
    const { labels, savedAt, reason } = result.snapshot;
    const count = Object.keys(labels).length;
    const choice = await this.electronService.showConfirmDialog({
      title: 'Restore saved labels?',
      message: `Puts back the ${count} categor${count === 1 ? 'y' : 'ies'} saved `
        + `${new Date(savedAt).toLocaleString()} (${reason}).`,
      detail: 'This replaces the categories currently set for this book.',
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
      type: 'warning',
    });
    if (!choice.confirmed) return;

    this.editorState.setBulkCategoryCorrections(
      Object.entries(labels).map(([blockId, categoryId]) => ({ blockId, categoryId })));
    this.showAlert({ title: 'Labels restored', message: `${count} categories put back.` });
  }

  /**
   * Select every block the MODEL put in a category — read from the predictions,
   * never from `block.category_id`. The two disagree constantly (that
   * disagreement is the whole point of looking), so selecting by the stored
   * category here would quietly answer a different question than the one the
   * category list is showing.
   *
   * Toggles against the existing selection exactly as Select mode's list does:
   * clicking a category adds its blocks, clicking it again removes them, and
   * other categories already selected are left alone.
   */
  selectPredictedCategory(event: { categoryId: string; additive: boolean }): void {
    const blockIds: string[] = [];
    for (const [blockId, categoryId] of this.detectPredictions()) {
      if (categoryId === event.categoryId) blockIds.push(blockId);
    }
    if (blockIds.length === 0) return;

    const selection = new Set(this.selectedBlockIds());
    const allSelected = blockIds.every(id => selection.has(id));
    if (allSelected) {
      blockIds.forEach(id => selection.delete(id));
    } else {
      blockIds.forEach(id => selection.add(id));
    }
    this.setSelectionWithHistory([...selection]);
  }

  /**
   * Classify every page of the open book and paint the result.
   *
   * Deleted blocks are excluded: they are not in the exported EPUB, so asking
   * the model about them would spend context on blocks nobody will see AND
   * shift the geometry the remaining blocks are judged against — the gap above
   * a block is measured from its predecessor, and a deleted predecessor would
   * change it.
   *
   * The encoder version follows the ADAPTER the service reports rather than a
   * setting here. v1 and v2 were trained on different prompt formats, and
   * sending v2 features to the v1 checkpoint would produce confident nonsense
   * that looks like a bad model rather than a mismatched client.
   */
  async runDetection(): Promise<void> {
    if (this.detectRunning()) return;
    const endpoint = this.detectEndpoint().trim();
    if (!endpoint) return;

    this.detectError.set('');

    const backend = this.detectBackend();
    const model = this.detectModel().trim();
    const health = await this.electronService.rubricHealth(endpoint, backend, model);
    if (!health.success) {
      this.detectError.set(`Cannot reach the model service.\n${health.error ?? ''}`.trim());
      return;
    }
    if (!health.loaded) {
      this.detectError.set('The service is up but has no adapter loaded.');
      return;
    }
    const adapter = health.adapter ?? '';
    this.detectAdapter.set(adapter);

    const encoded = this.encodeForDetection(adapter || model);
    if (!encoded) return;
    this.detectRunning.set(true);
    this.detectDone.set(0);
    this.detectTotal.set(encoded.pages.length);
    this.detectPredictions.set(new Map());
    this.detectRunAnswers = new Array(encoded.pages.length).fill(null);
    this.detectRunVersion = encoded.version;
    this.detectRunPages = encoded.pages;

    // Main owns the loop from here. This side hands over the prompts once and
    // then only listens — so an `ng serve` reload takes the listener with it and
    // leaves the run untouched, and the fresh renderer re-attaches in ngOnInit.
    const res = await this.electronService.rubricRunStart({
      bookKey: this.detectBookKey(),
      endpoint, backend, model, adapter,
      stop: RUBRIC_STOP,
      chunk: 8,
      // `raw` carries the exact chat template the model was trained under.
      // Ollama must not build the prompt itself — its stock Qwen3 template
      // omits the empty <think> block training always included.
      pages: encoded.pages.map(p => ({
        page: p.page, system: p.system, user: p.user, raw: toRawPrompt(p),
      })),
    });
    if (!res.success || !res.state) {
      this.detectRunning.set(false);
      this.detectError.set(res.error ?? 'could not start the run');
      return;
    }
    // A run already in flight for the same pages is JOINED, not restarted, so
    // this replays whatever it has already answered.
    this.absorbRunState(res.state);
  }

  /**
   * The import-time offer, carried out: OCR if the book has no blocks yet,
   * classify, and adopt what comes back.
   *
   * The user agreed to this at import, in a dialog that said OCR would run
   * first — so this is allowed to start a long job unattended. It is NOT
   * allowed to do so quietly: Detect is opened first, so its progress bar and
   * any error are on screen from the moment the window appears, and every
   * failure below ends in a dialog rather than a document that silently never
   * got labelled.
   *
   * Adoption is deferred to `finishRun`, the one place a run stops, because
   * `runDetection` returns as soon as MAIN has taken the work — the answers
   * arrive later over `rubric:run-progress`.
   */
  private async runImportDetection(): Promise<void> {
    // Defence in depth. The importer never asks for an EPUB, but the flag rides
    // a URL, and an EPUB's blocks come from its own markup — classifying them
    // would spend hours re-deriving structure the file already states.
    if (this.isCurrentDocumentEpub()) return;

    this.activatePanel('detect');

    // A born-digital PDF arrives with a text layer already parsed into blocks;
    // only a scan needs Tesseract. Checking is not an optimisation — OCR would
    // replace perfectly good blocks with a worse reading of a picture of them.
    if (this.blocks().length === 0) {
      const settings = this.ocrSettings();
      const pages = Array.from({ length: this.totalPages() }, (_, i) => i);
      const outcome = await this.runHeadlessOcr(settings.engine, settings.language, pages);
      if (!outcome.ok) {
        this.showAlert({
          title: 'Could not detect page layout',
          message: `The PDF had to be OCR'd first, and that failed.\n${outcome.error}`,
          type: 'error',
        });
        return;
      }
    }

    // refreshDetectModels lands on the highest-version installed rubric model;
    // it is silent on failure, so the emptiness afterwards is what we report.
    await this.refreshDetectModels();
    if (!this.detectModel()) {
      this.showAlert({
        title: 'No page-layout model installed',
        message: 'The book is ready to classify, but no rubric model is installed.\n\n'
          + 'Install one from Settings → Add-ons, then press Load categories in the '
          + 'Detect panel.',
        type: 'error',
      });
      return;
    }

    this.adoptWhenRunFinishes = true;
    await this.runDetection();
    // runDetection reports a refusal to start (service unreachable, no adapter,
    // nothing to classify) through detectError and returns without a run — which
    // would otherwise leave the flag armed for whatever the user starts next.
    // Still-armed is the test, not "not running": a run that reached finishRun
    // already disarmed and already said its piece, and two dialogs about one
    // failure is worse than none.
    if (this.adoptWhenRunFinishes && !this.detectRunning()) {
      this.adoptWhenRunFinishes = false;
      const reason = this.detectError();
      if (reason) {
        this.showAlert({ title: 'Could not detect page layout', message: reason, type: 'error' });
      }
    }
  }

  /**
   * The pages to classify, encoded for whichever adapter is loaded, or null with
   * `detectError` set.
   *
   * Deleted blocks are excluded: they are not in the exported EPUB, so asking
   * the model about them would spend context on blocks nobody will see AND
   * shift the geometry the remaining blocks are judged against.
   *
   * The encoder version follows the ADAPTER the service reports rather than a
   * setting here. v1 and v2 were trained on different prompt formats, and
   * sending v2 features to the v1 checkpoint would produce confident nonsense
   * that looks like a bad model rather than a mismatched client.
   */
  private encodeForDetection(adapterOrModel: string):
    { pages: ReturnType<typeof encodeBook>; version: RubricVersion } | null {
    const version: RubricVersion = rubricVersionFor(adapterOrModel);
    const deleted = this.deletedBlockIds();
    const live = this.blocks().filter(b => !deleted.has(b.id));
    if (live.length === 0) {
      this.detectError.set('No blocks to classify — run OCR first.');
      return null;
    }
    const pages = encodeBook(live, this.pageDimensions(), {
      version,
      totalPages: this.totalPages(),
    });
    if (pages.length === 0) {
      this.detectError.set('No pages to classify.');
      return null;
    }
    return { pages, version };
  }

  /**
   * How a run is found again after the renderer was thrown away.
   *
   * The file hash, because it is the one book identity that is stable across a
   * reload — anything minted per session would make every reload look like a
   * different book and orphan the run it was supposed to rejoin. Falls back to
   * the path for a document opened without a hash.
   */
  private detectBookKey(): string {
    return this.editorState.fileHash() || this.pdfPath() || 'unknown';
  }

  /**
   * Answer text by page index for the run being watched, and the pages it was
   * asked about. Plain fields rather than signals: they are bookkeeping for
   * parsing, and nothing renders from them.
   */
  private detectRunAnswers: (string | null)[] = [];
  private detectRunPages: ReturnType<typeof encodeBook> = [];
  private detectRunVersion: RubricVersion = 3;
  private detectRunUnsubscribe: (() => void) | null = null;

  /**
   * Set only by the import-time chain: adopt this run's answers as soon as it
   * stops. A run the user starts by hand stays a preview, which is what makes
   * Detect safe to point at any book.
   */
  private adoptWhenRunFinishes = false;

  /**
   * Adopt a run's state wholesale: parse every answer it holds and paint.
   *
   * Used on attach (where the answers arrived while this renderer did not
   * exist) and on start (where a joined run may already have some).
   */
  private absorbRunState(state: RubricRunState): void {
    this.detectAdapter.set(state.adapter);
    this.detectTotal.set(state.total);
    this.detectDone.set(state.done);
    this.detectRunAnswers = state.answers.slice();
    // `live`, not `status`: a run recovered from disk reads `running` because
    // that is how it was interrupted, but nothing is behind it, so showing a
    // progress bar that will never move would be a lie.
    this.detectRunning.set(state.live);
    if (state.status === 'error' && state.error) {
      this.detectError.set(`Stopped after ${state.done} of ${state.total} pages.\n${state.error}`);
    }
    this.repaintFromRunAnswers();
    if (!state.live) this.finishRun(state);
  }

  /**
   * Re-derive every prediction from the answer text.
   *
   * Parsing is cheap next to generating, and re-parsing the lot is what makes
   * attach trivially correct: there is no incremental state to reconcile, just
   * the same pure function over the same strings.
   */
  private repaintFromRunAnswers(): void {
    if (this.detectRunPages.length !== this.detectRunAnswers.length) return;
    const merged = new Map<string, string>();
    this.detectRunAnswers.forEach((answer, i) => {
      if (answer === null) return;
      const page = this.detectRunPages[i];
      for (const [blockId, category] of parseAnswer(answer, page.blockIds, this.detectRunVersion)) {
        merged.set(blockId, category);
      }
    });
    this.detectPredictions.set(merged);
  }

  /**
   * Record what the model said, once the run is no longer moving.
   *
   * Set even on a partial run — the pages it did answer are still a valid
   * measurement, and a run that stopped early is the normal case on a long book.
   * Adapter recorded alongside, since a log spanning two models is unreadable.
   */
  private finishRun(state: RubricRunState): void {
    this.detectRunning.set(false);
    this.detectPredictionSnapshot.set(new Map(this.detectPredictions()));
    this.detectSnapshotAdapter.set(state.adapter || state.model);

    // The import-time chain's last step. Disarmed first, so a partial run that
    // the user later resumes does not adopt a second time behind their back.
    if (this.adoptWhenRunFinishes) {
      this.adoptWhenRunFinishes = false;
      if (this.detectPredictions().size > 0) {
        void this.adoptDetectPredictions(true);
      } else {
        this.showAlert({
          title: 'Nothing was labelled',
          message: this.detectError()
            || 'The model returned no usable labels for this book.',
          type: 'error',
        });
      }
    }
  }

  /**
   * Follow the run main is driving. Called once, and never unsubscribed while
   * the component lives — a run outlives any single visit to Detect mode, and
   * the whole point is that leaving and coming back does not lose it.
   */
  private watchDetectionRun(): void {
    if (this.detectRunUnsubscribe) return;
    this.detectRunUnsubscribe = this.electronService.onRubricRunProgress((progress) => {
      if (progress.bookKey !== this.detectBookKey()) return;
      for (const { index, answer } of progress.answered) {
        if (index < this.detectRunAnswers.length) this.detectRunAnswers[index] = answer;
      }
      this.detectDone.set(progress.done);
      this.detectTotal.set(progress.total);
      this.repaintFromRunAnswers();

      // A model that answers nothing parseable for the first chunk is the wrong
      // model, not a hard page. Say so rather than grinding through the book
      // painting nothing. Checked here rather than in main, which cannot parse.
      if (progress.done > 0 && progress.done <= 8 && this.detectPredictions().size === 0) {
        this.detectError.set(
          `"${this.detectModel().trim()}" did not answer in the expected format — no `
          + `block labels came back for the first ${progress.done} pages.\n\n`
          + `This prompt is written for the block-category fine-tune. A general `
          + `chat model will not produce "<id> <category>" lines.`);
        void this.electronService.rubricRunCancel(this.detectBookKey());
        return;
      }

      if (progress.status === 'error' && progress.error) {
        this.detectError.set(
          `Stopped after ${progress.done} of ${progress.total} pages.\n${progress.error}`);
      }
      if (progress.status !== 'running') {
        this.finishRun({
          bookKey: progress.bookKey, status: progress.status, live: false,
          model: this.detectModel().trim(), adapter: this.detectAdapter(),
          total: progress.total, done: progress.done,
          answers: this.detectRunAnswers, startedAt: 0, updatedAt: 0,
        });
      }
    });
  }

  /**
   * Rejoin the run for this book, if main is still driving one.
   *
   * This is what makes an edit under src/ survive: `ng serve` reloads the
   * renderer, main keeps classifying, and the fresh renderer arrives here,
   * re-encodes the same pages (cheap — no model involved), and picks up every
   * answer collected while it was gone.
   *
   * Deliberately does NOT restart a dead run. A run that only exists on disk —
   * the app died mid-book — comes back `live: false`, and its partial answers
   * are painted and left alone. Resuming it would mean loading several GB of
   * model as a side effect of opening a book, which is not something to do
   * unasked. Pressing "Load categories" resumes from `done` instead of starting
   * over, because run-start matches the saved fingerprint.
   */
  private async reattachDetectionRun(): Promise<void> {
    const res = await this.electronService.rubricRunAttach(this.detectBookKey());
    const state = res.state;
    if (!state || state.total === 0) return;

    const encoded = this.encodeForDetection(state.adapter || state.model);
    if (!encoded) { this.detectError.set(''); return; }
    if (encoded.pages.length !== state.total) {
      // The book changed while the run was away, so its answers are about pages
      // that no longer line up. Dropped rather than misapplied — the same guard
      // main enforces by fingerprint, applied before anything paints.
      console.info('[detect] ignoring a run for %d pages; the book now encodes to %d',
        state.total, encoded.pages.length);
      return;
    }
    this.detectRunPages = encoded.pages;
    this.detectRunVersion = encoded.version;
    this.absorbRunState(state);
    console.info('[detect] re-attached to a %s run: %d/%d pages already answered',
      state.live ? 'live' : 'stopped', state.done, state.total);
  }

  /**
   * Write the model-correction log: for each block the model answered, the label
   * it ended up with by hand.
   *
   * ONE RECORD PER BLOCK, and only where the two disagree. A block flipped
   * body -> quote -> list yields `list`; a block flipped away and back to the
   * model's own answer yields nothing, because agreeing is not a correction.
   * That falls out of reading final state rather than watching keystrokes —
   * there is deliberately no per-flip hook.
   *
   * This is DIAGNOSTIC, never training data. The corrected label alone is the
   * training signal (cross-entropy already weights a confident mistake more
   * heavily than a near miss); what this answers is which class boundaries are
   * hard and whether a confusion is systematic or scattered.
   */
  private async writeModelCorrections(projectDir: string): Promise<void> {
    const predicted = this.detectPredictionSnapshot();
    if (predicted.size === 0) return;   // Detect never ran for this book

    const labels = this.editorState.categoryCorrections();
    const byId = new Map(this.blocks().map(b => [b.id, b]));
    const at = new Date().toISOString();
    const book = projectDir.split(/[/\\]/).pop() || 'book';
    const adapter = this.detectSnapshotAdapter();

    const records = [];
    for (const [blockId, corrected] of labels) {
      const prediction = predicted.get(blockId);
      // Untouched by the model, or the model already agreed.
      if (prediction === undefined || prediction === corrected) continue;
      const block = byId.get(blockId);
      records.push({
        at, book, adapter, blockId,
        page: block?.page ?? -1,
        predicted: prediction,
        corrected,
        fsize: block?.font_size,
        lines: block?.line_count,
        chars: block?.char_count,
        // Enough text to recognise the block when reading the log; the full
        // string lives in labels.json if it is ever needed.
        text: (block?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }

    const result = await this.electronService.trainingWriteCorrections(projectDir, records);
    if (!result.success) {
      // Diagnostics must never block an export — the labels are the valuable
      // part and they are already written.
      console.error('[Training] Correction log not written:', result.error);
      return;
    }
    console.log(`[Training] ${records.length} model correction(s) -> ${result.path}`);
  }

  recategorizeBlocks(): void {
    const blocks = this.blocks();
    const corrections = this.editorState.categoryCorrections();
    const pageDimensions = this.pageDimensions();
    const thresholds = this.editorState.classificationThresholds();
    const deletedBlockIds = this.deletedBlockIds();

    // One engine. Thresholds always apply; centroids refine the heuristic once
    // corrections exist. Hand-set categories are returned untouched.
    let newAssignments: Map<string, BlockAssignment>;
    try {
      newAssignments = recategorizeBlocksFromLearner(blocks, corrections, pageDimensions, thresholds, deletedBlockIds);
    } catch (err) {
      console.error('[recategorizeBlocks] Classifier threw:', err);
      return;
    }

    // Ensure all assigned categories exist
    const cats = this.categories();
    const catList = this.autoDetectedCategoryList();
    for (const categoryId of new Set([...newAssignments.values()].map(a => a.categoryId))) {
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
          });
        }
      }
    }

    // Build learned map (inferred assignments only — corrections are the
    // user's, not the classifier's, and are skipped entirely here).
    const learned = new Map<string, string>();
    const confidence = new Map<string, number>();
    let changedCount = 0;
    this.editorState.blocks.update(currentBlocks =>
      currentBlocks.map(b => {
        const assignment = newAssignments.get(b.id);
        if (!assignment) return b;

        if (assignment.source !== 'correction') {
          learned.set(b.id, assignment.categoryId);
          confidence.set(b.id, assignment.confidence);
        }

        if (assignment.categoryId !== b.category_id) {
          changedCount++;
          return { ...b, category_id: assignment.categoryId };
        }
        return b;
      })
    );

    this.editorState.learnedCategories.set(learned);
    this.editorState.categoryConfidence.set(confidence);

    const unsure = [...confidence.values()].filter(c => c < 0.15).length;
    console.log(`[recategorizeBlocks] ${changedCount} blocks changed, ${learned.size} inferred, ${corrections.size} locked by hand, ${unsure} low-confidence`);

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
      }
    }

    if (!spans || spans.length === 0) {
      // No span geometry at all — the block was generated by OCR or a different
      // analysis pass (bad OCR frequently glues a chapter title onto the first
      // body paragraph in one block). Fall back to splitting by the block's text
      // so the user can still separate the title from the body.
      this.openTextSplitFallback(block);
      return;
    }

    const lines = this.groupSpansByLine(spans);
    if (lines.length <= 1) {
      this.showAlert({ title: 'Split Block', message: 'Block has only one visual line — nothing to split.', type: 'error' });
      return;
    }

    this.splitPopoverTextMode.set(false);
    this.splitPopoverBlock.set(block);
    this.splitPopoverLines.set(lines);
    this.splitPopoverPoints.set(new Set());
  }

  /**
   * Open the Split Block popover in TEXT-FALLBACK mode for a block that has no
   * span geometry (OCR / synthetic blocks). Split candidates come from the
   * block's own text: by line breaks when present, otherwise by word boundaries
   * (a simple text-position picker). The resulting child blocks are synthesised
   * from the original block's bounding box in confirmTextSplit().
   */
  private openTextSplitFallback(block: TextBlock): void {
    const raw = block.text ?? '';
    let segments: string[];
    if (/\r?\n/.test(raw.trim())) {
      segments = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } else {
      // No line breaks — offer a split point between every word.
      segments = raw.split(/\s+/).map(s => s.trim()).filter(Boolean);
    }

    if (segments.length <= 1) {
      this.showAlert({
        title: 'Split Block',
        message: 'This block has no line breaks or word boundaries to split on.',
        type: 'error',
      });
      return;
    }

    const lines = segments.map(text => ({
      text,
      y: 0,
      height: 0,
      isBold: !!block.is_bold,
      isItalic: !!block.is_italic,
      fontSize: block.font_size,
      fontName: block.font_name,
      spans: [] as Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; font_name: string; is_bold: boolean; is_italic: boolean }>,
    }));

    this.splitPopoverTextMode.set(true);
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
    if (this.splitPopoverTextMode()) {
      this.confirmTextSplit();
      return;
    }
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
            font_size: 0, region: 'body', sample_text: '',
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
    this.splitPopoverTextMode.set(false);
  }

  /**
   * Confirm a TEXT-FALLBACK split (no span geometry). Segments are joined text
   * pieces; child block geometry is synthesised by dividing the original block's
   * bounding box vertically in proportion to each segment's character count. The
   * resulting blocks are real TextBlocks (deletable, bindable to chapter markers,
   * and exported like any other block).
   */
  private confirmTextSplit(): void {
    const block = this.splitPopoverBlock();
    const lines = this.splitPopoverLines();
    const points = this.splitPopoverPoints();
    if (!block || lines.length === 0 || points.size === 0) return;

    const sortedPoints = [...points].sort((a, b) => a - b);
    const segments: string[][] = [];
    let start = 0;
    for (const sp of sortedPoints) {
      segments.push(lines.slice(start, sp).map(l => l.text));
      start = sp;
    }
    segments.push(lines.slice(start).map(l => l.text));

    // Rejoin with the same delimiter we split on so text round-trips cleanly.
    const usedLineBreaks = /\r?\n/.test(block.text ?? '');
    const joiner = usedLineBreaks ? '\n' : ' ';
    const segTexts = segments.map(s => s.join(joiner).trim()).filter(Boolean);

    if (segTexts.length <= 1) {
      this.showAlert({ title: 'Split Block', message: 'Split produced only one block — nothing changed.', type: 'error' });
      this.splitPopoverBlock.set(null);
      this.splitPopoverTextMode.set(false);
      return;
    }

    const totalChars = segTexts.reduce((n, t) => n + t.length, 0) || 1;
    const childBlocks: TextBlock[] = [];
    const childBlockIds: string[] = [];
    let yCursor = block.y;

    for (let i = 0; i < segTexts.length; i++) {
      const text = segTexts[i];
      const isLast = i === segTexts.length - 1;
      const share = text.length / totalChars;
      // Give the last segment whatever height remains to avoid rounding gaps.
      const h = isLast ? Math.max(1, block.y + block.height - yCursor) : Math.max(1, block.height * share);
      const id = this.simpleHash(`${block.id}:tsplit:${i}`);

      const childBlock: TextBlock = {
        id,
        page: block.page,
        x: block.x,
        y: yCursor,
        width: block.width,
        height: h,
        text,
        font_size: block.font_size,
        font_name: block.font_name,
        char_count: text.length,
        region: block.region,
        category_id: block.category_id,
        is_bold: block.is_bold,
        is_italic: block.is_italic,
        is_superscript: false,
        is_image: false,
        is_footnote_marker: false,
        line_count: text.split(/\r?\n/).length,
        is_ocr: block.is_ocr,
      };

      childBlocks.push(childBlock);
      childBlockIds.push(id);
      yCursor += h;
    }

    const definition: SplitDefinition = {
      originalBlockId: block.id,
      splitPoints: sortedPoints,
      childBlockIds,
      childBlocks,
      textMode: true,
    };

    this.editorState.splitBlock(definition);
    this.editorState.updateCategoryStats();
    this.splitPopoverBlock.set(null);
    this.splitPopoverTextMode.set(false);
  }

  /**
   * Restore block splits from persisted data by re-fetching spans and rebuilding
   * child blocks. Called during project restore (no history push).
   */
  private async restoreBlockSplits(splits: Array<{
    originalBlockId: string;
    splitPoints: number[];
    childBlockIds: string[];
    textMode?: boolean;
    childBlocks?: TextBlock[];
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

      // Text-mode splits carry their full child blocks (no spans exist to rebuild
      // from). Restore them directly.
      if (split.textMode && split.childBlocks && split.childBlocks.length > 1) {
        this.editorState.splitBlock({
          originalBlockId: split.originalBlockId,
          splitPoints: split.splitPoints,
          childBlockIds: split.childBlockIds,
          childBlocks: split.childBlocks,
          textMode: true,
        }, false); // false = don't push to history
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
              font_size: 0, region: 'body', sample_text: '',
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

  // Click a category: select its blocks (custom: toggle highlight visibility).
  // Cmd/Ctrl+click: add to the selection (custom: always hide).
  selectAllOfCategory(event: { categoryId: string; additive: boolean }): void {
    const { categoryId, additive } = event;

    // Custom categories: toggle highlight visibility, and track as focused
    if (categoryId.startsWith('custom_')) {
      // Track this as the focused custom category (for keyboard delete)
      this.focusedCategoryId.set(categoryId);

      // Toggle highlight VISIBILITY. Cmd+click always hides.
      this.hiddenCategoryIds.update(hidden => {
        const next = new Set(hidden);
        if (additive || !next.has(categoryId)) next.add(categoryId);
        else next.delete(categoryId);
        return next;
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
    const dims = this.pageDimensions()[pageNum];
    const pageArea = dims ? dims.width * dims.height : 0;

    const pageBlockIds = this.blocks()
      .filter(b => {
        if (b.page !== pageNum || deleted.has(b.id)) return false;
        // Skip the full-page scan behind everything. The viewer already refuses
        // to select it directly, but this path swept it in — which is how a
        // "[Image 612x792]" block ends up categorized as a quote when you select
        // a page and assign it in one keystroke.
        if (b.is_image && pageArea > 0 && b.width * b.height > pageArea * 0.7) return false;
        return true;
      })
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
      this.blocks(),
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
          this.blocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          epubPB.size > 0 ? epubPB : undefined,
          this.metadata()
        )
      : await this.exportService.exportEpub(
          this.blocks(),
          this.deletedBlockIds(),
          this.pdfName(),
          this.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          epubPB,
          this.metadata()
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

  // ─── Training-label sessions ────────────────────────────────────────────

  private readonly trainingExport = inject(TrainingExportService);

  /**
   * The directory this book's training artifacts live in, or null for a
   * standalone file that has neither.
   *
   * For a project this is the project directory, which training-data.ts maps to
   * ~/Documents/BookForge/training/<basename>/. For a corpus book that mapping
   * is the identity — the corpus folder IS <trainingRoot>/<slug> — so the
   * snapshot, correction-log and dataset writers all land in the book's own
   * folder without knowing corpus mode exists.
   */
  private trainingProjectDir(): string | null {
    return this.corpusPath() || this.bfpPath() || null;
  }

  // ─── Corpus books ───────────────────────────────────────────────────────

  /** The corpus book on screen, or null when this is an ordinary document. */
  readonly corpusBook = signal<CorpusBookInfo | null>(null);

  /**
   * True from the moment the component is told it is showing a corpus book —
   * derived from the INPUT, not from `corpusBook()`, so every project-creating
   * path is already gated while the book is still loading.
   */
  readonly corpusMode = computed(() => !!this.corpusPath());

  /**
   * Why this corpus book cannot be saved, or null when it can.
   *
   * Set when the snapshot and the PDF disagree about the book. Labelling still
   * works in the sense that the UI responds, but saving is refused and the
   * banner says so — silently accepting edits that can never be written is
   * worse than not accepting them.
   */
  readonly corpusReadOnlyReason = signal<string | null>(null);

  /**
   * Labels in this corpus book that name a class the current set no longer has
   * (`front_matter` and `back_matter` were retired in Jul 2026).
   *
   * They are preserved on save but cannot be shown — nothing paints them and
   * nothing can assign them — so the banner states the count rather than
   * letting those blocks read as unlabelled.
   */
  readonly corpusRetiredLabelCount = computed(() => {
    if (!this.corpusBook()) return 0;
    const legal = new Set(BLOCK_CATEGORIES.map(c => c.id));
    let count = 0;
    for (const categoryId of this.editorState.categoryCorrections().values()) {
      if (!legal.has(categoryId)) count++;
    }
    return count;
  });

  /**
   * Open a training-corpus book: the PDF for its pages, the corpus snapshot for
   * its blocks and labels.
   *
   * The PDF is loaded through the ordinary `loadPdf` path because that is what
   * sets up page rendering, but every project side effect of that path is gated
   * on `corpusMode()`: no library import, no project binding, no auto-created
   * manifest, no autosave. The blocks it extracts are then REPLACED by the
   * snapshot's, which is the only block set the labels are keyed to.
   *
   * Unless there is no snapshot. A book that has only been ADDED carries
   * book.json and a referenced PDF and nothing else (`session === null`,
   * `from === 'book.json'`), and in that state `loadPdf`'s own extraction is
   * the correct block set precisely because no labels exist yet for a different
   * segmentation to orphan. OCR is what moves the book on from there, and
   * `persistCorpusOcr` is what records the result.
   */
  async loadCorpusBook(dir: string): Promise<void> {
    this.loading.set(true);
    this.loadingText.set('Reading corpus book...');

    const result = await this.electronService.corpusLoad(dir);
    if (!result.success || !result.book) {
      this.loading.set(false);
      // No quiet start-from-empty: a missing or corrupt labels.json looks
      // exactly like a book that has never been labelled, and the difference is
      // hours of work.
      this.showAlert({
        title: 'Could not open this corpus book',
        message: result.error || `Nothing was loaded from ${dir}.`,
        type: 'error',
      });
      return;
    }

    const book = result.book;
    this.corpusBook.set(book);
    await this.loadPdf(book.pdfPath);

    // No snapshot means nothing to pin the editor to, so the snapshot step is
    // skipped entirely and `corpusReadOnlyReason` stays null: this book is
    // perfectly writable, it just has nothing written yet. Marking it read-only
    // would report a normal starting state as a fault.
    const session = book.session;
    if (session) this.applyCorpusSnapshot(book, session);

    await this.refreshLabelSnapshotState();

    // Open on the work that is actually available. With a snapshot on screen
    // that is labelling. Without one the only thing that can happen next is an
    // OCR pass — the Label panel would be a labelling UI over blocks the corpus
    // has never recorded — so go to OCR instead.
    //
    // Via the rail handler rather than `activatePanel`, because OCR is not a
    // panel: the rail entry opens the settings modal (see `onRailPanelClick`).
    // Going through it also means this cannot open a modal the rail forbids.
    if (session) {
      this.activatePanel('label');
    } else {
      this.onRailPanelClick('ocr');
    }
  }

  /**
   * Put the corpus snapshot's blocks, page geometry and labels on screen.
   *
   * Page geometry comes from the snapshot too: block coordinates were recorded
   * against those page boxes, and mixing them with the PDF's own would place
   * every rectangle slightly wrong on any page whose crop box differs.
   *
   * The snapshot is passed in separately from the book rather than read off it,
   * so that "there is no snapshot" is handled by the ONE caller that knows what
   * to do about it instead of being re-checked (or missed) here.
   */
  private applyCorpusSnapshot(
    book: CorpusBookInfo,
    session: NonNullable<CorpusBookInfo['session']>,
  ): void {
    const dims = session.pageDimensions;
    if (dims.length !== this.totalPages()) {
      // Different page count means this is not the document these blocks came
      // from. Show the pages, refuse the write, and say which is which.
      const reason =
        `${book.from} describes ${dims.length} pages but ${book.pdfPath.split(/[/\\]/).pop()} has ` +
        `${this.totalPages()}. These blocks were not recognized from this file, so nothing ` +
        'can be saved back.';
      this.corpusReadOnlyReason.set(reason);
      this.showAlert({ title: 'Corpus book does not match this PDF', message: reason, type: 'error' });
      return;
    }

    this.editorState.pageDimensions.set(dims);
    this.editorState.blocks.set(session.blocks as TextBlock[]);
    this.editorState.categoryCorrections.set(new Map(Object.entries(session.labels)));
    this.applyCorrectionsWithCategories();
    // Loading is not an edit. Nothing can autosave in corpus mode anyway, but
    // leaving the document dirty would make the unsaved-changes indicator lie.
    this.editorState.markSaved();

    console.log(
      `[corpus] ${book.slug}: ${session.blocks.length} blocks, ` +
      `${Object.keys(session.labels).length} labels from ${book.from} ` +
      `(pages from ${book.pdfSource === 'recorded' ? 'the recorded source' : 'a PDF in the corpus folder'})`
    );
  }

  /** Cmd+W with unsaved label edits: save, discard, or stay. */
  private async confirmCloseCorpusBook(): Promise<void> {
    const choice = await this.electronService.showConfirmDialog({
      title: 'Save labels before closing?',
      message: `${this.editorState.categoryCorrections().size} labels are in this book, and your `
        + 'changes have not been written yet.',
      detail: 'Corpus books are not saved automatically.',
      confirmLabel: 'Save and close',
      cancelLabel: 'Keep editing',
      type: 'warning',
    });
    if (!choice.confirmed) return;
    await this.saveCorpusLabels();
    if (this.hasUnsavedChanges()) return;   // the save failed and said so
    this.exitRequested.emit();
  }

  /**
   * Write the labels back to the corpus book's own labels.json.
   *
   * Explicit, because there is no autosave in corpus mode: the corpus is the
   * project's most expensive artifact and a background write over it — on a
   * book that may have loaded wrong — is not something to do on a timer.
   */
  async saveCorpusLabels(): Promise<void> {
    const book = this.corpusBook();
    if (!book) return;

    const blocked = this.corpusReadOnlyReason();
    if (blocked) {
      this.showAlert({ title: 'Not saved', message: blocked, type: 'error' });
      return;
    }

    const labels = Object.fromEntries(this.editorState.categoryCorrections());
    const result = await this.electronService.corpusSaveLabels(book.dir, {
      labels,
      labelSet: this.autoDetectedCategoryList().map(c => c.id),
    });

    if (!result.success || !result.result) {
      this.showAlert({
        title: 'Could not save labels',
        message: result.error || 'Writing labels.json failed. Nothing was changed.',
        type: 'error',
      });
      return;
    }

    const { path: written, labelCount, added, changed, removed } = result.result;
    this.editorState.markSaved();
    // `removed` is stated rather than left implicit: clearing a label is a real
    // edit to the corpus and the count is how the user notices an accident.
    this.showAlert({
      title: 'Labels saved',
      message:
        `${labelCount} labels in this book — ${added} added, ${changed} changed, ${removed} removed.` +
        `\n\n${written}`,
    });
  }

  /**
   * Apply saved category corrections to the blocks AND make sure the categories
   * they name exist on the document.
   *
   * Both halves are required and only one of them was ever done. A correction
   * sets `block.category_id`, but the viewer resolves a block's COLOUR by
   * looking that id up in `categories()` — so a label naming a category the
   * document does not define paints nothing at all. The labels are present,
   * correct, and invisible, which is indistinguishable from having lost them.
   *
   * It bites on reload specifically: `categories()` is rebuilt from what the
   * analyzer detects in the document, and the classes a HUMAN assigns are
   * exactly the ones the heuristic never assigns and therefore never registers —
   * `title`, `table`, `subheading`. A book labelled with 1,516 corrections came
   * back looking blank because of this.
   *
   * Self-healing rather than a persistence fix, deliberately: it repairs books
   * already saved in this state instead of only new ones.
   */
  private applyCorrectionsWithCategories(): void {
    this.editorState.applyCategoryCorrections();

    const defined = this.categories();
    const needed = new Set<string>([
      ...this.editorState.categoryCorrections().values(),
      ...this.editorState.learnedCategories().values(),
    ]);
    let added = 0;
    for (const categoryId of needed) {
      if (defined[categoryId]) continue;
      const info = this.autoDetectedCategoryList().find(c => c.id === categoryId);
      if (!info) continue;   // retired class from an old session — leave it alone
      this.editorState.addCategory({
        id: info.id,
        name: info.name,
        description: '',
        color: info.color,
        block_count: 0,
        char_count: 0,
        font_size: 0,
        region: 'body',
        sample_text: '',
      });
      added++;
    }
    if (added) {
      console.log(`[categories] registered ${added} category definition(s) named by `
        + `saved labels but missing from the document`);
    }
    this.editorState.updateCategoryStats();
  }

  /** The document the current labelling session applies to. */
  private currentTrainingSource(): string | null {
    return this.overrideSourcePath() || this.editorState.effectivePath() || null;
  }

  /** Basename of the labelled document, for the panel's binding notice. */
  readonly labelSourceBasename = computed(() => {
    const src = this.overrideSourcePath() || this.editorState.effectivePath();
    return src ? src.split(/[/\\]/).pop() ?? '' : '';
  });

  /**
   * Copy a previous labelling session's labels into this project, ONCE.
   *
   * Labels are project state now, so the sessions under
   * ~/Documents/BookForge/training/ are history: hand-labelling work that was
   * accurate when it was done and is the only copy of itself. They are read
   * here and never written, and the import only runs for a project that has no
   * labels of its own — so it can never overwrite newer work in the editor.
   *
   * Labels are keyed by block id. OCR block IDs carry a random per-run suffix,
   * so ids from a session recorded against a different OCR run will not match
   * the blocks on screen; unmatched labels are reported rather than quietly
   * dropped, because "0 labels imported" and "this book has no labels" look
   * identical from the outside.
   */
  async importTrainingLabelsOnce(): Promise<void> {
    const projectDir = this.trainingProjectDir();
    if (!projectDir) return;

    // The project already carries labels — nothing to migrate into.
    if (this.editorState.categoryCorrections().size > 0) return;

    // Blocks arrive asynchronously for a PDF. With none loaded there is nothing
    // for archived labels to key to; the text-ready path calls this again.
    if (this.blocks().length === 0) return;

    const result = await this.electronService.trainingLoad(projectDir);
    if (!result.success) {
      console.error('[Training] Failed to read the archived session:', result.error);
      return;
    }
    if (!result.session) return;

    const session = result.session;

    // The session is bound to the file it was labelled against. Importing it
    // into an editor showing any OTHER file would key labels to the wrong
    // pages, so leave it alone and say why.
    const current = this.currentTrainingSource();
    if (session.sourceFile && current && session.sourceFile !== current) {
      const boundName = session.sourceFile.split(/[/\\]/).pop();
      const currentName = current.split(/[/\\]/).pop();
      console.warn(
        `[Training] Archived labels were made against "${boundName}" but "${currentName}" is open — ` +
        'not imported (the pages do not correspond). The archived session is untouched.'
      );
      return;
    }

    const archived = Object.entries(session.labels || {}) as Array<[string, string]>;
    if (archived.length === 0) return;

    const liveIds = new Set(this.blocks().map(b => b.id));
    const matched = archived.filter(([blockId]) => liveIds.has(blockId));

    if (matched.length === 0) {
      console.warn(
        `[Training] ${archived.length} archived labels found for this book, but none of their ` +
        `block ids exist in the document that is open (session blocks: ` +
        `${session.blockSource ?? 'unknown'}${session.ocrEngine ? '/' + session.ocrEngine : ''}). ` +
        'Nothing was imported and the archived session is untouched.'
      );
      return;
    }

    this.editorState.categoryCorrections.set(new Map(matched));
    this.applyCorrectionsWithCategories();

    const missing = (this.autoDetectedCategoryList().map(c => c.id))
      .filter(id => !(session.labelSet || []).includes(id));
    if (missing.length > 0) {
      console.warn(
        `[Training] Session predates these categories: ${missing.join(', ')} — ` +
        'blocks belonging to them were not distinguishable when this book was labelled.'
      );
    }

    console.log(
      `[Training] Imported ${matched.length} of ${archived.length} archived labels ` +
      `(from ${session.savedAt}) into this project.`
    );

    // The import is a migration, not a view: persist it so the labels belong to
    // the book from here on and the archive is never needed again.
    this.scheduleAutoSave();
  }

  /**
   * Write this book's labels to the training corpus — but never over a session
   * that is already there.
   *
   * Existing sessions are the original hand-labelling work and the corpus
   * gatherer's input; replacing one with a derived snapshot would silently
   * rewrite ground truth. Returns false (with the reason surfaced) when a
   * session already exists, which leaves the caller's dataset export to decide
   * whether it still has something worth writing.
   */
  async saveTrainingSession(): Promise<boolean> {
    const projectDir = this.trainingProjectDir();
    if (!projectDir) {
      console.error('[Training] No project directory — labels cannot be exported. ' +
        'Open the book from Studio so the book folder is known.');
      return false;
    }

    const session = {
      version: 1,
      labelSet: this.autoDetectedCategoryList().map(c => c.id),
      savedAt: new Date().toISOString(),
      sourceFile: this.currentTrainingSource() || undefined,
      // Where the blocks came from. Feature values depend on how the page was
      // segmented, and an embedded text layer carries real font metadata that
      // Tesseract's LSTM engine cannot produce — so a corpus that silently
      // mixes the two trains on one distribution and runs on another.
      blockSource: this.blocks().some(b => b.is_ocr) ? 'ocr' : 'embedded',
      ocrEngine: this.blocks().some(b => b.is_ocr) ? this.ocrSettings().engine : null,
      pageDimensions: this.pageDimensions(),
      blocks: this.blocks(),
      labels: Object.fromEntries(this.editorState.categoryCorrections()),
    };

    const result = await this.electronService.trainingSave(projectDir, session);
    if (result.skipped) {
      console.log('[Training] An archived session already exists — left untouched:', result.path);
      return false;
    }
    if (!result.success) {
      this.showAlert({
        title: 'Could not write the training snapshot',
        message: result.error || 'Writing labels.json failed.',
        type: 'error',
      });
      return false;
    }
    return true;
  }

  /**
   * Clear this book's hand-set categories so it can be labelled from scratch.
   *
   * This clears PROJECT state only. Any archived session under
   * ~/Documents/BookForge/training/ stays exactly as it is — it is the original
   * hand-labelling work, and a reset in the editor is not a reason to destroy
   * it. (Re-opening a project with no labels will offer those archived labels
   * back; that import is the only thing that reads them.)
   */
  async resetTrainingSession(): Promise<void> {
    const labelCount = this.editorState.categoryCorrections().size;
    if (labelCount === 0) return;

    const choice = await this.electronService.showConfirmDialog({
      title: 'Clear labels?',
      message: `This clears the ${labelCount} categor${labelCount === 1 ? 'y' : 'ies'} you set by hand for this book, so you can start over.`,
      detail: 'Your exported EPUB, cleaned EPUB, audiobook and any archived training data are not affected.',
      confirmLabel: 'Clear labels',
      cancelLabel: 'Cancel',
      type: 'warning',
    });
    if (!choice.confirmed) return;

    this.editorState.clearAllCategoryCorrections();
    this.editorState.categoryConfidence.set(new Map());
    this.showAlert({ title: 'Labels cleared', message: 'This book is ready to label from scratch.' });
  }

  /** Write dataset.jsonl to the training corpus from the current labels. */
  async exportTrainingData(): Promise<void> {
    const projectDir = this.trainingProjectDir();
    if (!projectDir) return;

    const labels = this.editorState.categoryCorrections();
    if (labels.size === 0) {
      this.showAlert({
        title: 'Nothing to export',
        message: 'No blocks have been categorized by hand yet.',
      });
      return;
    }

    // Snapshot the labels alongside the dataset so the records stay traceable
    // to the blocks they were built from. A book that already has an archived
    // session keeps it (saveTrainingSession refuses to overwrite) and the
    // dataset export continues regardless — the snapshot is provenance, not a
    // precondition.
    await this.saveTrainingSession();

    // Where the model was wrong, alongside the labels rather than inside them.
    // Written on export because that is when the labels are final; a no-op for a
    // book Detect never ran on.
    await this.writeModelCorrections(projectDir);

    const records = this.trainingExport.buildRecords(
      projectDir.split(/[/\\]/).pop() || 'book',
      this.blocks(),
      this.pageDimensions(),
      labels,
    );

    const result = await this.electronService.trainingExport(projectDir, records);
    if (!result.success) {
      this.showAlert({
        title: 'Export failed',
        message: result.error || 'Writing training/dataset.jsonl failed.',
        type: 'error',
      });
      return;
    }

    this.showAlert({
      title: 'Training data exported',
      message:
        `${result.count} page record${result.count === 1 ? '' : 's'} from ${labels.size} ` +
        `hand-set label${labels.size === 1 ? '' : 's'}.\n\n${result.path}`,
    });
  }

  // ─── Uncertain-block review ─────────────────────────────────────────────

  /**
   * Blocks the classifier was least sure about, in reading order.
   *
   * Reviewing these instead of scanning every page is the difference between
   * reading a book and checking its hard cases: after a re-categorize the
   * heuristic is right about most blocks, and confidence marks the ones where
   * it nearly went the other way. Hand-corrected blocks are excluded — they're
   * settled — as are deleted ones.
   */
  readonly uncertainBlocks = computed(() => {
    const confidence = this.editorState.categoryConfidence();
    if (confidence.size === 0) return [];
    const corrections = this.editorState.categoryCorrections();
    const deleted = this.deletedBlockIds();

    return this.blocks()
      .filter(b =>
        !b.is_image &&
        !corrections.has(b.id) &&
        !deleted.has(b.id) &&
        (confidence.get(b.id) ?? 1) < UNCERTAIN_CONFIDENCE
      )
      .sort((a, b) => a.page - b.page || a.y - b.y);
  });

  private uncertainCursor = -1;

  /**
   * Select and scroll to the next (or previous) low-confidence block.
   * Wraps at both ends so the review loop never dead-ends mid-book.
   */
  goToUncertainBlock(direction: 1 | -1): void {
    const candidates = this.uncertainBlocks();
    if (candidates.length === 0) {
      this.showAlert({
        title: 'No uncertain blocks',
        message: this.editorState.categoryConfidence().size === 0
          ? 'Run Re-categorize first — confidence is recorded when the classifier runs.'
          : 'Every block the classifier was unsure about has been reviewed.',
      });
      return;
    }

    // Resume from wherever the current selection sits, so the cursor survives
    // corrections shrinking the list underneath it.
    const selected = this.selectedBlockIds();
    if (selected.length === 1) {
      const at = candidates.findIndex(b => b.id === selected[0]);
      if (at >= 0) this.uncertainCursor = at;
    }

    const next = (this.uncertainCursor + direction + candidates.length) % candidates.length;
    this.uncertainCursor = next;

    const block = candidates[next];
    this.editorState.selectedBlockIds.set([block.id]);
    this.pdfViewer?.scrollToPage(block.page);
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
      this.blocks(),
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
          this.blocks(),
          this.deletedBlockIds(),
          chapters,
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          exportPB.size > 0 ? exportPB : undefined,
          this.metadata()
        )
      : await this.exportService.exportEpub(
          this.blocks(),
          this.deletedBlockIds(),
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          deletedHighlights,
          exportPB,
          this.metadata()
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
    //
    // This runs for an EPUB source too, and the markup loss is INTENDED: text-only
    // means "give me nothing but the words", and the main-process handler converts an
    // EPUB with ebook-convert (it is not PDF-only). So the option is honored as asked
    // rather than quietly upgraded to the markup-preserving path below.
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

    // EPUB source: edit the book's own markup instead of rebuilding it from block
    // text, exactly as finalizeProject() and pipelineExportAndReview() do. Same
    // destination either way — the project's canonical source/exported.epub — and
    // the same navigation to the producer that navigateAfter: true gives below.
    if (this.useEpubPreservingExport()) {
      const projectPath = this.projectPath();
      if (!projectPath) {
        // useEpubPreservingExport() requires a bound project; if that stops being
        // true the export would silently become a Save As with no target.
        throw new Error('Cannot export: the markup-preserving export requires a saved project.');
      }

      const result = await this.runEpubPreservingExport(projectPath, null);
      if (!result.success) {
        // The exporter names the block that blocked the export — verbatim.
        this.showAlert({
          title: 'Export Failed',
          message: result.message,
          type: 'error'
        });
        return;
      }

      // Navigating to the producer unmounts this component, so an alert here would
      // never be read (the legacy path's own post-navigation warning has the same
      // problem). The exporter's notes — unaligned blocks and the like — go to the
      // log where they can still be found.
      console.log('[exportToAudiobook] Markup-preserving export:', result.message);
      await this.router.navigate(['/studio']);
      return;
    }

    const chapters = this.chapters();
    const deletedHighlights = this.getDeletedHighlights();

    const paragraphBreaks = this.editorState.paragraphBreaks();
    const result = await this.exportService.exportToAudiobook(
      this.blocks(),
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

  // ─────────────────────────────────────────────────────────────────────────
  // Markup-preserving EPUB export (the EPUB-source path)
  //
  // A PDF has to be rebuilt from text — there is no markup to keep. An EPUB
  // already IS markup, and rebuilding it threw away every <sup>, <em>, list and
  // heading the book shipped with. So when the file the picker analyzed is an
  // EPUB, export edits that book's own XHTML instead: the edit set goes to the
  // main process, which aligns the blocks back onto their source elements.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The file the current document's blocks were analyzed from — the alignment
   * baseline. `libraryPath` is what was handed to analyzePdfQuick(), so
   * effectivePath() IS that file by construction (override included).
   */
  private analyzedSourcePath(): string | null {
    return this.effectivePath() || null;
  }

  /** True when the analyzed file is an EPUB, so its markup can be preserved. */
  private analyzedSourceIsEpub(): boolean {
    const source = this.analyzedSourcePath();
    return !!source && source.toLowerCase().endsWith('.epub');
  }

  /**
   * True when export must preserve the source EPUB's markup rather than rebuild it.
   *
   * Requires a saved project, because these exports write into the project (its
   * exported.epub, its deleted-examples.json, its manifest provenance). Save As is
   * the exception and checks analyzedSourceIsEpub() directly: it writes wherever
   * the user points it, so a loose EPUB with no project is legal there.
   */
  private useEpubPreservingExport(): boolean {
    return !!this.projectPath() && this.analyzedSourceIsEpub();
  }

  /**
   * The complete edit set for the markup-preserving exporter.
   *
   * ALL live blocks are sent, deleted ones included — the exporter aligns the
   * editor's view of the book against the book, and a block that is missing from
   * the list is a hole in that view, not a deletion. Deleted blocks come along
   * flagged `deleted` instead, which removes their elements deliberately.
   *
   * `text` is the ORIGINAL text in every case: it is what the aligner matches
   * against the source. Edited text travels separately, in `effectiveTexts`.
   *
   * Paragraph breaks are deliberately NOT sent. They exist to reassemble
   * fragmented PDF lines; the source EPUB's own paragraphs are authoritative here.
   */
  private buildEpubPreservingEdits(): EpubPreservingEdits {
    const deletedIds = this.deletedBlockIds();
    const deletedPages = this.deletedPages();

    const ordered = [...this.blocks()].sort((a, b) =>
      a.page !== b.page ? a.page - b.page : a.y - b.y);

    const blocks: EpubExportBlock[] = ordered.map(b => {
      return {
        id: b.id,
        page: b.page,
        y: b.y,
        text: b.text,
        deleted: deletedIds.has(b.id) || deletedPages.has(b.page),
        isImage: !!b.is_image,
        isFootnoteMarker: !!b.is_footnote_marker,
        ...(b.parent_block_id ? { parentBlockId: b.parent_block_id } : {}),
      };
    });

    const foldedDeleted = new Set(blocks.filter(b => b.deleted).map(b => b.id));
    const effectiveTexts = this.exportService.computeEffectiveTexts(
      ordered,
      foldedDeleted,
      this.editorState.textCorrections(),
      this.getDeletedHighlights(),
    );

    // Chapters on deleted pages are dropped, as the legacy export drops them.
    const chapters: EpubExportChapter[] = this.chapters()
      .filter(ch => !deletedPages.has(ch.page))
      .map(ch => ({
        title: ch.title,
        level: ch.level,
        page: ch.page,
        y: ch.y ?? 0,
        ...(ch.blockId ? { blockId: ch.blockId } : {}),
        ...(ch.mergedBlockIds ? { mergedBlockIds: ch.mergedBlockIds } : {}),
      }));

    const meta = this.metadata();
    return {
      blocks,
      effectiveTexts,
      chapters,
      metadata: {
        // Same title derivation as the legacy export (generateEpubBlobInternal):
        // an untitled book still exports, named after its file.
        title: meta.title || this.pdfName().replace(/\.(pdf|epub)$/i, ''),
        author: meta.author,
        language: meta.language,
        publisher: meta.publisher,
        description: meta.description,
        year: meta.year,
      },
    };
  }

  /**
   * Run the markup-preserving export.
   *
   * `projectDir` non-null makes this the project's export: it writes
   * deleted-examples.json beside the EPUB and records the source→export hash pair
   * in the manifest. `savePath` null then means the canonical
   * source/exported.epub. Save As passes projectDir null on purpose — see there.
   */
  private async runEpubPreservingExport(
    projectDir: string | null,
    savePath: string | null,
  ): Promise<EpubExportResult> {
    const source = this.analyzedSourcePath();
    if (!source) {
      return { success: false, message: 'No source file is loaded to export from.' };
    }

    return this.exportService.exportEpubPreserving(
      projectDir,
      source,
      savePath,
      this.buildEpubPreservingEdits(),
      this.blocks(),
      this.deletedBlockIds(),
      this.getDeletedHighlights(),
    );
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
      // An EPUB source keeps its markup, wherever the user saves it. No project is
      // needed: the export aligns against the very file that was analyzed.
      //
      // projectDir is null even when a project IS open, so this stays what Save As
      // has always been — a copy for the user, which does not touch the project.
      // Passing the project here would drop deleted-examples.json wherever they
      // saved and overwrite the manifest's provenance, which exists to name the
      // project's OWN exported.epub, with a throwaway file's hash.
      let result: EpubExportResult;
      if (this.analyzedSourceIsEpub()) {
        const baseName = (this.metadata().title || this.pdfName()).replace(/\.[^.]+$/, '');
        const chosen = await this.electronService.showSaveEpubDialog(`${baseName}.epub`);
        if (chosen.canceled) {
          result = { success: false, message: 'Canceled' };
        } else if (!chosen.success || !chosen.filePath) {
          result = { success: false, message: chosen.error || 'Failed to choose a save location' };
        } else {
          result = await this.runEpubPreservingExport(null, chosen.filePath);
        }
      } else {
        const saveAsPB = this.editorState.paragraphBreaks();
        result = await this.exportService.saveEpubAs(
          this.blocks(),
          this.deletedBlockIds(),
          this.chapters(),
          this.pdfName(),
          this.editorState.textCorrections(),
          this.deletedPages(),
          this.getDeletedHighlights(),
          this.metadata(),
          saveAsPB.size > 0 ? saveAsPB : undefined,
        );
      }

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

    // EPUB source: edit the book's own markup instead of rebuilding it.
    //
    // The save-back-in-place target above does NOT apply here. That rule means
    // "write into the derived version you opened", and on this path the file the
    // user opened is the ALIGNMENT BASELINE — every block id in the edit set was
    // resolved against its bytes. Writing the export over it would destroy the
    // only file those edits mean anything against (and the main process refuses
    // it outright). The canonical source/exported.epub is the target instead;
    // Save As is how the user writes a preserved EPUB anywhere else.
    if (this.useEpubPreservingExport()) {
      try {
        const result = await this.runEpubPreservingExport(projectPath, null);

        if (result.success && result.epubPath) {
          // NO enterParagraphFixMode: it reloads the export and rebuilds it from
          // plain text, which would undo everything this path just preserved.
          // Paragraph repair is a PDF concern — the source EPUB's paragraphs are
          // already the author's.
          this.finalized.emit({ success: true, epubPath: result.epubPath });
          this.showAlert({
            title: 'Saved',
            message: result.message,
            type: 'success'
          });
        } else {
          // The exporter names the block that blocked the export — verbatim.
          this.finalized.emit({ success: false, error: result.message });
          this.showAlert({
            title: 'Save Failed',
            message: result.message,
            type: 'error'
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.finalized.emit({ success: false, error: errorMessage });
        this.showAlert({ title: 'Save Failed', message: errorMessage, type: 'error' });
      } finally {
        this.loading.set(false);
      }
      return;
    }

    try {
      const chapters = this.chapters();
      const deletedHighlights = this.getDeletedHighlights();

      // Export to audiobook folder - NEVER modifies the original source file
      const pBreaks = this.editorState.paragraphBreaks();
      const result = await this.exportService.exportToAudiobook(
        this.blocks(),
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
  // Pipeline Navigation (Prepare → EPUB Review)
  // ─────────────────────────────────────────────────────────────────────────

  /** The bottom bar's primary button: generate the EPUB, or finish at review. */
  pipelinePrimary(): void {
    switch (this.pipelineStep()) {
      case 'select':      this.requestGenerate(); break;
      case 'epub-review': this.pipelineComplete(); break;
    }
  }

  /** The bottom bar's Back button: step one station toward the source. */
  pipelineBack(): void {
    if (this.pipelineStep() === 'epub-review') this.pipelineReloadSource('select');
  }

  /**
   * Generate the EPUB, after making sure chapters were not simply forgotten.
   *
   * The check is a warning, not a gate: an article or a single essay really is
   * one chapter, and a hard block would strand those books. But an unchaptered
   * book produces one enormous audiobook file with no navigation, and that is
   * discovered hours later at TTS time — so it is worth one interruption here.
   */
  private requestGenerate(): void {
    if (this.pipelineBusy()) return;

    const count = this.chapters().length;
    if (count >= CHAPTERS_EXPORT_MINIMUM) {
      this.startGenerate();
      return;
    }

    this.alertModal.set({
      title: count === 0 ? 'No chapters marked' : 'Only one chapter marked',
      message:
        (count === 0
          ? 'This book has no chapter markers, so the audiobook will be one continuous file with nothing to skip between.'
          : 'This book has a single chapter, so the audiobook will be one continuous file with nothing to skip between.') +
        '\n\nOpen Chapters in the left rail to mark where each chapter begins — most books detect automatically.',
      type: 'warning',
      confirmText: 'Go to Chapters',
      cancelText: 'Export anyway',
      // The modal closes itself around these (see onAlertConfirm/onAlertCancel).
      onConfirm: () => this.onRailPanelClick('chapters'),
      onCancel: () => this.startGenerate(),
    });
  }

  /** Consolidate fragmented blocks, then export and show the review. */
  private startGenerate(): void {
    this.autoMergeForPipeline();
    this.pipelineExportAndReview();
  }

  /**
   * Navigate to a station (chip clicks + primary/back route through here).
   * Leaving the read-only review reloads the source, because review never edits.
   */
  goToStation(targetId: string): void {
    const target = targetId as PipelineStep;
    if (this.pipelineBusy()) return;
    const current = this.pipelineStep();
    if (target === current) return;

    if (current === 'epub-review') {
      this.pipelineReloadSource('select');
      return;
    }

    // Into review = generate the EPUB, under the same chapter check as the
    // primary button: a chip is another way to press it, not a way around it.
    if (target === 'epub-review') {
      this.requestGenerate();
    }
  }

  /** Set panel + step for the editing station and update visited/staleness. */
  private enterStation(target: PipelineStep): void {
    this.activatePanel(null);
    this.viewerInteraction.set('select');
    this.pipelineStep.set(target);
    if (target === 'select') this.reviewExportWasPreserving = false;
    this.visitedStations.update(s => {
      const next = new Set(s);
      next.add(target);
      // Returning to editing invalidates any previously generated review.
      if (target === 'select') next.delete('epub-review');
      return next;
    });
  }

  /**
   * Silent, paragraph-aware merge run just before the EPUB is generated. No
   * dialog — for a clean EPUB (already segmented at ingestion) it finds nothing
   * and no-ops; for a fragmented PDF it consolidates single-line blocks into one
   * block per paragraph.
   *
   * Blocks bound to a chapter marker are left out of every group. The export
   * suppresses a chapter's title in the body by matching the marker's block id,
   * so folding that block into a merged paragraph (which gets a NEW id) would
   * make the title lose its binding and be voiced twice — once as the heading,
   * once inside the paragraph that swallowed it. Chapters are marked before
   * this runs now that Chapters is a rail task rather than a station, so the
   * ordering that used to make this impossible is gone.
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

    const chapterBlockIds = new Set<string>();
    for (const ch of this.chapters()) {
      if (ch.blockId) chapterBlockIds.add(ch.blockId);
      for (const id of ch.mergedBlockIds ?? []) chapterBlockIds.add(id);
    }

    // Drop the whole group rather than the offending block: the remaining lines
    // are a title's neighbours, and re-merging around a removed member would
    // join text across the heading it sits under.
    const safe = chapterBlockIds.size === 0
      ? groups
      : groups.filter(g => !g.blockIds.some(id => chapterBlockIds.has(id)));

    const held = groups.length - safe.length;
    if (held > 0) {
      console.log(`[autoMergeForPipeline] Left ${held} group(s) unmerged — they contain chapter-title blocks`);
    }
    if (safe.length === 0) return;
    console.log(`[autoMergeForPipeline] Consolidating into ${safe.length} paragraphs`);
    this.applyMergeGroups(safe);
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

      // How the review EPUB was produced. At the review station the loaded file
      // is always an EPUB, so useEpubPreservingExport() can no longer tell a
      // preserved book from a PDF's rebuilt one — pipelineComplete needs this.
      const preserving = this.useEpubPreservingExport();
      this.reviewExportWasPreserving = preserving;

      // Pipeline always exports to exported.epub (the canonical finalized location)
      const pBreaks = this.editorState.paragraphBreaks();
      const result = preserving
        ? await this.runEpubPreservingExport(projectPath, null)
        : await this.exportService.exportToAudiobook(
            this.blocks(),
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
   * Leave the read-only review and reload the source project back at the
   * editing station. The review shows the generated EPUB; edits only ever
   * happen on the source, so we reload it here.
   */
  private async pipelineReloadSource(target: 'select'): Promise<void> {
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

    // A preserved EPUB is already finished. saveToEpub() below rebuilds the file
    // from block text, which is right for a PDF's exported.epub but would flatten
    // every <sup>, <em> and list this export just carried over from the source —
    // so on this path the review really is read-only, and edits made in it have
    // nowhere to go. Say so rather than silently discarding them.
    if (this.reviewExportWasPreserving) {
      if (this.hasUnsavedChanges()) {
        this.showAlert({
          title: 'Changes Not Saved',
          message: 'Review is read-only for an EPUB source. Go back to edit the book, then export again.',
          type: 'warning'
        });
        return;
      }

      this.pipelineStep.set('select');
      this.visitedStations.set(new Set<PipelineStep>(['select']));
      this.reviewExportWasPreserving = false;
      this.finalized.emit({ success: true, epubPath });
      this.showAlert({
        title: 'Complete',
        message: 'EPUB exported with the source book\'s markup preserved.',
        type: 'success'
      });
      return;
    }

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
  /**
   * The last line of defence for corpus isolation.
   *
   * Every entry point that could put a corpus book into {library}/projects/ ends
   * up in one of the project writers below, so each of them asks here first.
   * Loud rather than silent: reaching one of these means a new code path found
   * its way past the gates upstream, and that is a bug worth seeing.
   */
  private refuseProjectWriteForCorpus(what: string): boolean {
    if (!this.corpusMode()) return false;
    console.error(
      `[corpus] Refused "${what}": a training-corpus book must never become a library project. ` +
      'Its labels are saved to its own folder under ~/Documents/BookForge/training/.'
    );
    return true;
  }

  private async autoCreateProject(pdfPath: string, pdfName: string): Promise<void> {
    if (this.refuseProjectWriteForCorpus('Create project')) return;

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
   *
   * The project is bound by whatever signal found it — a hash match, the project
   * directory containing the file, or a filename coincidence — and only the first of
   * those proves the file is the one the edits were made against. So the edits are
   * verified here before being applied, exactly as loadProjectFromPath verifies them.
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

    // Do this project's saved edits belong to the document that is loaded?
    //
    // Only content can answer that here. loadProjectFromPath resolves the source
    // file itself, so it can compare paths (isLoadingOriginal); this function is
    // reached from loadPdf, which hands the analyzer the LIBRARY COPY of whatever
    // the user opened (library:import-file, deduplicated by hash). That path is
    // never the project's own archive/ or source/ path, so a path comparison would
    // report a mismatch for every manifest project — including every correct one.
    // The hashes compare the bytes instead, which is the currency both sides share —
    // except for a converted source, where they cannot agree (see below).
    const mismatchReason = this.projectEditsMismatchReason(
      project, this.requireAnalyzedSourceSha256());
    if (mismatchReason) {
      console.warn(`[restoreProjectState] Not applying ${projectFilePath}'s saved edits: ${mismatchReason}`);

      // Bound but read-only: exports and the pipeline still need the binding
      // (projectPath is set above), and the document keeps the state it was loaded
      // with — the session's own work is never cleared here, since this also runs
      // when an unbound edit triggers autoCreateProject mid-session. The tab keeps
      // the flag the way it keeps every other per-document field, through
      // saveCurrentDocumentState/restoreDocumentState.
      this.projectStateNotApplied.set(true);

      // Any save already queued would write this session's edit set over the
      // project's — cancel it. Deliberately no markSaved(): the session may hold
      // real unsaved changes, and they simply have nowhere to go.
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
      }

      // Chapters from the loaded file's OWN outline are legitimate — they describe
      // the file in front of the user, not the project's edits. loadPdf extracts
      // them for a freshly opened EPUB right after this returns; this covers the
      // mid-session binding, where nothing else will.
      if (this.chapters().length === 0 && this.effectivePath()?.toLowerCase().endsWith('.epub')) {
        this.tryLoadOutline();
      }

      this.showAlert({
        title: 'Project Edits Not Loaded',
        message: this.PROJECT_STATE_NOT_APPLIED_MESSAGE,
        type: 'warning',
      });
      return;
    }

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
        this.editorState.categories.set(normalizeCategories(project.ocr_categories));
        this.migrateDisabledCategoriesToDeletions(
          project.ocr_categories as unknown as Record<string, unknown>);
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
      this.applyCorrectionsWithCategories();
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
    // A corpus book has no project to save into, and autosave is the path that
    // would CREATE one (performAutoSave → autoCreateProject → import into the
    // library). Labels are written explicitly to the corpus folder instead.
    if (this.corpusMode()) return;

    // A session that declined to load the project's edits must not autosave over
    // them — see projectStateNotApplied. Silent by design: the user was told once,
    // with an alert, when the document was bound.
    if (this.projectStateNotApplied()) {
      console.warn('[scheduleAutoSave] Suppressed: the project\'s saved edits were not loaded into this document.');
      return;
    }

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
    if (this.corpusMode()) return;   // see scheduleAutoSave

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
    if (this.refuseProjectWriteForCorpus('Save project')) return;

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
    if (this.refuseProjectWriteForCorpus('Save project as')) return;

    // Save As is not a way around the refusal above: projects:save matches an
    // existing .bfp by hash / library path / source path and overwrites it, so this
    // would clobber the very edits this session declined to load.
    if (this.projectStateNotApplied()) {
      this.showAlert({
        title: 'Project Not Saved',
        message: this.PROJECT_STATE_NOT_APPLIED_MESSAGE,
        type: 'warning',
      });
      return;
    }

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
      source_file_sha256: this.requireAnalyzedSourceSha256(),
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
    if (this.refuseProjectWriteForCorpus(`Write project state to ${filePath}`)) return;

    // The one place every project-state write goes through, so the one place that
    // can guarantee a session which declined to load the project's edits cannot
    // overwrite them (see projectStateNotApplied). Callers that export as well as
    // save — finalizeProject, pipelineExportAndReview — still export: the export
    // describes the file in front of the user, only the project write is refused.
    if (this.projectStateNotApplied()) {
      console.error(
        `[saveProjectToPath] REFUSED ${filePath}: the project's saved edits were not loaded `
        + `into this document, so saving would replace them with this session's empty set.`,
      );
      if (!silent) {
        this.showAlert({
          title: 'Project Not Saved',
          message: this.PROJECT_STATE_NOT_APPLIED_MESSAGE,
          type: 'warning',
        });
      }
      return;
    }

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
      source_file_sha256: this.requireAnalyzedSourceSha256(),
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
            // Persist full child data only for text-mode splits, which have no
            // spans to rebuild from on reload. Span-based splits stay lean.
            textMode: s.textMode || undefined,
            childBlocks: s.textMode ? s.childBlocks : undefined,
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
      this.analyzedSourceSha256.set(quickResult.sourceSha256);

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
          this.applyCorrectionsWithCategories();
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
            this.applyCorrectionsWithCategories();
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

      this.analyzedSourceSha256.set(quickResult.sourceSha256);

      // Do the saved edits actually belong to the file we just analyzed? Same
      // question, same shared answer as restoreProjectState — see
      // projectEditsMismatchReason for why the second signal is suppressed here.
      const sourceChanged = !!this.projectEditsMismatchReason(
        project, quickResult.sourceSha256);
      if (sourceChanged) {
        console.warn('[loadProjectFromPath] Saved edits belong to a different file — not applying.',
          'saved:', project.source_file_sha256, 'analyzed:', quickResult.sourceSha256, 'file:', pdfPathToLoad);
        // Bound but read-only from here on: the edits were not loaded, so this
        // session must not save over them either (see projectStateNotApplied).
        this.showAlert({
          title: 'Edits Not Applied',
          message: this.PROJECT_STATE_NOT_APPLIED_MESSAGE,
          type: 'warning'
        });
      }
      // Deliberately NOT set for the !isLoadingOriginal case below. Opening a
      // derived version from the version picker is a choice the user made about a
      // file they can still legitimately save chapters and metadata for (the
      // embedded editor's finalize-a-variant flow depends on it); a hash that
      // disagrees is proof of a different file, and only proof locks the project.
      this.projectStateNotApplied.set(sourceChanged);
      const applySavedEdits = isLoadingOriginal && !sourceChanged;

      const deletedBlockIds = applySavedEdits
        ? new Set<string>(project.deleted_block_ids || [])
        : new Set<string>();
      const deletedPages = applySavedEdits
        ? new Set<number>(project.deleted_pages || [])
        : new Set<number>();
      const pageOrder = applySavedEdits ? (project.page_order || []) : [];
      // Crop is an original-only concern (derived versions already have the crop
      // baked into their blocks), mirroring deletedBlockIds' gating.
      const cropRegions = applySavedEdits
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
        categoryCorrections: applySavedEdits && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined,
        learnedCategories: applySavedEdits && project.learned_categories?.length
          ? new Map(project.learned_categories) : undefined,
        paragraphBreaks: applySavedEdits && project.paragraph_breaks?.length
          ? new Set(project.paragraph_breaks) : undefined,
        createdAt: project.created_at || undefined,
        sourceSha256: quickResult.sourceSha256,
        projectStateNotApplied: sourceChanged,
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
      if (applySavedEdits) {
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
        paragraphBreaks: applySavedEdits && project.paragraph_breaks?.length
          ? new Set(project.paragraph_breaks) : undefined,
        categoryCorrections: applySavedEdits && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined,
        learnedCategories: applySavedEdits && project.learned_categories?.length
          ? new Map(project.learned_categories) : undefined,
        // cropRegions is display + reversal metadata; it doesn't depend on
        // blocks being present, so it can be set even before text is ready
        // (updateTextData preserves it). Deletions are applied via deletedBlockIds.
        cropRegions,
      });

      // Restore undo/redo history from project (loadDocument clears it)
      // Only load history when loading the original - it's not relevant for exported versions
      if (applySavedEdits && (project.undo_stack || project.redo_stack)) {
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
      if (applySavedEdits && project.deleted_highlight_ids && project.deleted_highlight_ids.length > 0) {
        this.deletedHighlightIds.set(new Set(project.deleted_highlight_ids));
      }

      // Restore chapters - for non-original EPUBs, always extract from the file's TOC
      // since the exported version has its own structure
      if (applySavedEdits && project.chapters && project.chapters.length > 0) {
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
      if (quickResult.textReady && applySavedEdits && project.ocr_blocks && project.ocr_blocks.length > 0) {
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
          this.editorState.categories.set(normalizeCategories(project.ocr_categories));
          this.migrateDisabledCategoriesToDeletions(
            project.ocr_categories as unknown as Record<string, unknown>);
        }
      }

      // Restore remove backgrounds state - only for original source file
      if (applySavedEdits && project.remove_backgrounds) {
        this.editorState.removeBackgrounds.set(true);
      }

      // Restore paragraph breaks
      if (applySavedEdits && project.paragraph_breaks && project.paragraph_breaks.length > 0) {
        this.editorState.paragraphBreaks.set(new Set(project.paragraph_breaks));
      }

      // Restore category corrections and apply them to blocks (AFTER all block mutations)
      if (applySavedEdits && project.category_corrections && project.category_corrections.length > 0) {
        this.editorState.categoryCorrections.set(new Map(project.category_corrections));
        if (quickResult.textReady) {
          this.applyCorrectionsWithCategories();
        }
      }

      // Restore block splits: re-fetch spans and rebuild child blocks
      if (applySavedEdits && quickResult.textReady && project.block_splits && project.block_splits.length > 0) {
        await this.restoreBlockSplits(project.block_splits);
      }

      // Restore block merges: find source blocks and rebuild merged blocks
      if (applySavedEdits && quickResult.textReady && project.block_merges && project.block_merges.length > 0) {
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
      if (applySavedEdits && project.classification_thresholds) {
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
        const pendingOcrBlocks = applySavedEdits ? project.ocr_blocks : undefined;
        const pendingOcrCategories = applySavedEdits ? project.ocr_categories : undefined;
        const pendingCategoryCorrections = applySavedEdits && project.category_corrections?.length
          ? new Map(project.category_corrections) : undefined;
        const pendingBlockSplits = applySavedEdits ? project.block_splits : undefined;
        const pendingBlockMerges = applySavedEdits ? project.block_merges : undefined;

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
                this.editorState.categories.set(normalizeCategories(pendingOcrCategories));
              }
            }

            // Apply category corrections AFTER all block mutations
            if (pendingCategoryCorrections && pendingCategoryCorrections.size > 0) {
              this.applyCorrectionsWithCategories();
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

          // Archived labels can only be matched once the blocks they key to
          // exist, which for a PDF is here rather than at the end of the load.
          if (this.activeDocumentId() === docId) {
            await this.importTrainingLabelsOnce();
            await this.refreshLabelSnapshotState();
          }

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

      // A book labelled before labels became project state keeps that work in
      // an archived session. Bring it in when this project has none of its own;
      // the archive itself is only ever read.
      await this.importTrainingLabelsOnce();
      await this.refreshLabelSnapshotState();
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
      // Parse specific pages string like "1, 3, 10-15, 42" (shared util:
      // 0-indexed, clamped to [1, totalPages], sorted, deduped).
      const allowedPages = new Set(parsePageRange(specificPagesStr, this.totalPages()));
      return matches.filter(m => allowedPages.has(m.page));
    }

    return matches;
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

    // Editing reuses the id, so a category hidden before the edit would stay
    // hidden after it — the user changes the regex, the match count updates, and
    // not one highlight appears. The old `enabled: true` in the rewritten record
    // reset this implicitly; now it has to be said.
    this.hiddenCategoryIds.update(hidden => {
      if (!hidden.has(catId)) return hidden;
      const next = new Set(hidden);
      next.delete(catId);
      return next;
    });

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

    // ...and from the hidden set, or the id accumulates for the life of the
    // component and a later category reusing it would open invisible.
    this.hiddenCategoryIds.update(hidden => {
      if (!hidden.has(categoryId)) return hidden;
      const next = new Set(hidden);
      next.delete(categoryId);
      return next;
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

    // Entering detect: ask Ollama what it currently holds, so the picker shows
    // models that exist rather than a name typed from memory.
    if (id === 'detect' && previous !== 'detect') {
      void this.refreshDetectModels();
    }

    // Entering label: labelling is driven by selecting blocks and pressing a
    // category key, which the edit pointer cannot do.
    if (id === 'label' && previous !== 'label') {
      this.viewerInteraction.set('select');
      // Predictions waiting from a Detect run become the starting point, because
      // going to Label mode right after a run means exactly one thing: correct
      // what the model said. `adoptDetectPredictions` still confirms and
      // snapshots first when the book already carries labels, so arriving here
      // can never silently overwrite hand-labelling.
      if (this.detectPredictions().size > 0) void this.adoptDetectPredictions(true);
    }

    // Entering split: auto-enable splitting and reset the preview page.
    if (id === 'split' && previous !== 'split') {
      this.splitConfig.update(config => ({ ...config, enabled: true }));
      this.splitPreviewPage.set(0);
    }

    // Entering chapters: consolidate fragmented line-blocks first, then try to
    // auto-load the outline on first entry.
    //
    // The merge is what the old "Next → Mark chapters" step ran on the way in,
    // and detection depends on it: on a fragmented scan a title split across
    // two line-blocks reads as one title only after they are merged. Now that
    // Chapters is a rail task rather than a station, entering it is the moment
    // that ordering has to be preserved.
    if (id === 'chapters' && previous !== 'chapters') {
      this.autoMergeForPipeline();
      if (this.chapters().length === 0) {
        this.tryLoadOutline();
      }
    }

    this.activePanel.set(id);
  }

  /**
   * Rail click. The rail carries both the modes and the tasks, so this is the
   * one entry point for "the user chose a mode" and "the user opened a task".
   *
   * Modes are not toggles: clicking the current mode again leaves it selected,
   * because there is no such thing as being in no mode. Tasks keep their toggle
   * behaviour (clicking the open task closes its panel).
   */
  onRailPanelClick(id: PanelId): void {
    // A disabled task stays disabled no matter how it's invoked. OCR is
    // disabled for EPUBs (they carry a real text layer; OCR-ing their rendered
    // pages produces nonsense blocks) — and it still ran on one, because this
    // bypass used to sit in front of the check.
    if (this.disabledTasks().has(id as TaskId)) return;

    // Pointer modes own no panel: choosing one closes whatever panel had taken
    // over the pointer, so the click does what it looks like it does.
    if (id === 'select' || id === 'edit') {
      this.viewerInteraction.set(id);
      this.activatePanel(null);
      return;
    }

    // OCR has no state worth parking in a side panel — the panel existed only
    // to host a "Run OCR…" button. Open the settings modal straight from the
    // rail instead of making the user cross the window to reach it.
    if (id === 'ocr') {
      this.showOcrSettings.set(true);
      return;
    }

    if (id === 'crop' || id === 'label') {
      this.activatePanel(id);
      return;
    }

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
        // TOC-mapped markers are FREE synthetic headers: they render at the
        // matched heading position but do NOT auto-bind/absorb the printed title
        // block. TOC matching is fuzzy and can land on the wrong block, so silently
        // occluding/excluding one is unsafe — instead the user sees the duplicate
        // printed title on screen and deletes or absorbs it manually. Strip any
        // block binding the mapper returned.
        const freeToc = result.chapters.map(d => ({
          ...d,
          blockId: undefined,
          mergedBlockIds: undefined,
        }));

        // Filter out duplicates by page proximity
        const newChapters = freeToc.filter(d =>
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
   * True when a chapter title is still an auto-generated placeholder ("Chapter 3",
   * "Section 2", or empty) rather than something the user typed. Used to decide
   * whether a drag-absorb may seed the title from the absorbed block's text.
   */
  private isDefaultChapterTitle(title: string | undefined): boolean {
    const t = (title || '').trim();
    return t === '' || /^(Chapter|Section)\s+\d+$/.test(t);
  }

  /**
   * Handle chapter marker drag - update chapter position
   */
  onChapterDrag(event: { chapterId: string; pageNum: number; y: number; snapToBlock?: TextBlock }): void {
    this.chapters.update(chapters =>
      chapters.map(ch => {
        if (ch.id !== event.chapterId) return ch;

        if (event.snapToBlock) {
          // Dropped directly on a block — absorb it as the heading. Seed the title
          // from the block's text ONLY when the current title is still an
          // auto-generated default ("Chapter N" / "Section N" / empty); a title the
          // user actually typed is never overwritten by a drag.
          const blockText = event.snapToBlock.text.trim().substring(0, 80);
          return {
            ...ch,
            page: event.pageNum,
            y: event.snapToBlock.y,
            blockId: event.snapToBlock.id,
            mergedBlockIds: undefined,  // single-block absorb; drop any prior merge
            title: (this.isDefaultChapterTitle(ch.title) && blockText) ? blockText : ch.title,
          };
        }

        // Free placement (empty space, or Alt-forced). Release any previously
        // absorbed block(s) — clearing blockId/mergedBlockIds restores them to the
        // body via the viewer's anchorBlockIds recompute — and keep the title.
        return {
          ...ch,
          page: event.pageNum,
          y: event.y,
          blockId: undefined,
          mergedBlockIds: undefined,
        };
      }).sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return (a.y || 0) - (b.y || 0);
      })
    );

    this.editorState.markChanged();
  }

  // OCR methods
  /**
   * Supply a page image to OCR, rendering it if it isn't already.
   *
   * Pages render lazily as you scroll, so `pageImages` only holds what you
   * have actually looked at. OCR over a whole book used to ask for pages that
   * had never been rendered, get null for every one, skip them all, and finish
   * instantly having done nothing — which reads as "the button did nothing".
   */
  async getPageImageForOcr(pageNum: number): Promise<string | null> {
    // Lightweight mode has no renderer attached — OCR routes to the headless path.
    if (this.lightweightMode()) return null;

    // Render at a FIXED resolution, and never reuse the display cache.
    //
    // The display scale is adaptive by page count (1.5 over 500 pages, 2.0 over
    // 200, else 2.5 — i.e. 108, 144 or 180 dpi) because display rendering trades
    // resolution for memory. Feeding that to OCR made a book's OCR resolution
    // depend on its LENGTH, and — because a scrolled page was served from the
    // display cache — on which pages you happened to look at.
    //
    // Both matter beyond image quality. Tesseract's paragraph grouping shifts
    // with resolution, and the whole training corpus was OCR'd at 200 dpi, so
    // anything else produces blocks that do not correspond to the labels or to
    // what the model was trained on. Measured: identical settings at 200 dpi
    // reproduce an archived session's blocks exactly, 206/206 bbox and text.
    try {
      const rendered = await this.electronService.renderPage(pageNum, OCR_RENDER_SCALE);
      if (rendered) return rendered;
      console.warn(`getPageImageForOcr(${pageNum}): render produced no image`);
    } catch (err) {
      console.error(`getPageImageForOcr(${pageNum}): render failed`, err);
    }
    return null;
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

    const pageDims = this.pageDimensions();

    // Recognized lines → categorized paragraph blocks, in ONE shared call.
    //
    // Building the per-line blocks used to happen here, inline: ~120 lines that
    // converted each OCR box to page points, estimated a font size, guessed a
    // region, and assigned a placeholder category — every one of which the
    // post-processor then discarded and recomputed. The CLI could not reach any of
    // it, so `cli/ocr-pdf.js` grouped Tesseract's own paragraphs instead and
    // produced a DIFFERENT segmentation for the same page. Both callers now enter
    // at `processOcrPageResults`, so the blocks the CLI writes into a manifest are
    // the blocks this picker would have produced, down to the id shape the hand
    // labels are keyed to.
    //
    // The pixel→point conversion moved with it, and that fixed a live bug: this
    // code divided OCR boxes by a scale derived from the document's PAGE COUNT
    // (1.5 / 2.0 / 2.5), left over from when OCR reused the display raster. OCR has
    // rendered at OCR_RENDER_SCALE (2.78) since, so every OCR block's geometry was
    // inflated by up to 1.85x — which moved `y / pageHeight` and with it every
    // footnote, footer and caption verdict.
    const processedResult = this.ocrPostProcessor.processOcrPageResults(results, pageDims);
    const pagesWithOcrResults = processedResult.pages;
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
    this.editorState.categories.set(normalizeCategories(mergedCategories));

    // Only replace blocks on pages that have OCR results
    // Pages with no OCR results keep their existing blocks
    if (pagesWithOcrResults.length > 0) {
      // OCR mints brand-new block IDs, so any hand-set category on a replaced
      // page now points at a block that no longer exists. Drop those instead of
      // leaving them: an orphaned correction can never re-apply, but it would
      // still be counted as a label and written into training data as one.
      const replacedPages = new Set(pagesWithOcrResults);
      const orphaned = this.blocks()
        .filter(b => replacedPages.has(b.page) && !b.is_image)
        .map(b => b.id)
        .filter(id => this.editorState.categoryCorrections().has(id));
      if (orphaned.length > 0) {
        this.editorState.categoryCorrections.update(map => {
          const next = new Map(map);
          for (const id of orphaned) next.delete(id);
          return next;
        });
        console.warn(`[OCR] Dropped ${orphaned.length} label(s) on re-OCR'd pages — their blocks were replaced.`);
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

      // Note: OCR fill regions (white backgrounds behind OCR text) are rendered as
      // SVG overlays in the pdf-viewer, not baked into the page image. This allows
      // toggling OCR text off to reveal the original scanned page underneath.
    }

    // Update category stats
    this.editorState.updateCategoryStats();

    // Update the open document's blocks
    this.saveCurrentDocumentState();

    // A corpus book has no project and no autosave, so nothing else in this
    // method's wake will write these blocks anywhere. `persistCorpusOcr` is the
    // whole of persistence for them; it is fired here, after the blocks are on
    // screen, so that what gets written is exactly what the user is looking at.
    if (this.corpusMode()) {
      void this.persistCorpusOcr(processedBlocks);
    }

    // Log results for debugging
    if (processedBlocks.length > 0) {
    } else {
    }
  }

  /**
   * Write an OCR pass into the corpus book's own blocks.json.
   *
   * THE ONLY thing that persists OCR for a corpus book. The project autosave is
   * refused in corpus mode (`refuseProjectWriteForCorpus` — there is no project
   * to save into, and minting one is the thing corpus mode exists to prevent),
   * so a failure here that says nothing means the user's OCR pass is gone the
   * moment the window closes, with nothing on screen having hinted at it. Every
   * outcome therefore ends in a dialog, success included: "did that save?" is
   * the question this whole path exists to answer.
   *
   * One refusal is not an error but a decision. Re-OCR mints new block ids
   * (`ocr_p3_k2x9f1_17` — the suffix is per run), so on a book that already
   * carries hand labels it does not move them onto the new blocks, it orphans
   * every one. Only the user can weigh that, so it is put to them in as many
   * words — including that the old labels are MOVED ASIDE to
   * labels.orphaned-<timestamp>.json rather than deleted — and retried with
   * `force` only if they say yes.
   *
   * The rail already refuses OCR on a labelled book, so that refusal should not
   * normally be reachable. "Should not" is why it is handled: OCR also arrives
   * here from the job service and the headless path, and a pass that has ALREADY
   * RUN is far too late to start discarding.
   */
  private async persistCorpusOcr(blocks: TextBlock[]): Promise<void> {
    const book = this.corpusBook();
    if (!book) {
      // corpusMode() is true (it is derived from the input path) and yet no book
      // is loaded, so the pass that just ran has nowhere to go. Loud, because the
      // alternative is losing it in silence.
      this.showAlert({
        title: 'OCR was not saved',
        message:
          'This window is in corpus mode but no training book is loaded, so there is no blocks.json '
          + 'to write to. The OCR on screen has not been saved anywhere. Re-open the book from the '
          + 'Training tab and run it again.',
        type: 'error',
      });
      return;
    }

    const input = {
      blocks,
      pageDimensions: this.pageDimensions(),
      // The file the pages on screen came from, as main resolved it — not
      // whatever path the editor happens to consider "current".
      sourceFile: book.pdfPath,
      ocrEngine: this.ocrSettings().engine,
    };

    let result = await this.electronService.trainingSaveBlocks(book.dir, input);

    if (!result.success && this.isCorpusOrphanRefusal(result.error)) {
      const choice = await this.electronService.showConfirmDialog({
        title: 'This book already has hand labels',
        message:
          'Saving this OCR pass replaces the blocks those labels point at. Block ids are minted '
          + 'per OCR run, so none of the existing labels will match the new blocks — they cannot '
          + 'be carried over.',
        detail:
          'The existing labels.json is MOVED ASIDE to labels.orphaned-<timestamp>.json in the '
          + 'book\'s folder, not deleted, so the work is still there to read. The book itself '
          + 'goes back to having no labels and has to be labelled again from the new blocks.\n\n'
          + `${book.dir}`,
        confirmLabel: 'Save OCR and orphan the labels',
        cancelLabel: 'Keep the labels — discard this OCR',
        type: 'warning',
      });
      if (!choice.confirmed) {
        this.showAlert({
          title: 'OCR was not saved',
          message:
            'The existing labels were kept, so this OCR pass was not written. The blocks on screen '
            + 'are not saved anywhere — close the book without saving to get its recorded blocks '
            + 'back.',
        });
        return;
      }
      result = await this.electronService.trainingSaveBlocks(book.dir, input, { force: true });
    }

    if (!result.success || !result.result) {
      this.showAlert({
        title: 'OCR was not saved',
        message:
          (result.error || `Writing blocks.json under ${book.dir} failed.`)
          + '\n\nNothing was written, and corpus books are not autosaved, so the OCR on screen '
          + 'exists only in this window.',
        type: 'error',
      });
      return;
    }

    const { path: written, blocks: count, orphanedLabels } = result.result;

    // The book has moved from 'added' to 'ocr' (or been re-OCR'd). Re-read it
    // from main rather than patching the signal by hand: `from`, `labelled` and
    // the snapshot are all derived from what is on disk, and a locally invented
    // CorpusBookInfo would be this renderer's opinion of a file main owns. The
    // editor is NOT re-pinned to the re-read snapshot — it is the same block set
    // that was just written, and replacing it would throw away the selection and
    // the categories for nothing.
    let staleBanner: string | null = null;
    const reloaded = await this.electronService.corpusLoad(book.dir);
    if (reloaded.success && reloaded.book) {
      this.corpusBook.set(reloaded.book);
      if (orphanedLabels) {
        // Forced write: labels.json is gone from under the editor, so the
        // corrections still in it are no longer backed by anything on disk.
        this.editorState.categoryCorrections.set(new Map());
        this.editorState.categoryConfidence.set(new Map());
      }
    } else {
      staleBanner = reloaded.error || 'the book could not be re-read';
      console.error('[corpus] blocks.json was written but the book could not be re-read:', staleBanner);
    }

    // Everything on screen is now on disk, so the unsaved-changes indicator has
    // nothing left to be about — unless labels are open in the editor, which
    // only blocks.json's write does not cover.
    if (this.editorState.categoryCorrections().size === 0) {
      this.editorState.markSaved();
    }

    this.showAlert({
      title: 'OCR saved to the training corpus',
      message:
        `${count.toLocaleString()} blocks written to ${written}.`
        + (orphanedLabels ? `\n\nThe previous labels were moved to ${orphanedLabels}.` : '')
        + (staleBanner
          ? `\n\nThe write succeeded, but re-reading the book afterwards failed (${staleBanner}), `
            + 'so the banner above may be out of date until you re-open it.'
          : ''),
      type: 'success',
    });
  }

  /**
   * Is this the backend's "already carries hand labels" refusal?
   *
   * Matched on the message because the API returns a string and nothing else —
   * see `saveTrainingBlocks` in electron/corpus-book.ts, which is the only
   * producer of it. A miss here degrades to showing the error as-is, which is
   * the correct outcome for every OTHER failure anyway; it can never degrade
   * into forcing a write the user was not asked about.
   */
  private isCorpusOrphanRefusal(error: string | undefined): boolean {
    return /already carries \d+ hand labels/.test(error ?? '');
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

      const outcome = await this.runHeadlessOcr(engine, language, pages);
      if (outcome.ok) {
        this.showAlert({
          title: 'OCR Complete',
          message: `Successfully processed ${outcome.pages} pages with ${engine}`,
          type: 'success'
        });
      } else {
        this.showAlert({ title: 'OCR Failed', message: outcome.error, type: 'error' });
      }

      return; // Don't continue with regular job processing
    }

    // Regular OCR job (non-lightweight mode)
    // The job will continue running and call onOcrCompleted when done
    // via the completion callback registered in the OcrJobService
  }

  /**
   * OCR the whole PDF in the main process and apply the result, resolving only
   * once the blocks are in the document.
   *
   * Reports its outcome instead of alerting, because it has two callers that
   * want to say different things: the OCR modal announces the run it started,
   * while the import-time chain has a second stage to get to and must not stop
   * on a dialog nobody is sitting in front of.
   */
  private async runHeadlessOcr(
    engine: string,
    language: string,
    pages: number[],
  ): Promise<{ ok: true; pages: number } | { ok: false; error: string }> {
    this.loading.set(true);
    this.loadingText.set(`Initializing OCR for ${pages.length} pages...`);

    const unsubscribe = this.electronService.onHeadlessOcrProgress((data) => {
      this.loadingText.set(`Processing OCR: ${data.current}/${data.total} pages`);
    });

    try {
      const results = await this.electronService.ocrProcessPdfHeadless(
        this.effectivePath(),
        { engine, language, pages }
      );

      if (!results || results.length === 0) {
        return { ok: false, error: 'No text was detected in the document' };
      }

      this.onOcrCompleted({
        results: results.map(r => ({
          page: r.page,
          text: r.text,
          confidence: r.confidence,
          textLines: r.textLines,
        })),
      });
      return { ok: true, pages: results.length };
    } catch (err) {
      console.error('[OCR] Headless OCR failed:', err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error during OCR processing',
      };
    } finally {
      unsubscribe();
      this.loading.set(false);
    }
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
    // A corpus book has no autosave, so closing is the one moment label edits
    // can be lost. Ask, rather than discarding them the way every other document
    // gets away with because a timer already wrote it.
    if (this.corpusMode() && this.hasUnsavedChanges()) {
      void this.confirmCloseCorpusBook();
      return;
    }

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
            sourceSha256: this.analyzedSourceSha256() ?? undefined,
            projectStateNotApplied: this.projectStateNotApplied(),
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
    this.analyzedSourceSha256.set(doc.sourceSha256 ?? null);
    // Whether THIS tab is allowed to save project state travels with the tab.
    this.projectStateNotApplied.set(doc.projectStateNotApplied === true);

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
    // Per-document, like the category record that used to carry it. Without this
    // the set is global to the component, which outlives the document.
    this.hiddenCategoryIds.set(new Set());
    this.projectStateNotApplied.set(false);  // no document, nothing declined
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

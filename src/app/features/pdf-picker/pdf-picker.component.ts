import { Component, inject, signal, computed, untracked, HostListener, ViewChild, ElementRef, effect, DestroyRef, ChangeDetectionStrategy, input, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService, Chapter, TocLine, EpubExportBlock, EpubExportChapter, EpubPreservingEdits, CorpusBookInfo, CorpusFileChanged, CorpusOcrRunState } from '../../core/services/electron.service';
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
import { DocumentBlocksService } from './services/document-blocks.service';
import {
  DOCUMENT_STAGE_LABELS,
  DocumentNavComponent,
  DocumentNavTab,
} from './components/document-nav/document-nav.component';
import type { DocumentRef, ResetTarget } from '@shared/document/pipeline-types';
import { PdfViewerComponent, CropRect } from './components/pdf-viewer/pdf-viewer.component';
import { AnalysisPanelComponent } from './components/analysis-panel/analysis-panel.component';
import { MergePanelComponent } from './components/merge-panel/merge-panel.component';
import { RegexCriteria, defaultRegexCriteria } from './components/regex-category-builder/regex-category-builder.component';
import { FilePickerComponent } from './components/file-picker/file-picker.component';
import { CropPanelComponent } from './components/crop-panel/crop-panel.component';
import { StationBarComponent, StationTab, StationAction } from './components/station-bar/station-bar.component';
import {
  PassOptionsModalComponent,
  type PassAiChoice,
  type PassOptionsKind,
  type PassOptionsResult,
} from './components/pass-options-modal/pass-options-modal.component';
import {
  STATIONS,
  STATION_LABELS,
  existingStations,
  nextStation,
  stationPresence,
  type BookDocuments,
  type StationId,
} from '@shared/document/stations';
import { decideArrival } from '@shared/document/arrival';
import type { DocumentClass } from '@shared/document/pipeline-types';
import type { ChainPassRequest } from '@shared/processing/pass-types';
import { QueueService } from '../queue/services/queue.service';
import { SettingsService } from '../../core/services/settings.service';
import { computeBaselines, learnFromBreaks, detectParagraphBreaks, getDefaultConfig, type DetectionConfig } from './services/paragraph-detector';
import { recategorize as recategorizeBlocksFromLearner, classifyBlockHeuristic, computeBaselines as computeCategoryBaselines, isDefaultThresholds, detectMergeableGroups, createMergedBlock, type BlockAssignment, type CategoryBaselines, type ClassificationThresholds, type MergeGroup } from './services/category-learner';
import { TrainingExportService } from './services/training-export.service';
import { TabBarComponent, DocumentTab } from './components/tab-bar/tab-bar.component';
import { OcrSettingsModalComponent, OcrSettings, OcrPageResult, OcrCompletionEvent } from './components/ocr-settings-modal/ocr-settings-modal.component';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, ExportFormat } from './components/export-settings-modal/export-settings-modal.component';
import { BackgroundProgressComponent, BackgroundJob } from './components/background-progress/background-progress.component';
import { OcrJobService, OcrJob } from './services/ocr-job.service';
import { TaskRailComponent } from './components/task-rail/task-rail.component';
import { BLOCK_CATEGORIES, normalizeCategories, UNLABEL_CATEGORY } from '@shared/ocr/block-categories';
import { OCR_RENDER_SCALE } from '@shared/ocr/ocr-render';
import {
  CORPUS_PAGE_TYPE_NAMES, bookModalFontSize, planPageTypeLabels, type CorpusPageType,
} from '@shared/ocr/page-types';
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

// Audiobook production state (stored in the project's manifest)
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
  /**
   * The project's own export EPUB, absolute and resolved, or '' when it has
   * never exported. Written by the main-process adapter from the manifest's
   * `outputs.epub` record.
   *
   * This is how a document is recognised as the project's own product: the
   * export is named after the BOOK now, so the filename carries no signal at
   * all, and only the recorded path can answer it.
   */
  exported_epub_path?: string;
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
  /** User-authored blocks (chapter boxes). Restored with addBlocks, never with
   *  replaceTextBlocksOnPages — see TextBlock.is_manual for why that matters. */
  manual_blocks?: TextBlock[];
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
  // Audiobook production (unified with the project manifest)
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
  'd': 'discard',
  'u': UNLABEL_CATEGORY,  // not a class — clears the label (see sentinel above)
};
// Fourteen keys for fourteen classes (plus `u` to unlabel). `m`/`shift+m`
// (front_matter/back_matter) and `shift+f` (footnote_ref) are deliberately
// absent, not merely unbound: those classes were retired Jul 2026 and a live
// shortcut is the easiest way to put one back into the corpus by accident.
// See autoDetectedCategoryList.

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
    AnalysisPanelComponent,
    MergePanelComponent,
    FilePickerComponent,
    CropPanelComponent,
    DocumentNavComponent,
    StationBarComponent,
    PassOptionsModalComponent,
    TabBarComponent,
    OcrSettingsModalComponent,
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
              <!-- Said, never hidden: a station whose gestures silently do
                   nothing is indistinguishable from a broken picker. -->
              @if (curationReadOnlyReason(); as reason) {
                <div class="review-banner">
                  <span class="review-banner-icon">🔒</span>
                  <span class="review-banner-text">{{ reason }}</span>
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
                [blocks]="stationBlocks()"
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
              [tocSelectedBlockIds]="tocSelectedBlockIdSet()"
              [isEpub]="isCurrentDocumentEpub()"
              [splitOriginalBlockIds]="splitOriginalBlockIds()"
              [mergeSourceBlockIds]="mergeSourceBlockIds()"
              [deletedPages]="deletedPages()"
              [selectedPages]="selectedPageNumbers()"
              [organizeMode]="organizeMode()"
              [paragraphBreaks]="editorState.paragraphBreaks()"
              [categoryList]="autoDetectedCategoryList()"
              [categoryCorrections]="editorState.categoryCorrections()"
              [pageTypes]="editorState.pageTypes()"
              [canMarkPageTypes]="canMarkPageTypes()"
              [showCategoryColors]="showCategoryColors()"
              [labelMode]="labelMode()"
              (blockClick)="onBlockClick($event)"
              (chapterFromBlocks)="onChapterFromBlocks($event)"
              (pageDeleteToggle)="togglePageDeleted($event)"
              (pageSelect)="onPageSelect($event)"
              (deleteSelectedPages)="onDeleteSelectedPages($event)"
              (blockDoubleClick)="onBlockDoubleClick($event)"
              (blockHover)="onBlockHover($event)"
              (selectLikeThis)="selectLikeThis($event)"
              (deleteLikeThis)="deleteLikeThis($event)"
              (deleteBlock)="deleteBlock($event)"
              (mergeSelection)="mergeSelectedBlocks()"
              (highlightClick)="onHighlightClick($event)"
              (revertBlock)="revertBlockText($event)"
              (splitBlock)="onSplitBlockRequest($event)"
              (setBlockCategory)="onSetBlockCategory($event)"
              (zoomChange)="onZoomChange($event)"
              (selectAllOnPage)="selectAllOnPage($event)"
              (deselectAllOnPage)="deselectAllOnPage($event)"
              (markPageType)="onMarkPageType($event)"
              (cropComplete)="onCropComplete($event)"
              (marqueeSelect)="onMarqueeSelect($event)"
              (pageReorder)="onPageReorder($event)"
              (sampleMouseDown)="onSampleMouseDown($event.event, $event.page, $event.pageX, $event.pageY)"
              (sampleMouseMove)="onSampleMouseMove($event.pageX, $event.pageY)"
              (sampleMouseUp)="onSampleMouseUp()"
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
              <!--
                The default nav, and the one the spec calls THE right-side nav:
                Detect over Select / Label / Chapter. Everything else in this
                switch is a tool that takes over the pointer for a while and
                hands it back.
              -->
              <app-document-nav
                [blocks]="textLayerFilteredBlocks()"
                [selectedBlockIds]="selectedBlockIds()"
                [chapterBlocks]="documentBlocks.chapterBlocks()"
                [state]="documentBlocks.state()"
                [stageRunning]="documentBlocks.stageRunning()"
                [stageMessage]="documentBlocks.stageMessage()"
                [lastError]="documentBlocks.lastError()"
                [hasDocument]="workingDocumentOpen()"
                [tab]="navTab()"
                (tabChange)="setNavTab($event)"
                (detect)="runDetect()"
                (cancelStage)="documentBlocks.cancelStage()"
                (selectCategory)="selectAllOfCategory({ categoryId: $event, additive: false })"
                (assignCategory)="assignSelectedToCategory($event)"
                (selectAll)="selectAllBlocks()"
                (deselectAll)="clearSelection()"
                (merge)="mergeSelectedBlocks()"
                (chapterClick)="selectChapterBlocks($event)"
                (retitle)="retitleChapterBlock($event)"
                (resetTo)="resetToStage($event)"
              />
            }
          }
        </div>
      </desktop-split-pane>

      <!-- The ladder. Never for a corpus book — every station of it writes into
           a project, and a corpus book is deliberately not one. -->
      @if (embedded() && !corpusMode()) {
        <div class="station-foot">
          <app-station-bar
            [tabs]="stationTabs()"
            [actions]="stationActions()"
            [contextLine]="stationContext()"
            [nextLabel]="stationNextLabel()"
            [nextReason]="stationNextStep().lockedReason"
            [busy]="stationBusy()"
            (stationClick)="openStation($event)"
            (actionClick)="onStationAction($event)"
            (next)="stationNext()"
          />
          <!--
            How a long operation is WATCHED, never what it does. The stage runs
            in main either way; these say whether the queue watches it and
            whether this window follows the artifact it makes.
          -->
          <div class="long-run-options">
            <label
              class="long-run-option"
              [class.refused]="runInBackgroundRefusal() !== null"
              [title]="runInBackgroundRefusal() ?? 'Hand the run to the queue and stop watching it.'"
            >
              <input
                type="checkbox"
                [disabled]="runInBackgroundRefusal() !== null"
                [checked]="effectiveRunInBackground()"
                (change)="setRunInBackground($any($event.target).checked)"
              />
              <span>Run in background</span>
            </label>
            <label class="long-run-option">
              <input
                type="checkbox"
                [checked]="openWhenFinished()"
                (change)="setOpenWhenFinished($any($event.target).checked)"
              />
              <span>Open when finished</span>
            </label>
          </div>
        </div>
      }
    } @else if (embedded()) {
      <!-- Loading state for embedded mode -->
      <div class="embedded-loading">
        <div class="loading-spinner"></div>
        <p>Loading project...</p>
      </div>
    } @else {
      <!-- No document open, standalone mode. Browsing projects lives in Studio;
           the grid that used to sit here only ever listed single-file .bfp
           projects, which no longer exist. -->
      <div class="library-container">
        <div class="empty-workspace">
          <p>No document open.</p>
          <desktop-button variant="primary" (click)="showFilePicker.set(true)">Open Document…</desktop-button>
        </div>
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
        [currentPage]="currentPageIndex()"
        [getPageImage]="getPageImageForOcrFn"
        [documentId]="activeDocumentId() || 'unknown'"
        [documentName]="pdfName()"
        [lightweightMode]="lightweightMode()"
        [pdfPath]="effectivePath()"
        [bookKey]="bookKey()"
        [projectDir]="projectPath() || ''"
        [corpusBookDir]="corpusBook()?.dir || ''"
        [runInBackground]="runInBackground()"
        [openWhenFinished]="openWhenFinished()"
        (close)="showOcrSettings.set(false)"
        (runInBackgroundChange)="setRunInBackground($event)"
        (openWhenFinishedChange)="setOpenWhenFinished($event)"
        (ocrCompleted)="onOcrCompleted($event)"
        (documentReadyToPaint)="onDocumentReadyToPaint()"
        (handOffToQueue)="handOffToQueue()"
        (backgroundJobStarted)="onBackgroundOcrStarted($event)"
      />
    }

    <!-- The two EPUB passes that cannot start from a button alone. -->
    @if (passOptionsKind(); as kind) {
      <app-pass-options-modal
        [kind]="kind"
        [ai]="passAiChoice()"
        (cancel)="passOptionsKind.set(null)"
        (confirmed)="onPassOptionsConfirmed($event)"
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

    .station-foot {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      border-top: 1px solid var(--border-subtle);
    }

    .long-run-options {
      display: flex;
      gap: var(--ui-spacing-lg);
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      background: var(--bg-toolbar);
      border-top: 1px solid var(--border-subtle);
    }

    .long-run-option {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      cursor: pointer;

      input { accent-color: var(--accent); }
    }

    /* Refused for this book, and hovering says why. */
    .long-run-option.refused {
      color: var(--text-tertiary);
      cursor: not-allowed;
    }

    /* The sentence saying why the artifact on screen is not curated here */
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

    .empty-workspace {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      color: var(--text-secondary);
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

  /** Absolute project directory to auto-load when embedded */
  readonly projectDir = input<string>('');

  /**
   * Optional: Override the source file to load when opening a project.
   * This allows loading a project (for saved state like deletions, chapters) but
   * using a different source file (e.g., original vs exported vs cleaned EPUB).
   * When set, the project's stored source_path is ignored in favor of this path.
   */
  readonly overrideSourcePath = input<string | null>(null);

  /**
   * Optional: When set, the editor is in "library mode" — editing a standalone
   * ebook file (not a manifest project). Save shows a modal to replace or save as new.
   */
  readonly librarySourcePath = input<string | null>(null);

  /**
   * Optional: the absolute path of a TRAINING-CORPUS book folder
   * (/Volumes/Callisto/training/rubric/<slug>/), set only by the File menu's
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

  /** Emitted when Finalize is clicked in embedded mode */
  readonly finalized = output<{ success: boolean; epubPath?: string; error?: string }>();

  /**
   * Tracks the source file being edited (EPUB/PDF path, not the project directory).
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
  private readonly queueService = inject(QueueService);
  private readonly settingsService = inject(SettingsService);

  // Injected services for state management
  readonly editorState = inject(PdfEditorStateService);
  readonly projectService = inject(ProjectService);
  /**
   * The block layer of `<Original>.working.pdf`. Public because the right-side
   * nav is bound straight to it — reading the document through a second set of
   * component signals is exactly the copy this pipeline exists to remove.
   */
  readonly documentBlocks = inject(DocumentBlocksService);

  /** Unsubscribe functions for pdf:text-ready events, keyed by document ID */
  private textReadyUnsubs = new Map<string, () => void>();

  // Auto-save effect - watches for unsaved changes and triggers save (auto-creates project if needed)
  private readonly autoSaveEffect = effect(() => {
    if (this.hasUnsavedChanges() && this.pdfLoaded()) {
      this.scheduleAutoSave();
    }
  });

  /**
   * Read the working document for the book that just opened.
   *
   * Readiness is `pdfLoaded`, not a non-empty block list: a scan has no blocks
   * of its own until Get Text and Detect have run, which is exactly the state
   * this has to be able to open into.
   *
   * Keyed to the ref rather than run once, because one window opens many books
   * — a tab switch, the pipeline's swap to the review EPUB — and each of them
   * has its own documents. A book with no ref (a corpus book, a loose file) is
   * not a failure to open: `loadWorkingDocument` reads that as "there is nothing
   * to open" and leaves the editor's own block list alone.
   */
  private openedDocumentKey = '';
  private readonly workingDocumentEffect = effect(() => {
    const ref = this.workingDocumentRef();
    if (!this.pdfLoaded()) return;
    const key = ref ? `${ref.projectDir}|${ref.sourcePath ?? ''}` : '';
    if (this.openedDocumentKey === key) return;
    this.openedDocumentKey = key;
    void this.loadWorkingDocument();
  });

  /**
   * Ask main where this project's book is, whenever the project changes.
   *
   * Keyed on the project directory rather than on the document on screen: the
   * book belongs to the project, and switching between the archive and the book
   * inside one project does not change where it is.
   */
  private askedBookEpubFor = '';
  private readonly bookEpubEffect = effect(() => {
    const dir = this.projectPath() ?? '';
    if (this.askedBookEpubFor === dir) return;
    this.askedBookEpubFor = dir;
    void this.refreshBookEpub();
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
    // A stage's own most recent line, as it runs, for the nav to show verbatim.
    // Torn down with the component so a second window's stages are not narrated
    // into this one's.
    const unwatch = this.documentBlocks.watchProgress();
    this.destroyRef.onDestroy(unwatch);

    this.restoreLongRunOptions();

    // A stage this window did not start still changes what this book HAS — the
    // OCR dialog submits to the queue, and the queue's worker is a different
    // process's business. So the station tabs are re-measured whenever any stage
    // for THIS project lands, rather than only after a stage this window awaited.
    const unwatchFinished = this.electronService.onDocumentStageFinished((event) => {
      if (event.projectDir !== this.projectPath()) return;
      void this.onProjectStageFinished(event.stage);
    });
    this.destroyRef.onDestroy(unwatchFinished);

    const corpusDir = this.corpusPath();
    if (corpusDir) {
      // Training-corpus book: blocks and labels come from the corpus folder,
      // never from a project. Checked FIRST so no project path can run for it.
      setTimeout(() => void this.loadCorpusBook(corpusDir), 0);
    } else if (this.embedded() && this.projectDir()) {
      // Embedded mode - load whatever projectDir() points at (see openTarget)
      const filePath = this.projectDir();
      setTimeout(() => void this.openTarget(filePath), 0);
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
      if (this.labelMode() && this.selectedBlockIds().length > 0 && !this.curationLocked()) {
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

  // ───────────────────────────────────────────────────────────────────────────
  // THE LADDER — Archive → Working → EPUB → Narration
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Pipeline V2 (docs/PIPELINE_V2_PLAN.md). Processing is not a place: every
  // operation is a button on the station where its INPUT lives, and every step
  // produces a visible artifact you can open. What replaced what is worth saying
  // once, because the difference is the whole design:
  //
  // The old model was a two-station wizard — Prepare, then Review — with a
  // `pipelineStep` signal, a `visitedStations` set and a "generate" button that
  // both did work and navigated. That meant the app REMEMBERED where a book was,
  // and the memory could be wrong: a set that said 'epub-review' was visited
  // said nothing about whether the EPUB was still on disk, and the Back button
  // had to reload the source because the review had swapped the document out
  // from under the editor.
  //
  // Now nothing is remembered. `viewedStation` is which file is in the viewer —
  // a fact about this window, not about the book — and everything else is
  // derived from the binding record every time it is asked
  // (`shared/document/stations.ts`). A station exists because its artifact is on
  // disk, so the tabs cannot disagree with the project folder.

  private stationSwapping = false; // guard: a station load is not the user leaving

  // ── How a long operation is watched ───────────────────────────────────────
  //
  // Neither of these decides anything about the WORK. A document stage runs in
  // the main process either way, and closing this window changes nothing about
  // it; these two say whether the queue is what watches it, and whether this
  // window follows the artifact it produces.
  //
  // Persisted in localStorage rather than in Settings, because they are a habit
  // about this window rather than a fact about the pipeline — and localStorage
  // is where the picker already keeps its rail state. One key for both
  // surfaces (the OCR dialog and the station bar): they are the same preference
  // asked in two places, and two records of it would answer differently.
  private static readonly LONG_RUN_KEY = 'bookforge-picker-long-run';

  readonly runInBackground = signal(false);
  readonly openWhenFinished = signal(true);

  /**
   * Why this book cannot be built in the background, or null.
   *
   * The queue runs PASSES, and its pass kinds are get-text, blocks, reflow,
   * footnotes, simplify and translate. There is no pass for the
   * markup-preserving export: it aligns the editor's own view of the book
   * against the source, and that view lives in this window. So for a book that
   * arrived as an EPUB the checkbox is refused BY NAME rather than accepted and
   * quietly ignored — a "run in background" that silently runs in the foreground
   * is exactly the kind of lie this phase exists to remove.
   */
  readonly runInBackgroundRefusal = computed<string | null>(() => {
    if (!this.buildsByPreservingMarkup()) return null;
    return 'This book keeps its own markup, and that export aligns against the editor\'s view of '
      + 'it — there is no queue pass that can carry it. Building it happens here, with the book '
      + 'on screen.';
  });

  /**
   * Whether the NEXT build actually goes to the queue.
   *
   * One value drives the checkbox and the branch, so the box cannot show ticked
   * for a book that will build in the foreground regardless.
   */
  readonly effectiveRunInBackground = computed(() =>
    this.runInBackgroundRefusal() === null && this.runInBackground());

  setRunInBackground(on: boolean): void {
    this.runInBackground.set(on);
    this.persistLongRunOptions();
  }

  setOpenWhenFinished(on: boolean): void {
    this.openWhenFinished.set(on);
    this.persistLongRunOptions();
  }

  private persistLongRunOptions(): void {
    try {
      localStorage.setItem(PdfPickerComponent.LONG_RUN_KEY, JSON.stringify({
        runInBackground: this.runInBackground(),
        openWhenFinished: this.openWhenFinished(),
      }));
    } catch (err) {
      // A storage that refuses a write is not a reason to stop working; the
      // choice still holds for this session, and it is said once here.
      console.warn('[picker] could not remember the long-run options:', err);
    }
  }

  private restoreLongRunOptions(): void {
    let raw: string | null;
    try {
      raw = localStorage.getItem(PdfPickerComponent.LONG_RUN_KEY);
    } catch (err) {
      console.warn('[picker] could not read the long-run options:', err);
      return;
    }
    // Nothing stored is the ordinary first-run state, not a failure.
    if (!raw) return;
    let stored: { runInBackground?: unknown; openWhenFinished?: unknown };
    try {
      stored = JSON.parse(raw) as typeof stored;
    } catch (err) {
      // Unreadable storage is a storage failure, exactly like the read above,
      // and it is handled the same way. This is not a pipeline value standing in
      // for a missing one — it is a habit about two checkboxes, and letting it
      // throw here would take the whole picker down on startup over them.
      console.warn('[picker] the stored long-run options were unreadable:', err);
      return;
    }
    if (typeof stored.runInBackground === 'boolean') this.runInBackground.set(stored.runInBackground);
    if (typeof stored.openWhenFinished === 'boolean') this.openWhenFinished.set(stored.openWhenFinished);
  }

  /** The artifact in the viewer. Which FILE is on screen, and nothing more. */
  readonly viewedStation = signal<StationId>('archive');

  /** A stage is running for this book, so nothing on the bar should be pressable. */
  readonly stationBusy = computed(() =>
    this.documentBlocks.stageRunning() !== null || this.loading());

  /**
   * The project's book EPUB, absolute, or null when it has never been exported.
   *
   * MAIN'S ANSWER, asked for (`projects:export-info`) and never composed here.
   * The export is named after the book — the manifest owns that name — and it is
   * located by its manifest record rather than by scanning `source/`, so an
   * unrecorded stray is not adopted as a project's book. Existence is checked on
   * that side too, so a record pointing at a deleted file reads as null.
   *
   * This, not the binding's `stages.reflow`, is what the EPUB station's presence
   * is measured by: a book that arrived as an EPUB has no binding record at all,
   * and it still has a book once it has been built.
   */
  /**
   * Main's last answer, STAMPED with the project it was about.
   *
   * The stamp is the whole point. A window moves between books, the ask is a
   * round trip, and an answer that did not say which project it concerned would
   * be read as the current one — so a failed ask about book B would leave book
   * A's EPUB standing as B's, with a live tab that opens the wrong book. An
   * answer is only ever read back for the project it names (`bookEpubPath`).
   */
  private readonly bookEpubAnswer = signal<{ dir: string; path: string | null } | null>(null);

  /**
   * Main's refusal when it could not answer where the book is, stamped the same
   * way and for the same reason.
   *
   * Kept apart from the path because "we could not ask" and "there is none" are
   * different states, and collapsing them would tell somebody with a damaged
   * manifest to press Build the book — which fails the same way, without saying
   * so.
   */
  private readonly bookEpubErrorAnswer = signal<{ dir: string; message: string } | null>(null);

  /**
   * The project's book, absolute, or null when there is none — and null, too,
   * while the answer in hand is about a different project.
   */
  private readonly bookEpubPath = computed<string | null>(() => {
    const answer = this.bookEpubAnswer();
    const dir = this.projectPath();
    return answer && dir && answer.dir === dir ? answer.path : null;
  });

  /** Main's refusal about THIS project, or null. */
  private readonly bookEpubError = computed<string | null>(() => {
    const answer = this.bookEpubErrorAnswer();
    const dir = this.projectPath();
    return answer && dir && answer.dir === dir ? answer.message : null;
  });

  /**
   * Ask main where this project's book is. Called when the project changes and
   * after anything that could have written one.
   */
  private async refreshBookEpub(): Promise<void> {
    const dir = this.projectPath();
    if (!dir) {
      // No project, no book of its own. Not a failure: a loose file has none.
      this.bookEpubAnswer.set(null);
      this.bookEpubErrorAnswer.set(null);
      return;
    }
    try {
      const info = await this.electronService.projectsExportInfo(dir);
      this.bookEpubErrorAnswer.set(null);
      this.bookEpubAnswer.set({ dir, path: info.exported ? info.exported.absPath : null });
    } catch (err) {
      // Main's own sentence, kept and shown on the EPUB tab. The last proved
      // path for THIS project is left alone — a round trip that failed is not
      // evidence the book stopped existing — and it is stamped, so it can never
      // be read as another project's answer.
      const message = err instanceof Error ? err.message : String(err);
      this.bookEpubErrorAnswer.set({ dir, message });
      console.error('[picker] could not resolve this project\'s book EPUB:', message);
    }
  }

  /**
   * This book's documents, as the ladder needs them: three facts from three
   * different authorities, deliberately not conflated.
   *
   * `hasPdfOriginal` is the one that makes an EPUB-native book work. The
   * document pipeline casts a working PDF from the book's ORIGINAL, and main
   * refuses an EPUB there by name — so such a book has no binding record at all,
   * `documentBlocks.state()` is null forever, and its Working station is NOT
   * APPLICABLE rather than not-yet. Reading that as "not yet" is what left those
   * books standing at a locked Next pointing to a button that would refuse them.
   */
  readonly bookDocuments = computed<BookDocuments>(() => ({
    hasPdfOriginal: this.curatedPdfPath() !== null,
    workingStages: this.documentBlocks.state()?.stages ?? null,
    // Main's existence-checked manifest record, never the binding's
    // `stages.reflow`: a book with no PDF ancestor has no binding to ask, and it
    // still has a book once it has been exported.
    bookEpubExists: this.bookEpubPath() !== null,
  }));

  /** The stations this book HAS, measured. */
  readonly presentStations = computed<StationId[]>(() =>
    existingStations(this.bookDocuments()));

  /**
   * This BOOK is built by preserving its own markup rather than by reflow.
   *
   * Deliberately not `useEpubPreservingExport()`, which asks whether the file
   * ON SCREEN is an EPUB. That is the right question for Save As and for the
   * legacy export paths — they act on what you are looking at — and the wrong
   * one for the station bar, which is about the book: at the EPUB station of a
   * reflowed PDF book the file on screen is an EPUB too, and asking there would
   * put a markup-preserving build on a book that has no markup to preserve.
   *
   * The book-level fact is whether it has a PDF ancestor. It does not change
   * when the viewer does.
   */
  readonly buildsByPreservingMarkup = computed(() =>
    !!this.projectPath() && !this.bookDocuments().hasPdfOriginal);

  /**
   * What is missing between the station on screen and the next one, or null.
   *
   * Read by BOTH the Next button and the disabled action buttons, so a lock is
   * explained with one sentence rather than two that can drift.
   */
  readonly stationNextStep = computed(() => {
    const book = this.bookDocuments();
    const at = this.viewedStation();
    // A window showing a station the book no longer has is a real state — a
    // reset removed the working copy while it was open — and the ladder throws
    // on it by name. Here it means "you are back at the archive", which is
    // exactly where a reset leaves the book.
    if (stationPresence(at, book) !== 'present') return nextStation('archive', book);
    return nextStation(at, book);
  });

  readonly stationTabs = computed<StationTab[]>(() => {
    const book = this.bookDocuments();
    const at = this.viewedStation();
    return STATIONS.map(id => ({
      id,
      label: STATION_LABELS[id],
      presence: stationPresence(id, book),
      current: id === at,
      reason: this.stationAbsenceReason(id, book),
    }));
  });

  /** One line saying what the station on screen IS. */
  readonly stationContext = computed(() => {
    const book = this.bookDocuments();
    switch (this.viewedStation()) {
      case 'archive':
        // Still never written to, either way. What changes is where the edits go
        // in the meantime: into a working copy's annotations for a cast book,
        // into the project for one that is applied at build time.
        if (this.hasWorkingCopy()) {
          return 'The archived original, exactly as it was imported. Nothing is ever written to it.';
        }
        // A book that COULD have a working copy and does not is standing here
        // because making one costs minutes — say that, rather than leaving a
        // read-only page with no explanation for why curation is refused.
        if (book.hasPdfOriginal && this.originalClass() === 'scanned') {
          return 'The archived original. This book is a scan, so it has to be read before it can be '
            + 'curated — press OCR / Cast. Until then nothing here can be edited, and the original '
            + 'is never written to.';
        }
        return 'The archived original — read-only on disk, and where this book is curated. '
          + 'What you delete here is applied when the book is built.';
      case 'working':
        return book.workingStages?.blocks === false
          ? 'The working copy: the book has been read, and nothing is labelled yet. '
            + 'Press Detect — it is what turns the text into blocks you can curate.'
          : 'The working copy: the cast text and the block annotations. Curate here, then build the book.';
      case 'epub':
        return 'The book. Every text transformation happens here, on screen, where you can read the result.';
      case 'tts':
        return 'The finished book, handed to narration.';
    }
  });

  /**
   * The buttons this station offers.
   *
   * Each one lives where its INPUT lives, which is the whole of the V2 idea, and
   * each carries the sentence it is disabled WITH rather than being hidden — a
   * button that vanishes teaches nothing about how to get it back.
   */
  readonly stationActions = computed<StationAction[]>(() => {
    const book = this.bookDocuments();
    const noProject = this.projectPath() ? null
      : 'This document does not belong to a BookForge project, and every station writes into one.';
    // Said here rather than discovered when the stage refuses: the document
    // pipeline casts a working PDF from the book's original, so a project that
    // arrived as an EPUB has nothing to cast FROM. Main refuses it by name; a
    // button that has to be pressed to find that out is a worse way to hear it.
    const noPdf = this.curatedPdfPath() ? null
      : 'This book arrived as an EPUB, so there is no PDF to cast a working copy from. '
        + 'Curate it here and the text passes run on the book itself.';
    switch (this.viewedStation()) {
      case 'archive': {
        const actions: StationAction[] = [
          { id: 'cast', label: 'OCR / Cast', reason: noProject ?? noPdf, primary: noPdf === null },
          // Detect no longer implies the cast. The OCR dialog submits the cast
          // and ONLY the cast (Owen's ruling, 2026-08-04), so a book with no
          // working copy has nothing here to detect — said by name rather than
          // discovered by pressing it.
          {
            id: 'detect-from-archive',
            label: 'Detect',
            reason: noProject ?? noPdf ?? (stationPresence('working', book) === 'present' ? null
              : 'Detect labels the blocks in the working copy, and this book has not been read '
                + 'yet — press OCR / Cast first.'),
          },
        ];
        // A book with no working copy to build FROM is built HERE, because here
        // is where it is curated. Cast and Detect stay beside it, refused by
        // name: they are what this station offers a book that has a PDF, and a
        // control that vanishes teaches nothing about why.
        if (this.buildsByPreservingMarkup()) {
          actions.push({ id: 'reflow', label: 'Build the book', reason: noProject, primary: true });
        }
        return actions;
      }
      case 'working': {
        // A cast leaves the working document carrying no annotations at all —
        // that is what a cast IS — so a book that has been read and not yet
        // detected has exactly one next move, and Detect is it. Making that the
        // primary action is what replaces the OCR dialog quietly buying a Detect
        // nobody asked for (Owen's ruling, 2026-08-04).
        const undetected = book.workingStages?.blocks === false;
        return [
          { id: 'detect', label: 'Detect', reason: noProject, primary: undetected },
          {
            id: 'reflow',
            label: 'Build the book',
            reason: noProject
              ?? (stationPresence('working', book) === 'present' ? null
                : 'There is no working copy to build from — press OCR / Cast.')
              ?? (undetected
                ? 'Build the book reads the block labels, and nothing is labelled yet — press Detect.'
                : null),
            primary: !undetected,
          },
        ];
      }
      case 'epub':
        return [
          { id: 'footnotes', label: 'Remove footnotes', reason: noProject },
          { id: 'simplify', label: 'Simplify', reason: noProject },
          { id: 'translate', label: 'Translate', reason: noProject },
        ];
      case 'tts':
        return [];
    }
  });

  readonly stationNextLabel = computed(() => {
    const next = this.stationNextStep().next;
    if (next === null) return 'Next';
    return `Next: ${STATION_LABELS[next]} →`;
  });

  /**
   * This book has a working copy, so there is a station that is not the archive.
   *
   * The whole of the archive-is-read-only rule hangs on this. A book that HAS a
   * working copy has somewhere else to be edited, so editing the original is
   * both forbidden and unnecessary. A book that has none — one that arrived as
   * an EPUB (main refuses to cast a working PDF from a book, by name), a loose
   * file, a PDF nobody has cast yet — has nowhere else, and its curation is the
   * editor's own block list: recorded in the manifest and applied by the
   * markup-preserving EPUB export. Locking those books would leave them with no
   * editable station at all.
   */
  private readonly hasWorkingCopy = computed(() => this.presentStations().includes('working'));

  /**
   * Why curation is refused on the artifact currently on screen, or null.
   *
   * For a cast book, curation is an edit to the WORKING copy's annotations, so
   * it is offered at exactly one station and the others say so rather than
   * silently doing nothing — an archive whose gestures vanish is
   * indistinguishable from a broken picker.
   *
   * For a book with no working copy there is no such division: the station on
   * screen is the only one it has, and it is edited the way it always was.
   */
  readonly curationReadOnlyReason = computed<string | null>(() => {
    switch (this.viewedStation()) {
      case 'archive':
        return this.hasWorkingCopy()
          ? 'This is the archived original — switch to the Working copy to edit.'
          : null;
      case 'epub':
        // The built book is derived either way, so curation belongs upstream of
        // it — and where upstream IS differs by the kind of book.
        return this.hasWorkingCopy()
          ? 'This is the built book. Curation happens on the working copy; the text passes happen here.'
          : 'This is the built book. Curation happens on the original at the Archive station; '
            + 'the text passes happen here.';
      case 'tts':
        return 'The book has been handed to narration.';
      case 'working':
        return null;
    }
  });

  /** True when nothing on screen may be curated. Every mutation entry point asks. */
  readonly curationLocked = computed(() => this.curationReadOnlyReason() !== null);

  /**
   * The blocks the viewer paints — empty at the Archive station.
   *
   * Archive and Working show the same PAGES, because the working document is a
   * copy of the archive original with an invisible text layer and the block
   * annotations added: rendering the original and painting the annotations over
   * it IS the working document on screen, and it costs no second analysis of a
   * 300 MB scan. What separates the two stations is therefore exactly what the
   * annotations are: the archive is the pages with nothing drawn on them, which
   * is what "the archived original, untouched" looks like.
   *
   * It also keeps `<Original>.working.pdf` out of the tab strip, which
   * docs/DOCUMENT_PIPELINE.md requires — it is a system file and gets no
   * user-facing listing.
   *
   * The blank archive is what the archive means only when there is a working
   * copy to mean it against. A book with none — an EPUB, a loose file — is
   * being read at its one and only station, and painting nothing there would
   * hide the blocks it is curated through.
   */
  readonly stationBlocks = computed(() =>
    this.viewedStation() === 'archive' && this.hasWorkingCopy() ? [] : this.blocks());

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

  /**
   * The main-owned OCR run for the corpus book on screen, if there is one.
   *
   * Kept here rather than only in the OCR panel so the minimized progress bar
   * has something to show once the panel is closed — closing the panel is the
   * normal way to watch a long run, and a bar that vanished with it would be
   * reporting the window instead of the work.
   */
  readonly corpusOcrRun = signal<CorpusOcrRunState | null>(null);

  /**
   * Follow the run for the book on screen, and take its result when it lands.
   *
   * The completion handler lives HERE, on the window, and not on the OCR panel.
   * The panel is destroyed the moment it is closed — which is the normal way to
   * watch a long run — so a run that finished while it was closed emitted its
   * completion into nothing. The editor then kept the block set it had loaded
   * when the book was opened: a 532-page book that had finished every page still
   * showed the 197 pages it knew about at open time, and looked for all the
   * world like OCR had stopped early.
   */
  private readonly corpusOcrWatcher = (() => {
    let wasRunning = false;
    const unsubscribe = this.electronService.onCorpusOcrProgress((state) => {
      if (state.bookDir !== this.corpusBook()?.dir) return;
      const running = state.status === 'running';
      this.corpusOcrRun.set(running ? state : null);
      // Only on the running -> finished edge: main emits a final state for
      // cancelled and error too, and re-reading on every one of them would
      // reload the book repeatedly for no change.
      if (wasRunning && !running && state.status !== 'error') {
        void this.onCorpusOcrFinished();
      }
      wasRunning = running;
    });
    this.destroyRef.onDestroy(unsubscribe);
  })();

  // Background OCR jobs - convert OcrJob[] to BackgroundJob[] for the progress component
  readonly backgroundJobs = computed<BackgroundJob[]>(() => {
    const corpusRun = this.corpusOcrRun();
    const corpusEntry: BackgroundJob[] = corpusRun ? [{
      id: `corpus-ocr:${corpusRun.bookDir}`,
      type: 'ocr' as const,
      title: `OCR: ${this.pdfName()}`,
      // Over the BOOK, so a resumed run reads "197 of 532" and climbs from
      // there. Counting the run's own pages is what made this restart at zero.
      progress: corpusRun.bookPages > 0
        ? Math.round((corpusRun.journalPages / corpusRun.bookPages) * 100)
        : 0,
      current: corpusRun.journalPages,
      total: corpusRun.bookPages,
      status: 'running' as const,
    }] : [];

    return corpusEntry.concat(this.ocrJobService.jobs().map(job => {
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
    }));
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

  // Task/panel state. `activePanel` is the single source of truth for the right
  // pane and the viewer overlay.
  //
  // There is no second "pointer mode" signal beside it any more. There used to
  // be — `viewerInteraction`, select or edit — and Edit mode is deleted
  // (docs/PIPELINE_V2_PLAN.md, ruled 2026-08-04), which left it a union of one.
  // Crop is a PANEL rather than a thing the pointer can be, so the pointer is
  // select whenever no panel has taken it, and that is a fact about
  // `activePanel` rather than a value to keep in step with it.
  readonly activePanel = signal<PanelId | null>(null);   // null = the document nav

  /**
   * Which tab of the document nav is open — and, for Label, what a click on a
   * block MEANS.
   *
   * It lives here rather than in the nav because the left rail offers Label too
   * and the viewer's pointer changes with it. One value, so the rail row, the
   * pointer and the tab strip cannot say three different things.
   */
  readonly navTab = signal<DocumentNavTab>('select');

  /**
   * The one rail row shown as current: the open panel, or — with no panel open
   * — whichever pointer mode is live. The rail is the mode switcher, so this is
   * what tells the user where they are. Which TAB of the nav is showing is not
   * among them: the Label tab is a palette over the selection Select made, not
   * a fourth thing the pointer can be.
   */
  // `?? 'select'` is not a fallback for a missing value: `activePanel` being
  // null IS the state "no panel has taken the pointer", and select is what the
  // pointer does then.
  readonly railCurrent = computed<PanelId>(() => this.activePanel() ?? 'select');

  /**
   * Label mode: assign a category to the selected blocks by clicking the palette
   * or pressing its key.
   *
   * With a working document a label is the block's ONE category field, written
   * into the annotation. Without one it is ordinary project state
   * (`category_corrections`), the same field Select and Edit read. Training
   * sessions under /Volumes/Callisto/training/rubric/ are treated as READ-ONLY
   * history: they are imported into a project that has no labels yet, and never
   * rewritten.
   */
  readonly labelMode = computed(() => this.navTab() === 'label');

  // Task groups for the rail (static; TASK_ORDER drives digit shortcuts).
  readonly taskGroups = TASK_GROUPS;

  // Collapsed rail groups (persisted; see rail persistence effect).
  readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  // Viewer editor mode: crop while that panel owns the pointer, else select.
  readonly viewerEditorMode = computed<string>(() =>
    this.activePanel() === 'crop' ? 'crop' : 'select');

  // The rail is the curation tools, so it is shown exactly where curation is
  // possible and nowhere else — asked as one question rather than two, so a
  // rail full of tools can never appear over an artifact that refuses them.
  // That is the working copy for a cast book, and the book itself for one that
  // has no working copy (an EPUB, a loose file: see `curationReadOnlyReason`).
  readonly showToolbox = computed(() => !this.curationLocked());

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

  /**
   * The page the viewer was last taken to. Zero-based.
   *
   * The only thing that reads it is the OCR dialog's "current page" scope, which
   * a training-corpus book uses to recognize one page. It used to read the split
   * panel's preview page — which was 0 unless somebody had been in Split mode,
   * so "current page" meant page 1 for everyone else.
   */
  readonly currentPageIndex = signal(0);

  // Analysis mode state
  readonly analysisMode = computed(() => this.activePanel() === 'analysis');

  // Paragraph breaks are no longer curated by hand. They are detected on the way
  // into a merge and read by the merge grouping and the EPUB exporter; reflow
  // decides paragraph structure for a working document, so there is nothing here
  // for the user to set.

  // Chapter state. The list is DERIVED from the `chapter` blocks in the working
  // document (documentChaptersEffect) and set directly only by the books that
  // have none — an EPUB read for its own markup, a loose file.
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
  // default/merge/OCR panels — i.e. any panel that does not commandeer the
  // pointer (crop/split/analysis do).
  readonly organizeMode = computed(() => {
    const panel = this.activePanel();
    return panel === null || panel === 'ocr' || panel === 'merge';
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
    return deriveAllTaskStatuses({
      removedBlockCount: deletedBlockIds.size,
      crop: { croppedPageCount: this.editorState.cropRegions().size },
      ocr: { blocks, deletedBlockIds, totalPages: this.totalPages() },
      mergeCount: this.editorState.blockMerges().size,
    });
  });

  /**
   * Tasks disabled for the current document/context, mapped to a factual
   * reason (same rules the old toolbox enforced): EPUB has no crop/split/ocr;
   * lightweight mode allows only OCR; paragraphs are unavailable while
   * reviewing the exported EPUB.
   *
   * Select is never disabled. It is how the pointer behaves rather than work to
   * be done, and a rail whose current row is disabled would have nowhere to put
   * the user.
   */
  readonly disabledTasks = computed<Map<TaskId, string>>(() => {
    const disabled = new Map<TaskId, string>();
    const isEpub = this.isCurrentDocumentEpub();
    const lightweight = this.lightweightMode();

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
      // Reviewed closes the book; nothing else does. OCR rewrites what the
      // labels are keyed to, so it answers to the same flag, and the flag is
      // the one thing here a human sets deliberately.
      //
      // This used to gate on label COUNT, which was wrong in the direction that
      // costs work: a book became un-OCR-able the moment anything was written to
      // it, so a 532-page novel with 60 labelled pages could not have the other
      // 472 recognised at all. Labels are cheap — a model produces thousands in
      // a pass. The review is a person reading every page, and that is what must
      // not be overwritten by accident.
      const reviewedAt = this.corpusBook()?.reviewedAt ?? null;
      for (const id of TASK_ORDER) {
        if (id === 'select') continue;
        if (id === 'ocr') {
          if (!reviewedAt) continue;
          disabled.set(
            id,
            'This book is marked reviewed — un-mark it in the Training tab to run OCR again',
          );
          continue;
        }
        disabled.set(id, 'Not available for a training-corpus book');
      }
      return disabled;
    }

    for (const id of TASK_ORDER) {
      if (id === 'select') continue;
      if (isEpub && (id === 'crop' || id === 'ocr')) {
        disabled.set(id, 'PDF only — not available for EPUB');
        continue;
      }
      if (lightweight && id !== 'ocr') {
        disabled.set(id, 'Not available in lightweight mode');
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
    if (idsToRemove.length === 0) return;

    // With a working document, removal is a FLAG on the annotation and not an
    // erasure: the mirror paints what the document says, so blocks struck out
    // of the editor's own list would be painted straight back at the next read.
    if (this.blockLayerRead()) {
      this.landBlockDeletions(this.editorState.deleteBlocks(idsToRemove), true);
      return;
    }
    this.editorState.removeBlocks(idsToRemove);
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
    // The working document belongs to the BOOK, so closing one puts this window
    // back to knowing about none. The open key goes with it, so reopening the
    // same book reads the document again rather than being refused by the
    // effect's once-per-ref guard.
    this.workingDocumentOpen.set(false);
    this.blockLayerRead.set(false);
    this.openedDocumentKey = '';
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
    this.projectCreatedAt = null;
    this.analyzedSourceSha256.set(null);
    // No document, nothing declined — the next load decides this again.
    this.projectStateNotApplied.set(false);

    // Clear crop / task panel state (cropRegions live on editorState and are
    // reset by editorState.reset()/loadDocument()).
    this.activePanel.set(null);
    this.currentCropRect.set(null);
  }

  async loadPdf(path: string, lightweight: boolean = false): Promise<void> {
    this.showFilePicker.set(false);
    // A station swap is this window changing which artifact it shows, not the
    // user opening a different book, so it does not send the ladder home.
    if (!this.stationSwapping) this.viewedStation.set('archive');

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
      // The file is already part of a project.
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
      // A new document has no working document until its OWN is read
      // (workingDocumentEffect), which is keyed to the project and the file on
      // screen — never inherited from the tab this one replaced.
      this.workingDocumentOpen.set(false);
      this.blockLayerRead.set(false);
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
      if (!this.embedded() && !this.stationSwapping) {
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

  /**
   * Double-click on a block: select everything of its category.
   *
   * There is no longer a second answer for a chapter block. A chapter's title is
   * edited in the right-nav Chapter tab — double-click the entry there — because
   * the working PDF's text is never edited on the canvas at all
   * (docs/PIPELINE_V2_PLAN.md, ruled 2026-08-04). So a chapter block
   * double-clicks like every other block.
   */
  onBlockDoubleClick(event: {
    block: TextBlock;
    metaKey: boolean;
    ctrlKey: boolean;
  }): void {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    const { block, metaKey, ctrlKey } = event;
    // Crop owns the pointer while its panel is open, and a double-click inside a
    // crop rectangle is not a request to select the page's body text.
    if (this.activePanel() === 'crop') return;
    this.selectLikeThis(block, metaKey || ctrlKey);
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
    // "Like this" means like the block's own category — the one field, no
    // divergence possible.
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
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
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

      this.landBlockDeletions(this.editorState.restoreBlocks(selected), false);
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
      this.landBlockDeletions(this.editorState.deleteSelectedBlocks(), true);

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

  /**
   * A chapter box that was never given a name is not a chapter — it is an empty
   * rectangle that would export as a titleless <h1> and split the book there.
   * Remove it rather than leave it lying on the page.
   */
  private discardEmptyChapterBox(blockId: string, text: string): boolean {
    const block = this.blocks().find(b => b.id === blockId);
    if (!block?.is_manual || text.trim().length > 0) return false;
    this.editorState.removeBlocks([blockId]);
    this.rerenderPageWithEdits(block.page);
    return true;
  }

  deleteLikeThis(block: TextBlock): void {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    // The destructive twin of selectLikeThis, so it resolves the category the
    // same way the screen paints it — a delete that reached blocks the user was
    // looking at as body text would be far worse than a selection that did.
    const categoryId = block.category_id;
    const deleted = this.deletedBlockIds();
    const blocksToDelete = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id));

    if (blocksToDelete.length === 0) return;

    // Get affected pages before deletion
    const affectedPages = new Set(blocksToDelete.map(b => b.page));

    this.landBlockDeletions(
      this.editorState.deleteBlocks(blocksToDelete.map(b => b.id)), true);
    this.editorState.clearSelection();

    // Re-render affected pages to remove deleted content
    for (const pageNum of affectedPages) {
      this.rerenderPageWithEdits(pageNum);
    }
  }

  // ─── Category correction ────────────────────────────────────────────────

  onSetBlockCategory(event: { blockIds: string[]; categoryId: string }): void {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here

    // Unlabel is not a category: it deletes the corrections, so the blocks
    // save as unjudged (missing key in labels.json) and render unpainted.
    if (event.categoryId === UNLABEL_CATEGORY) {
      this.editorState.clearCategoryCorrections(event.blockIds);
      return;
    }

    this.ensureCategoryDefined(event.categoryId);

    // With a working document the category IS the annotation's one field, so the
    // relabel goes into the PDF and the mirror paints what came back. The
    // corrections map is not written alongside it: a second record of the same
    // fact is the override layer this pipeline deleted.
    if (this.blockLayerRead()) {
      for (const id of event.blockIds) this.documentBlocks.relabel(id, event.categoryId);
      return;
    }

    if (event.blockIds.length === 1) {
      this.editorState.setCategoryCorrection(event.blockIds[0], event.categoryId);
    } else {
      this.editorState.setBulkCategoryCorrections(
        event.blockIds.map(id => ({ blockId: id, categoryId: event.categoryId }))
      );
    }
  }

  /**
   * Register a category on the document if it is not there yet.
   *
   * The viewer resolves a block's colour by looking its category up in
   * `categories()`, so a correction naming one the document does not define
   * paints nothing at all — see `applyCorrectionsWithCategories`.
   */
  private ensureCategoryDefined(categoryId: string): void {
    if (this.categories()[categoryId]) return;
    const catInfo = this.autoDetectedCategoryList().find(c => c.id === categoryId);
    if (!catInfo) return;
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


  /**
   * The run key for this document, shared with the foundry OCR pipeline.
   *
   * THE FILE ON SCREEN, and nothing else. `effectivePath()` is the document this
   * session actually analyzed and is painting — the override the version picker
   * chose, the library copy, the corpus book — so a run found under it is by
   * construction a reading of that document. It is stable across a reload (a
   * path is not minted per session), which is the property this key was chosen
   * for.
   *
   * Neither of the alternatives says that:
   *
   *  - `editorState.fileHash()` means two different things on the two load
   *    paths. From `loadPdf` it is the hash of the file being shown; from
   *    `loadProjectFromPath` it is `manifest.source.fileHash`, the PROJECT's
   *    original, which is not the file being shown when a derived version was
   *    opened.
   *  - `pdfPath()` is documented as "original path (for display)" and is set to
   *    `project.source_path` no matter which version was loaded, so it names the
   *    source PDF even while the export EPUB is on screen.
   *
   * That is exactly how opening a project's export EPUB came up wearing the
   * source PDF's blocks: the key resolved to the PDF's archive path, the
   * PDF's finished run was found under it, and 17 pages of PDF-geometry OCR
   * blocks (JSTOR cover page included) were painted over the EPUB's reflowed
   * pages — with every manifest guard doing its job, because the manifest was
   * never the leak (Aug 3 2026).
   *
   * It is also the value main already expects: the OCR dialog submits
   * `{ bookKey, sourcePath: effectivePath() }` and `processing-passes` falls
   * back to `config.pdfPath` when no bookKey is given, so "the run key is the
   * path of the document the run reads" is the contract on both sides.
   */
  private detectBookKey(): string {
    return this.effectivePath() || 'unknown';
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
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    if (this.deletedBlockIds().has(blockId)) return;

    // Get the block's page before deletion
    const block = this.editorState.getBlock(blockId);
    const pageNum = block?.page;

    this.landBlockDeletions(this.editorState.deleteBlocks([blockId]), true);

    // Re-render the page to remove deleted content
    if (pageNum !== undefined) {
      this.rerenderPageWithEdits(pageNum);
    }
  }

  // ─── Split Block Popover ────────────────────────────────────────────────────

  async onSplitBlockRequest(block: TextBlock): Promise<void> {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
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
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
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
    // One history entry can restore a crop's worth of blocks, a class of them
    // and a page at once, so what an undo means to the document is the
    // difference it just made — taken here, before anything else writes.
    this.reconcileDeletionsWithDocument();

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
    this.reconcileDeletionsWithDocument();

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
    // User can press Delete to toggle deletion state.
    // Category resolved the way the viewer paints it (block.category_id), and
    // the row's own count resolves the same way — a row that says 12 and selects
    // 9 would just relocate the divergence this fix exists to remove.
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

  /**
   * The blocks a page-wide gesture acts on.
   *
   * Shared by "select all on page" and by page marking, because they are the
   * same idea of what "this page" contains — and because the exclusion below is
   * the kind of thing that gets fixed in one place and not the other.
   */
  private blocksOnPage(pageNum: number): TextBlock[] {
    const deleted = this.deletedBlockIds();
    const dims = this.pageDimensions()[pageNum];
    const pageArea = dims ? dims.width * dims.height : 0;

    return this.blocks().filter(b => {
      if (b.page !== pageNum || deleted.has(b.id)) return false;
      // Skip the full-page scan behind everything. The viewer already refuses
      // to select it directly, but this path swept it in — which is how a
      // "[Image 612x792]" block ends up categorized as a quote when you select
      // a page and assign it in one keystroke.
      if (b.is_image && pageArea > 0 && b.width * b.height > pageArea * 0.7) return false;
      return true;
    });
  }

  // Select all blocks on a specific page
  selectAllOnPage(pageNum: number): void {
    // Add to existing selection
    const existing = new Set(this.selectedBlockIds());
    for (const block of this.blocksOnPage(pageNum)) existing.add(block.id);
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

  // ─── Page-level marking (label mode, corpus books) ──────────────────────
  //
  // Corpus-only because labels.json is the only file that carries the marks.
  // Offering the gesture on a library project would label the page and then
  // drop the record of having done it, which is worse than not offering it.

  readonly canMarkPageTypes = computed(() =>
    this.labelMode() && this.corpusMode() && !this.curationLocked());

  /**
   * The book's modal body type size — what the speck floor is measured against.
   *
   * A computed so the whole-book pass runs on the gesture that needs it and not
   * once per block edit, and so it is recomputed when the blocks change.
   */
  private readonly pageTypeModalFontSize = computed(() =>
    bookModalFontSize(this.blocks(), this.pageDimensions()));

  /**
   * Declare a whole page a title page or a copyright page.
   *
   * The labels go through `setBulkCategoryCorrections` — one history entry, so
   * one undo takes the whole page back — and overwrite whatever was there: the
   * gesture is the judgement, and undo is the way out of a misfire.
   */
  async onMarkPageType(event: { pageNum: number; pageType: CorpusPageType }): Promise<void> {
    if (!this.canMarkPageTypes()) return;
    const { pageNum, pageType } = event;
    const name = CORPUS_PAGE_TYPE_NAMES[pageType];
    const marks = this.editorState.pageTypes();

    // Marked as this already: the gesture becomes the way to take it back.
    if (marks.get(pageNum) === pageType) {
      const choice = await this.electronService.showConfirmDialog({
        title: `Clear the ${name} mark?`,
        message: `Page ${pageNum + 1} is marked as the ${name}.`,
        detail: 'The labels on its blocks stay exactly as they are — they are your judgements '
          + 'now. Only the record that this page was marked is removed.',
        confirmLabel: 'Clear the mark',
        cancelLabel: 'Keep it',
        type: 'question',
      });
      if (choice.confirmed) this.editorState.setPageType(pageNum, null);
      return;
    }

    // A heads-up, not a gate: part dividers are title pages too, so a book
    // legitimately carries several.
    const others = [...marks.entries()]
      .filter(([page, type]) => type === pageType && page !== pageNum)
      .map(([page]) => page + 1)
      .sort((a, b) => a - b);
    if (others.length > 0) {
      const choice = await this.electronService.showConfirmDialog({
        title: `Another page is already the ${name}`,
        message: others.length === 1
          ? `Page ${others[0]} is already marked as the ${name}.`
          : `Pages ${others.join(', ')} are already marked as the ${name}.`,
        detail: 'Part dividers are title pages too, so more than one is often right. Marking '
          + 'this page as well leaves the others alone.',
        confirmLabel: `Mark page ${pageNum + 1} too`,
        cancelLabel: 'Cancel',
        type: 'info',
      });
      if (!choice.confirmed) return;
    }

    const pageBlocks = this.blocksOnPage(pageNum);
    if (pageBlocks.length === 0) {
      this.showAlert({
        title: 'Nothing to mark',
        message: `Page ${pageNum + 1} has no blocks, so there is nothing to label as a ${name}.`,
        type: 'warning',
      });
      return;
    }

    let entries: Array<{ blockId: string; categoryId: string }>;
    try {
      entries = planPageTypeLabels(pageType, pageBlocks, this.pageTypeModalFontSize());
    } catch (err) {
      this.showAlert({
        title: `Could not mark page ${pageNum + 1}`,
        message: (err as Error).message
          + '\n\nSpecks are told from type by the book\'s body type size, so nothing was labelled.',
        type: 'error',
      });
      return;
    }

    for (const categoryId of new Set(entries.map(e => e.categoryId))) {
      this.ensureCategoryDefined(categoryId);
    }
    this.editorState.setBulkCategoryCorrections(entries);
    this.editorState.setPageType(pageNum, pageType);
  }

  // Scroll to a specific page (used by timeline)
  scrollToPage(pageNum: number): void {
    this.currentPageIndex.set(pageNum);
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
   * /Volumes/Callisto/training/rubric/<basename>/. For a corpus book that mapping
   * is the identity — the corpus folder IS <trainingRoot>/<slug> — so the
   * snapshot, correction-log and dataset writers all land in the book's own
   * folder without knowing corpus mode exists.
   */
  private trainingProjectDir(): string | null {
    return this.corpusPath() || this.projectDir() || null;
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
   * The labels exactly as they last came off disk — loaded, or written by a save.
   *
   * The baseline for "what has this session changed": the corrections map is the
   * whole label set, so without something to diff against there is no way to
   * tell a label the user just added from one that was already in labels.json.
   * That difference is the entire content of a carry-over after a forced reload.
   */
  private corpusBaselineLabels = new Map<string, string>();

  /** Guards against a second file-changed event landing mid-reload. */
  private corpusReloading = false;

  /**
   * Main is polling the file this session was loaded from; act the moment it
   * changes.
   *
   * A MODAL with one action, deliberately. The failure this exists to kill is a
   * session that stayed open for hours against a labels.json some other tool had
   * already rewritten: every label added after that names a block id the file no
   * longer has, and the save guard refuses the lot at the end. A toast would be
   * the same failure with a notification on top of it, and an "keep editing"
   * button would be an option to go on producing labels that cannot be saved —
   * which is the bug, not a choice.
   */
  private readonly corpusFileWatcher = (() => {
    const unsubscribe = this.electronService.onCorpusFileChanged((change) => {
      void this.onCorpusFileChangedExternally(change);
    });
    this.destroyRef.onDestroy(() => {
      unsubscribe();
      // Window teardown stops the poll on main's side too, but a picker that is
      // destroyed while its window lives on (navigating away) would otherwise
      // leave main statting a file nobody is looking at.
      if (this.corpusMode()) void this.electronService.corpusUnwatch();
    });
  })();

  /**
   * The label edits this session has made and not yet written.
   *
   * A null category is a deletion — clearing a label is a real edit to the
   * corpus (it means "unjudged, never trains"), so it carries across a reload
   * like any other.
   */
  private pendingCorpusLabelEdits(): Array<{ blockId: string; categoryId: string | null }> {
    const current = this.editorState.categoryCorrections();
    const edits: Array<{ blockId: string; categoryId: string | null }> = [];
    for (const [blockId, categoryId] of current) {
      if (this.corpusBaselineLabels.get(blockId) !== categoryId) edits.push({ blockId, categoryId });
    }
    for (const blockId of this.corpusBaselineLabels.keys()) {
      if (!current.has(blockId)) edits.push({ blockId, categoryId: null });
    }
    return edits;
  }

  /**
   * The file under this session was rewritten: say so, reload it, and carry the
   * unsaved labels that still have a block to sit on.
   *
   * Carried edits are RE-APPLIED, never remapped: a block id is the only thing
   * that identifies a block, and guessing which merged unit a swallowed id
   * became would be inventing labels. What cannot be carried is named, with its
   * text where the old snapshot still has it, so the user can redo those few by
   * hand instead of discovering the hole later.
   */
  private async onCorpusFileChangedExternally(change: CorpusFileChanged): Promise<void> {
    const book = this.corpusBook();
    if (!book || change.dir !== book.dir || this.corpusReloading) return;
    this.corpusReloading = true;
    try {
      const pending = this.pendingCorpusLabelEdits();
      // Taken BEFORE the reload: after it, the blocks that were swallowed are
      // exactly the ones whose text is no longer available anywhere.
      const textById = new Map(this.blocks().map(b => [b.id, b.text]));
      const fileName = change.file.split(/[/\\]/).pop() ?? change.file;

      await this.electronService.showMessageDialog({
        title: 'This book changed on disk',
        message:
          `${fileName} for ${change.slug} was rewritten on disk by another tool, so the blocks ` +
          'in this editor are no longer the blocks that file describes. The editor must reload it.',
        detail:
          `${change.detail}\n\n` +
          (pending.length > 0
            ? `Your ${pending.length} unsaved label change(s) will be carried onto the blocks that ` +
              'still exist; anything that cannot be carried is listed next.'
            : 'You have no unsaved label changes.'),
        type: 'warning',
        confirmLabel: 'Reload now',
      });

      const previous = this.corpusBook();
      await this.loadCorpusBook(book.dir);
      if (this.corpusBook() === previous) {
        // loadCorpusBook has already said why it failed. The blocks on screen
        // are still the stale ones, so labelling on them can only produce labels
        // the save guard will refuse — close the door on saving instead of
        // leaving the session looking healthy.
        this.corpusReadOnlyReason.set(
          `${fileName} was rewritten on disk and could not be re-read, so the blocks in this ` +
          'editor are not the ones that file describes. Nothing can be saved from this session. ' +
          'Close the window and reopen the book from the Training tab.'
        );
        return;
      }

      const universe = new Set(this.blocks().map(b => b.id));
      const carried = pending.filter(e => universe.has(e.blockId));
      const lost = pending.filter(e => !universe.has(e.blockId));

      const sets = carried
        .filter((e): e is { blockId: string; categoryId: string } => e.categoryId !== null)
        .map(e => ({ blockId: e.blockId, categoryId: e.categoryId }));
      const clears = carried.filter(e => e.categoryId === null).map(e => e.blockId);
      if (sets.length > 0) this.editorState.setBulkCategoryCorrections(sets);
      if (clears.length > 0) this.editorState.clearCategoryCorrections(clears);
      if (sets.length > 0 || clears.length > 0) this.applyCorrectionsWithCategories();

      const named = lost.slice(0, 5).map(e => {
        const text = (textById.get(e.blockId) ?? '').replace(/\s+/g, ' ').trim();
        return text ? `${e.blockId} — "${text.slice(0, 80)}"` : e.blockId;
      });
      await this.electronService.showMessageDialog({
        title: 'Reloaded from disk',
        message: pending.length === 0
          ? `${change.slug} was reloaded. There were no unsaved labels to carry over.`
          : `Carried over ${carried.length} unsaved label(s); ${lost.length} could not be carried ` +
            '(those blocks no longer exist).',
        detail: lost.length > 0
          ? named.join('\n')
            + (lost.length > named.length ? `\n…and ${lost.length - named.length} more` : '')
            + '\n\nThose labels are gone from this session and nothing was written for them. '
            + 'Nothing has been saved yet — press Save labels when you are done.'
          : (carried.length > 0
            ? 'Nothing has been saved yet — press Save labels when you are done.'
            : undefined),
        type: lost.length > 0 ? 'warning' : 'info',
      });
    } finally {
      this.corpusReloading = false;
    }
  }

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
    // A book with no snapshot has no labels on disk, so everything the session
    // produces is an unsaved change — an empty baseline is literally true.
    this.corpusBaselineLabels = new Map();
    // A fresh read: whatever made the LAST session unsavable is not this
    // session's fact until this session establishes it. Cleared before the
    // snapshot is applied, because applying it is what can set it again.
    this.corpusReadOnlyReason.set(null);
    if (session) this.applyCorpusSnapshot(book, session);


    // Open on the work that is actually available. With a snapshot on screen
    // that is labelling. Without one the only thing that can happen next is an
    // OCR pass — the Label panel would be a labelling UI over blocks the corpus
    // has never recorded — so go to OCR instead.
    //
    // Via the rail handler rather than `activatePanel`, because OCR is not a
    // panel: the rail entry opens the settings modal (see `onRailPanelClick`).
    // Going through it also means this cannot open a modal the rail forbids.
    if (session) {
      this.setNavTab('label');
    } else {
      this.onRailPanelClick('ocr');
    }
  }

  /**
   * A main-owned OCR run finished; take its result off disk.
   *
   * There is nothing to "receive" here. Under the old design the renderer held
   * every page and handed the pile over at the end, which is why losing the
   * window lost the work. Now blocks.json IS the run's output and this just
   * re-reads it — which also means a window that was closed for the whole run
   * gets the same result as one that watched it.
   *
   * Deliberately not `loadCorpusBook`: the PDF is already open, and re-loading
   * it would throw away the view for a file that has not changed.
   */
  async onCorpusOcrFinished(): Promise<void> {
    const current = this.corpusBook();
    if (!current) return;

    const result = await this.electronService.corpusLoad(current.dir);
    if (!result.success || !result.book) {
      this.showAlert({
        title: 'OCR finished, but the result could not be read back',
        message:
          (result.error || `Nothing was loaded from ${current.dir}.`)
          + '\n\nThe pages are on disk — reopen the book from the Training tab.',
        type: 'error',
      });
      return;
    }

    const book = result.book;
    this.corpusBook.set(book);
    if (book.session) {
      this.applyCorpusSnapshot(book, book.session);
      this.setNavTab('label');
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
    // The blocks on screen are the corpus book's own from here on, and nothing
    // may paint a working document's over them: a corpus book's ids are what its
    // labels.json is keyed to, and any other segmentation makes every label the
    // user then sets worthless. `workingDocumentRef` already refuses a corpus
    // book; this is the same statement said where the blocks are set.
    this.blockLayerRead.set(false);
    this.workingDocumentOpen.set(false);
    this.editorState.categoryCorrections.set(new Map(Object.entries(session.labels)));
    this.editorState.pageTypes.set(new Map(
      Object.entries(session.pageTypes ?? {}).map(([page, type]) => [Number(page), type])
    ));
    // What is on disk, so a later reload can tell this session's work apart from
    // the file's own contents.
    this.corpusBaselineLabels = new Map(Object.entries(session.labels));
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

  /**
   * The block universe Label mode is allowed to write labels against, restored
   * if something has replaced it — or `false`, meaning do not enter Label mode.
   *
   * A label is a (block id → category) pair and it is worth nothing unless the
   * id exists in the corpus book's own blocks.json, which is what labels.json is
   * keyed to and what training reads. Anything else on screen — a foundry run
   * that attached itself, with merged marker units sitting on ids the corpus has
   * never seen — is a universe whose labels the save guard refuses at the END of
   * the session, after the labelling is done.
   *
   * A book with no snapshot is a book that has been added and not yet OCR'd: the
   * PDF's own extraction is its universe, because no labels exist for a
   * different segmentation to orphan. That is the ONE case where the blocks on
   * screen are legitimately not the corpus book's own.
   */
  private ensureCorpusLabelUniverse(): boolean {
    const book = this.corpusBook();
    if (!book) {
      this.showAlert({
        title: 'Corpus book not loaded',
        message: `Nothing was loaded from ${this.corpusPath()}, so there is no block universe to `
          + 'label against. Reopen the book from the Training tab.',
        type: 'error',
      });
      return false;
    }

    if (!book.session) {
      if (this.blockLayerRead()) {
        this.showAlert({
          title: 'These are not this book\'s blocks',
          message: `${book.dir} has no OCR snapshot yet, and the blocks on screen came from a `
            + 'working document. Run OCR from the corpus book itself, so that the labels key to '
            + 'blocks the corpus records.',
          type: 'error',
        });
        return false;
      }
      return true;
    }

    const corpusIds = new Set((book.session.blocks as TextBlock[]).map(b => b.id));
    const intact = (): boolean => {
      const blocks = this.blocks();
      return blocks.length === corpusIds.size && blocks.every(b => corpusIds.has(b.id));
    };
    if (intact()) return true;

    // Something replaced the universe after the book was opened. Put the corpus
    // one back rather than refusing outright — the snapshot is in hand and the
    // labels are already keyed to it.
    console.warn('[corpus] the blocks on screen are not this book\'s; re-applying the snapshot');
    this.applyCorpusSnapshot(book, book.session);

    const blocked = this.corpusReadOnlyReason();
    if (blocked || !intact()) {
      this.showAlert({
        title: 'Cannot label this book',
        message: `The blocks recorded in ${book.dir} (${book.from}) could not be put back on `
          + `screen${blocked ? `: ${blocked}` : '.'}\n\nLabel mode is not available for this book — `
          + 'labelling anything else would produce labels for ids the corpus does not have.',
        type: 'error',
      });
      return false;
    }
    return true;
  }

  /**
   * Cmd+W with unsaved label edits: save, discard, or stay.
   *
   * There is ALWAYS a way out. A save can refuse for reasons no amount of
   * clicking will change — the commonest is a book whose editor blocks are
   * foundry ids while its labels.json speaks the Tesseract labelling ids, which
   * the segmentation guard rejects — and offering only "save and close" then
   * traps the user in the window: every close loops save → fail → stay. So a
   * failed save is followed by an explicit discard-and-close, which writes
   * nothing and abandons the edits in memory.
   */
  private async confirmCloseCorpusBook(): Promise<void> {
    const labelCount = this.editorState.categoryCorrections().size;
    const choice = await this.electronService.showConfirmDialog({
      title: 'Save labels before closing?',
      message: `${labelCount} labels are in this book, and your `
        + 'changes have not been written yet.',
      detail: 'Corpus books are not saved automatically.',
      confirmLabel: 'Save and close',
      cancelLabel: 'Keep editing',
      type: 'warning',
    });
    if (!choice.confirmed) return;

    const failure = await this.saveCorpusLabels();
    if (!this.hasUnsavedChanges()) {
      this.exitRequested.emit();
      return;
    }

    // Two dialogs rather than three buttons because the dialog service takes
    // exactly two, and inventing a third would mean new dialog infrastructure
    // for one prompt.
    const discard = await this.electronService.showConfirmDialog({
      title: 'Labels could not be saved',
      message: `The save failed, so closing now loses your changes to all ${labelCount} `
        + 'labels in this book. Nothing will be written to labels.json.',
      detail: failure ?? 'The save reported no reason.',
      confirmLabel: 'Discard changes and close',
      cancelLabel: 'Keep editing',
      type: 'warning',
    });
    if (!discard.confirmed) return;
    // Only the dirty flag is cleared — no write, and the corpus book on disk is
    // exactly as it was before the session.
    this.editorState.markSaved();
    this.exitRequested.emit();
  }

  /**
   * Write the labels back to the corpus book's own labels.json.
   *
   * Explicit, because there is no autosave in corpus mode: the corpus is the
   * project's most expensive artifact and a background write over it — on a
   * book that may have loaded wrong — is not something to do on a timer.
   *
   * Returns the reason the save refused, or null when it wrote. The reason is
   * already on screen as an alert; it is RETURNED as well so the close guard can
   * repeat it next to the discard choice instead of asking the user to remember
   * a dialog they just dismissed.
   */
  async saveCorpusLabels(): Promise<string | null> {
    const book = this.corpusBook();
    if (!book) return 'No corpus book is open.';

    const blocked = this.corpusReadOnlyReason();
    if (blocked) {
      this.showAlert({ title: 'Not saved', message: blocked, type: 'error' });
      return blocked;
    }

    const labels = Object.fromEntries(this.editorState.categoryCorrections());
    // The fingerprint travels with the write: main refuses it if the file has
    // moved on since this session read it, and says so as the cause rather than
    // leaving the id guard to report it as a segmentation mismatch.
    // Always sent, empty map included: that is how the last page mark in a book
    // is cleared from the file rather than surviving as a stale entry.
    const pageTypes = Object.fromEntries(
      [...this.editorState.pageTypes()].map(([page, type]) => [String(page), type])
    );
    const result = await this.electronService.corpusSaveLabels(book.dir, {
      labels,
      labelSet: this.autoDetectedCategoryList().map(c => c.id),
      pageTypes,
    }, book.fingerprint);

    if (!result.success || !result.result) {
      const reason = result.error || 'Writing labels.json failed. Nothing was changed.';
      this.showAlert({
        title: 'Could not save labels',
        message: reason,
        type: 'error',
      });
      return reason;
    }

    const { path: written, labelCount, added, changed, removed, fingerprint } = result.result;
    // The file this session is pinned to is now the one it just wrote — both for
    // the next save's check and for the poll, which main has already retargeted.
    this.corpusBook.set({ ...book, fingerprint });
    this.corpusBaselineLabels = new Map(Object.entries(labels));
    this.editorState.markSaved();
    // `removed` is stated rather than left implicit: clearing a label is a real
    // edit to the corpus and the count is how the user notices an accident.
    this.showAlert({
      title: 'Labels saved',
      message:
        `${labelCount} labels in this book — ${added} added, ${changed} changed, ${removed} removed.` +
        `\n\n${written}`,
    });
    return null;
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
   * /Volumes/Callisto/training/rubric/ are history: hand-labelling work that was
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
   * /Volumes/Callisto/training/rubric/ stays exactly as it is — it is the original
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
          await this.exportToAudiobook();
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

    // The book itself. Reflow reads the working document and writes
    // `<Original>.epub` into the project, named after the book from birth —
    // there is no blob to hand the browser and no filename to invent here.
    this.loadingText.set('Building the book...');
    const epubPath = await this.reflowToEpub();
    this.showAlert({
      title: 'Book built',
      message: `Written to ${epubPath}`,
      type: 'success',
    });
  }

  /**
   * Export to Audiobook Producer.
   *
   * There used to be a text-only arm here (pdftotext → ebook-convert →
   * `library:copy-to-queue`), but the queue folder it wrote is a pre-manifest
   * layout nothing reads — it reported success and produced nothing a user
   * could find. Deleted Aug 3 2026 along with the handler; text-only remains
   * available as a plain EPUB file export.
   */
  private async exportToAudiobook(): Promise<void> {
    this.loadingText.set('Preparing audiobook export...');

    // EPUB source: edit the book's own markup instead of rebuilding it from block
    // text, exactly as finalizeProject() and Build the book do. Same
    // destination either way — the book-named export recorded in
    // manifest.outputs.epub — and the same navigation to the producer that
    // navigateAfter: true gives below.
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

    // Everything else IS Reflow. The book it writes is the one the producer
    // takes: `<Original>.epub`, in the project, named after the book.
    const epubPath = await this.reflowToEpub();
    console.log('[exportToAudiobook] Reflow wrote', epubPath);
    await this.router.navigate(['/studio']);
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
        // A book that is not an EPUB already has exactly one book made of it,
        // and Reflow names and places it: `<Original>.epub` in the project. So
        // Save As here is Reflow, and it says where the file went rather than
        // asking the user to choose a location it would then not be found at.
        const epubPath = await this.reflowToEpub();
        result = { success: true, message: `Written to ${epubPath}`, epubPath };
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

    // Finalize requires a project - we never modify original source files
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

    // EPUB source: edit the book's own markup instead of rebuilding it.
    //
    // This is not a second exporter. Reflow makes a book out of a PDF's text
    // layer and annotations; there is no PDF here, and the file the user opened
    // is the ALIGNMENT BASELINE — every block id in the edit set was resolved
    // against its bytes. So the book's own XHTML is edited in place, in main,
    // and the canonical export is the target. Save As is how the user writes a
    // preserved EPUB anywhere else.
    try {
      const result = this.useEpubPreservingExport()
        ? await this.runEpubPreservingExport(projectPath, null)
        : { success: true, message: '', epubPath: await this.reflowToEpub() };

      if (result.success && result.epubPath) {
        this.finalized.emit({ success: true, epubPath: result.epubPath });
        this.showAlert({
          title: 'Saved',
          message: result.message || `Exported to ${result.epubPath}`,
          type: 'success',
        });
      } else {
        // The exporter names the block that blocked the export — verbatim.
        this.finalized.emit({ success: false, error: result.message });
        this.showAlert({ title: 'Save Failed', message: result.message, type: 'error' });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.finalized.emit({ success: false, error: errorMessage });
      this.showAlert({ title: 'Save Failed', message: errorMessage, type: 'error' });
    } finally {
      this.loading.set(false);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  // The ladder: walking it, and the buttons on each rung
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A stage for this project finished — anywhere. Re-measure, then maybe follow.
   *
   * "Open when finished" is no longer this component's promise to keep: it is
   * held in main, keyed by project and station, and taken here once the
   * documents have been re-measured (`payOpenWhenFinished`). The old version
   * lived entirely in this handler, which meant the checkbox paid out only for a
   * user who had stayed in the picker and watched — the one case where it was
   * not needed. `stage` is still what re-measures, because a stage that landed
   * changed this book whether or not anybody is following it.
   */
  private async onProjectStageFinished(stage: string): Promise<void> {
    const projectDir = this.projectPath();
    if (!projectDir) return;

    // The measurement first, always: the tabs are what the documents say, and a
    // stage that landed changed them whether or not anybody is following it.
    // Both measurements, because a reflow moves the second one and a cast the
    // first, and this handler does not know which stage it is being told about
    // until the line below.
    //
    // `refreshState` throws for a project with no PDF original — main refuses to
    // resolve a working document for a book — and that is an ordinary state for
    // exactly the books whose stages this handler cannot be about. So it is
    // asked for separately and its refusal does not stop the book measurement.
    try {
      await this.documentBlocks.refreshState();
    } catch (err) {
      console.info('[document] this project has no working document to re-measure:', err);
    }
    await this.refreshBookEpub();

    // Re-read the project directory: two awaits have passed, and the window may
    // have been pointed at another book in the meantime.
    if (this.projectPath() !== projectDir) return;
    await this.payOpenWhenFinished();
  }

  /**
   * Why a station cannot be opened, or null. The tab's tooltip IS this.
   *
   * Every sentence names where the button is, and never names a button that
   * would refuse the user when they got there — which is the whole reason the
   * Working station distinguishes "not yet" from "this book never has one".
   */
  private stationAbsenceReason(id: StationId, book: BookDocuments): string | null {
    if (stationPresence(id, book) === 'present') return null;
    // "Build the book" is on the Working station for a cast book and on the
    // Archive station for one that has no working copy to build FROM. Said once,
    // here, so no sentence can point at the wrong tab.
    const buildStation = book.hasPdfOriginal ? 'Working' : 'Archive';
    switch (id) {
      case 'archive':
        return null;  // A book on screen has an original, by construction.
      case 'working':
        return book.hasPdfOriginal
          ? 'There is no working copy yet — press OCR / Cast on the Archive station.'
          : 'This book arrived as an EPUB, so it has no working PDF to curate through. '
            + 'It is curated on the book itself, at the Archive station.';
      case 'epub': {
        const failure = this.bookEpubError();
        // "We could not ask" beats "it is not there": one is a fault in the
        // project, the other is an ordinary book before its first build, and
        // reporting the second for the first would send the user to press a
        // button that fails the same way.
        if (failure) return failure;
        return `This book has not been built yet — press Build the book on the ${buildStation} station.`;
      }
      case 'tts':
        return 'Narration reads the book, and there is not one yet — press Build the book on the '
          + `${buildStation} station.`;
    }
  }

  /**
   * Show a station's artifact.
   *
   * Archive and Working are the same pages with and without the annotations
   * painted (see `stationBlocks`), so switching between them changes no file.
   * The EPUB is a different document and is loaded; coming back from it reloads
   * the project, because the picker curates the PDF and not the book.
   */
  async openStation(id: StationId): Promise<void> {
    // The guard is on the GESTURE, not on the move. A user switching tabs while
    // a stage writes into the document would be reading a file that is changing
    // under them; the app following a run it was asked to follow happens after
    // the stage has stopped, and has its own way in (`goToStation`).
    if (this.stationBusy()) return;
    await this.goToStation(id);
  }

  /** Show a station, whether or not the window is otherwise busy. */
  private async goToStation(id: StationId): Promise<void> {
    const at = this.viewedStation();
    if (id === at) return;

    if (id === 'tts') {
      this.handOffToNarration();
      return;
    }

    if (id === 'epub') {
      const epubPath = this.stationEpubPath();
      if (!epubPath) {
        // Unreachable through the tab (it is disabled without an EPUB), and
        // stated rather than ignored if some other caller gets here: a station
        // that silently does nothing is indistinguishable from a broken one.
        this.showAlert({
          title: 'There is no book yet',
          message: 'Build the book on the Working station first — the EPUB station shows the file it writes.',
          type: 'warning',
        });
        return;
      }
      await this.showEpubStation(epubPath);
      return;
    }

    // Back to the PDF stations. Only a reload when the EPUB is what is on
    // screen; otherwise this is purely which overlay is painted.
    if (at === 'epub' || at === 'tts') {
      await this.reloadProjectDocument();
    }
    this.viewedStation.set(id);
  }

  /** Load the project's book and stand at the EPUB station. */
  private async showEpubStation(epubPath: string): Promise<void> {
    this.loading.set(true);
    this.loadingText.set('Opening the book...');
    try {
      // The tab is dropped first because `loadPdf` refuses a document that is
      // already open, and `stationSwapping` is what keeps the close-then-open
      // from being read as the user leaving the project.
      const currentDocId = this.activeDocumentId();
      if (currentDocId) {
        this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
      }
      this.stationSwapping = true;
      this.closePdf();
      await this.loadPdf(epubPath);
      this.activatePanel(null);
      this.viewedStation.set('epub');
    } catch (error) {
      this.showAlert({
        title: 'Could not open the book',
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    } finally {
      this.stationSwapping = false;
      this.loading.set(false);
    }
  }

  /** Put the project's own document back on screen after the EPUB was shown. */
  private async reloadProjectDocument(): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;
    this.loading.set(true);
    this.loadingText.set('Reloading the document...');
    try {
      const currentDocId = this.activeDocumentId();
      if (currentDocId) {
        this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
      }
      this.stationSwapping = true;
      this.closePdf();
      await this.openTarget(dir);
      this.activatePanel(null);
    } catch (error) {
      this.showAlert({
        title: 'Could not reopen the document',
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    } finally {
      this.stationSwapping = false;
      this.loading.set(false);
    }
  }

  /**
   * The project's book, absolute, or null when it has never been built.
   *
   * The same signal the EPUB station's presence is measured by, so the tab
   * cannot be live while the file it would open is unknown.
   */
  private stationEpubPath(): string | null {
    return this.bookEpubPath();
  }

  /**
   * Next. Pure navigation — it never starts work.
   *
   * When it is locked it does nothing at all, because the sentence explaining
   * why is already on the button and beneath the bar. A Next that ran the
   * missing step would be the wizard again, one press further along.
   */
  async stationNext(): Promise<void> {
    const step = this.stationNextStep();
    if (step.lockedReason !== null || step.next === null) return;
    await this.openStation(step.next);
  }

  /**
   * Hand the finished book on. The studio host owns what happens next.
   *
   * The contract is unchanged from the wizard it replaces — `finalized` with the
   * path of the book on disk — so the destination is Phase C's business and not
   * this component's.
   */
  private handOffToNarration(): void {
    const epubPath = this.stationEpubPath();
    if (!epubPath) return;
    // The window holds no unsaved book state: every curation edit is already an
    // incremental update in the working document, and the EPUB on disk is what
    // reflow wrote.
    this.editorState.hasUnsavedChanges.set(false);
    this.viewedStation.set('tts');
    this.finalized.emit({ success: true, epubPath });
  }

  /** A station button was pressed. Each one belongs to the artifact on screen. */
  onStationAction(actionId: string): void {
    switch (actionId) {
      case 'cast':
        this.showOcrSettings.set(true);
        return;
      // Detect from the Archive station is the SAME detect. It is offered here
      // because a user standing on the original may want to re-read the labels
      // without walking to the Working tab first — and it is disabled by name
      // when the book has no working copy, because the dialog no longer buys one
      // on the way past.
      case 'detect-from-archive':
      case 'detect':
        void this.runDetect();
        return;
      case 'reflow':
        this.requestBuildTheBook();
        return;
      case 'footnotes':
        void this.enqueueEpubPass({ kind: 'footnotes' });
        return;
      case 'simplify':
        this.passOptionsKind.set('simplify');
        return;
      case 'translate':
        this.passOptionsKind.set('translate');
        return;
      default:
        throw new Error(`The station bar offered an action this window does not know: ${actionId}`);
    }
  }

  /**
   * Build the book, after making sure chapters were not simply forgotten.
   *
   * The check is a warning, not a gate: an article or a single essay really is
   * one chapter, and a hard block would strand those books. But an unchaptered
   * book produces one enormous audiobook file with no navigation, and that is
   * discovered hours later at TTS time — so it is worth one interruption here.
   */
  private requestBuildTheBook(): void {
    if (this.stationBusy()) return;

    // Two kinds of book, two authorities, and neither stands in for the other. A
    // cast book's chapters ARE its `chapter` blocks, read off the working
    // document. A book that arrived as an EPUB has no block layer at all — its
    // chapters are the ones read out of its own navigation, and those are what
    // the markup-preserving export carries through.
    const count = this.buildsByPreservingMarkup()
      ? this.chapters().length
      : this.documentBlocks.chapterBlocks().length;
    if (count >= CHAPTERS_EXPORT_MINIMUM) {
      void this.buildTheBook();
      return;
    }

    this.alertModal.set({
      title: count === 0 ? 'No chapters marked' : 'Only one chapter marked',
      message:
        (count === 0
          ? 'This book has no chapter markers, so the audiobook will be one continuous file with nothing to skip between.'
          : 'This book has a single chapter, so the audiobook will be one continuous file with nothing to skip between.') +
        '\n\nLabel the blocks that open each chapter and they appear in the Chapter tab.',
      type: 'warning',
      confirmText: 'Go to Chapters',
      cancelText: 'Build it anyway',
      // The modal closes itself around these (see onAlertConfirm/onAlertCancel).
      onConfirm: () => this.setNavTab('chapter'),
      onCancel: () => { void this.buildTheBook(); },
    });
  }

  /**
   * Build the book. TWO exporters, and which one runs is a fact about the
   * SOURCE rather than a preference.
   *
   *  - A book that arrived as an EPUB keeps its own markup. The
   *    markup-preserving export aligns the editor's view against
   *    `archive/<Original>.epub` and writes `source/<stem>.epub` with the
   *    deletions applied — which is how a table of contents, an index or a
   *    notes section is dropped from a book nobody ever wants narrated. Rebuilding
   *    such a book from block text would flatten every `<sup>`, `<em>` and list
   *    the file shipped with.
   *  - Everything else is Reflow: the working document in, the book out.
   *
   * Neither is a fallback for the other. The question they answer is what the
   * source is, and the source cannot be both.
   *
   * Two checkboxes decide how it is WATCHED and never what it does — except that
   * "run in background" has no meaning for the preserving export, which no queue
   * pass covers; that is said on the checkbox rather than silently ignored (see
   * `runInBackgroundRefusal`).
   */
  private async buildTheBook(): Promise<void> {
    const projectDir = this.projectPath();
    if (!projectDir) {
      this.showAlert({
        title: 'No project',
        message: 'Building the book writes into a project, and this document does not belong to one. '
          + 'Import it from Studio first.',
        type: 'error',
      });
      return;
    }

    // Before EITHER route, and for the same reason: reflow reads the working
    // document, so the paragraph consolidation has to be IN it before the stage
    // starts. Running it only on the foreground route would make "run in
    // background" a checkbox that changes the book — one line per paragraph in
    // the queued EPUB, none in the watched one — which is precisely what these
    // two options promise not to do.
    this.autoMergeForPipeline();

    if (this.buildsByPreservingMarkup()) {
      await this.buildPreservedBook(projectDir);
      return;
    }

    if (this.effectiveRunInBackground()) {
      // The batched edits are landed BEFORE the job is submitted. `reflow()`
      // flushes for the foreground route; nothing flushes for this one, and a
      // queue that reached the stage inside the batching window would reflow a
      // document that is missing the last few seconds of curation.
      await this.documentBlocks.flush();
      // Asked for before the run is submitted and held in MAIN, so it pays out
      // even after this window has been closed. Reflow mints the EPUB station.
      if (this.openWhenFinished()) {
        await this.electronService.documentRequestOpenWhenFinished(projectDir, 'epub');
      }
      // Queued rather than run here: one reflow pass over this project's
      // working document.
      const queued = await this.submitPassRun(projectDir, [{ kind: 'reflow' }]);
      // A refused run will never finish, so the promise it staged comes back off
      // the shelf rather than being cashed by whatever runs over this book next.
      if (!queued) await this.electronService.documentCancelOpenWhenFinished(projectDir);
      // The user asked to stop watching, so the window goes where the work went.
      if (queued) await this.handOffToQueue();
      return;
    }

    this.loading.set(true);
    this.loadingText.set('Building the book...');
    try {
      const epubPath = await this.reflowToEpub();
      await this.refreshBookEpub();
      if (this.openWhenFinished()) {
        await this.showEpubStation(epubPath);
      }
    } catch (error) {
      this.showAlert({
        title: 'The book was not built',
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The markup-preserving export: `archive/<Original>.epub` in, the deletions
   * applied, `source/<stem>.epub` out.
   *
   * The project is SAVED first, and that is not tidiness. An EPUB-native book's
   * deletions live in the project file — the editor's `deletedBlockIds` and
   * `deletedPages`, autosaved into the manifest — and the exporter re-applies
   * them against the archive original. Exporting before the save would export
   * the previous session's set: the book would come out missing the wrong
   * things, and look like a success.
   *
   * The archive original is READ and never written; the export lands in
   * `source/`, and main refuses outright to write onto the file the edits were
   * aligned against.
   *
   * An unaligned block that carries a deletion makes the exporter THROW rather
   * than quietly leave that block in the book. That property is the whole reason
   * this export can be trusted, and nothing here softens it — main's message
   * names the offending block and is passed through verbatim.
   */
  private async buildPreservedBook(projectDir: string): Promise<void> {
    this.loading.set(true);
    this.loadingText.set('Building the book...');
    try {
      await this.saveProjectToPath(projectDir, true);

      const result = await this.runEpubPreservingExport(projectDir, null);
      if (!result.success || !result.epubPath) {
        this.showAlert({
          title: 'The book was not built',
          message: result.message || 'The export did not report where the book was written.',
          type: 'error',
        });
        return;
      }

      // Main registered it in the manifest; this is asking main where it is,
      // which is what the EPUB station's presence is measured by.
      await this.refreshBookEpub();
      if (this.openWhenFinished()) {
        await this.showEpubStation(result.epubPath);
      } else {
        this.showAlert({ title: 'Built', message: result.message, type: 'success' });
      }
    } catch (error) {
      this.showAlert({
        title: 'The book was not built',
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Queue one text pass over this project's book.
   *
   * Footnote removal, Simplify and Translate all edit the EPUB in place and all
   * take minutes to hours, so there is no in-place variant of them: they go to
   * the queue, which is where a long job is watched and cancelled.
   */
  private async enqueueEpubPass(pass: ChainPassRequest): Promise<void> {
    const projectDir = this.projectPath();
    if (!projectDir) {
      this.showAlert({
        title: 'No project',
        message: 'A text pass rewrites the project\'s book, and this document does not belong to a project.',
        type: 'error',
      });
      return;
    }
    if (!await this.submitPassRun(projectDir, [pass])) return;
    this.showAlert({
      title: 'Queued',
      message: 'It runs when the queue reaches it. Watch it on the Queue tab.',
      type: 'success',
    });
  }

  /**
   * Submit passes to the queue, surfacing main's own refusal verbatim.
   *
   * Answers whether the run was QUEUED, because the caller has a promise to
   * withdraw if it was not — a refused run never finishes, and an
   * "open when finished" left standing would be cashed by whatever ran over this
   * book next.
   */
  private async submitPassRun(projectDir: string, passes: ChainPassRequest[]): Promise<boolean> {
    try {
      const result = await this.queueService.submitProcessingRun({ projectDir, passes });
      if (!result.success) {
        this.showAlert({
          title: 'That run was refused',
          message: result.error || 'The run was refused and no reason was given.',
          type: 'error',
        });
        return false;
      }
      return true;
    } catch (err) {
      this.showAlert({
        title: 'That run was refused',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
      return false;
    }
  }

  /**
   * The run went to the queue, and so does the user.
   *
   * RULED 2026-08-04: "if the user hits the process in background button, it
   * should move it to the queue and move focus from the current page (pdf
   * picker) to the main page and jump to the queue so they can see it was moved
   * there." A job that silently vanishes from one place and silently appears in
   * another is how work gets lost, so the hand-off is witnessed.
   *
   * The picker is its own BrowserWindow (`openEditorWindow` in main), and the
   * queue only ever lives in the MAIN window — `processing:submit-chain` sends
   * the plan there and nowhere else. So this raises that window and routes it,
   * which is the same action whether the picker is detached or embedded: main
   * knows which window is the main one, and this component does not have to.
   * The book is left open behind the user; they asked to stop watching a run,
   * not to shut the book.
   */
  async handOffToQueue(): Promise<void> {
    this.showOcrSettings.set(false);
    try {
      await this.electronService.showQueue();
    } catch (err) {
      // Said, never swallowed: the whole point of the hand-off is that the user
      // sees where the work went, so a hand-off that did not happen has to be
      // the one thing they are told about.
      this.showAlert({
        title: 'The run is queued, but this window could not follow it',
        message: (err instanceof Error ? err.message : String(err))
          + '\n\nThe run is in the queue and continues either way — open the main window\'s Queue '
          + 'tab to watch it.',
        type: 'warning',
      });
    }
  }

  /** The simplify/translate dialog is open for this pass, or null. */
  readonly passOptionsKind = signal<PassOptionsKind | null>(null);

  /**
   * Who runs a text pass: the provider and model set in Settings → Pipeline
   * Defaults, plus whatever credentials the AI settings hold.
   *
   * Read here rather than in the dialog so the dialog stays presentational, and
   * an empty model is passed through as an empty model — the dialog refuses it
   * by name, which is the only useful thing to do with "no model chosen".
   */
  readonly passAiChoice = computed<PassAiChoice>(() => {
    const kind = this.passOptionsKind();
    const defaults = this.settingsService.getPipelineDefaults();
    const ai = this.settingsService.getAIConfig();
    const provider = kind === 'translate' ? defaults.translateProvider : defaults.simplifyProvider;
    const model = kind === 'translate' ? defaults.translateModel : defaults.simplifyModel;
    return {
      provider,
      model,
      ...(ai.ollama?.baseUrl ? { ollamaBaseUrl: ai.ollama.baseUrl } : {}),
      ...(ai.claude?.apiKey ? { claudeApiKey: ai.claude.apiKey } : {}),
      ...(ai.openai?.apiKey ? { openaiApiKey: ai.openai.apiKey } : {}),
    };
  });

  onPassOptionsConfirmed(result: PassOptionsResult): void {
    this.passOptionsKind.set(null);
    void this.enqueueEpubPass(
      result.kind === 'simplify'
        ? { kind: 'simplify', simplify: result.simplify }
        : { kind: 'translate', translate: result.translate });
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
   * once inside the paragraph that swallowed it.
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


  /**
   * Save changes back to the source EPUB file.
   * Used when editing an EPUB directly (not via a project).
   */
  private async saveToSourceEpub(epubPath: string): Promise<void> {
    try {
      // Library mode only ever holds an ebook, so this is the markup-preserving
      // path with the user's chosen destination: the source book's own XHTML,
      // edited in main, written where they said. Rebuilding it from block text
      // would flatten every <sup>, <em> and list the file shipped with.
      const result = await this.runEpubPreservingExport(null, epubPath);

      if (result.success) {
        this.editorState.markSaved();
        this.finalized.emit({ success: true, epubPath });
        this.showAlert({ title: 'Saved', message: result.message, type: 'success' });
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
      'Its labels are saved to its own folder under /Volumes/Callisto/training/rubric/.'
    );
    return true;
  }

  private async autoCreateProject(pdfPath: string, pdfName: string): Promise<void> {
    if (this.refuseProjectWriteForCorpus('Create project')) return;

    const currentFileHash = this.fileHash();
    const currentLibraryPath = this.libraryPath();

    // Every project is a manifest directory. Bind to it so downstream saves and
    // exports use the manifest layout (source/exported.epub). Skipping this is
    // what let the editor mint a phantom single-file sibling and bind to that,
    // breaking "Generate & review" — hence no match-by-hash fallback here.
    const manifestMatch = await this.electronService.findManifestProjectBySource(
      currentFileHash,
      currentLibraryPath || pdfPath,
    );
    if (manifestMatch.found && manifestMatch.projectPath) {
      await this.restoreProjectState(manifestMatch.projectPath);
      return;
    }

    // No existing project → create a MANIFEST project. The
    // importer copies the source into archive/ and writes manifest.json; its
    // duplicate guard binds to an existing project if one already matches by hash.
    const created = await this.electronService.audiobookImportEpub(pdfPath);
    const createdDir = created.projectPath || created.existingProjectPath;
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
  /**
   * Is `docPath` the file this project's manifest records as its own export?
   *
   * Decided by the recorded PATH, never by a name: the export is named after the
   * book now, so `source/` holds nothing a pattern could pick out. Separators,
   * case and unicode form are normalized because the library is synced
   * Mac<->Windows and the two sides spell the same file differently.
   */
  private isProjectOwnExport(docPath: string, project: BookForgeProject): boolean {
    const recorded = project.exported_epub_path;
    if (!recorded || !docPath) return false;
    return this.samePathOnDisk(recorded, docPath);
  }

  /**
   * Do these two strings name the same file?
   *
   * ONE normalization, used everywhere the answer decides whether state may bind
   * to a document. Separators, case and unicode form are all normalized because
   * the library is Syncthing-synced Mac<->Windows and the two sides spell the
   * same file differently — a manifest written on macOS carries NFD where the
   * Windows directory entry is NFC.
   */
  private samePathOnDisk(a: string, b: string): boolean {
    if (!a || !b) return false;
    const norm = (p: string) => p.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    return norm(a) === norm(b);
  }

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

    // The project's own export is never the document its edits were made
    // against — they describe the source that PRODUCED it. Applying them here
    // paints the source session's deletions, page exclusions, chapters and OCR
    // blocks over the built book (the review swap's auto-save used to land
    // exactly here through autoCreateProject). Decided by the manifest's export
    // record, with no hash and no alert: the file it names is the editor's own
    // output by construction, and opening it is ordinary — the session is
    // simply bound read-only.
    const docPath = this.effectivePath() ?? '';
    if (this.isProjectOwnExport(docPath, project)) {
      console.log('[restoreProjectState] Document is the project\'s own export — source edits not applied.');
      this.projectStateNotApplied.set(true);
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = null;
      }
      if (this.chapters().length === 0 && docPath.toLowerCase().endsWith('.epub')) {
        this.tryLoadOutline();
      }
      return;
    }

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

        // Manual blocks are ADDED, never replaced in. They must land after the
        // OCR restore above, which wipes and rebuilds whole pages.
        if (project.manual_blocks && project.manual_blocks.length > 0) {
          this.editorState.addBlocks(project.manual_blocks);
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

    // The EPUB station shows a DERIVED artifact — the book reflow wrote — and
    // the manifest describes the SOURCE. An auto-save here either writes that
    // session's state (reflowed blocks, no deletions, no merges) over the
    // source's edit set, or, with the binding dropped by the document swap,
    // reaches autoCreateProject, rebinds to the owning project and pulls the
    // source's deletions, pages and OCR blocks onto the book (Working Towards
    // The Führer, Aug 2 2026 — both arms of this actually happened). The book
    // is edited by the EPUB passes, on disk, never through the project file.
    if (this.viewedStation() === 'epub') return;

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
    // Checked again at fire time: a save scheduled at the editing station can
    // reach this timer AFTER the export swapped the review EPUB in, and it
    // would run against the wrong document — see scheduleAutoSave.
    if (this.viewedStation() === 'epub') return;

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
    // save — finalizeProject, Build the book — still export: the export
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
    const ocrBlocks = this.blocks().filter(b => b.is_ocr && !b.is_manual);
    const manualBlocks = this.blocks().filter(b => b.is_manual);

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
      // The project file records deletions for the books that have no working
      // document. A book that HAS one carries them in the annotation, where the
      // exporter reads them from; this list is then a copy of it, and a copy is
      // what the line-id ledger existed to reconcile.
      deleted_block_ids: [...this.deletedBlockIds()],
      deleted_highlight_ids: this.deletedHighlightIds().size > 0 ? [...this.deletedHighlightIds()] : [],
      page_order: order.length > 0 ? order : [],
      block_edits: blockEditsRecord,
      remove_backgrounds: this.removeBackgrounds() || false,
      deleted_pages: [...this.deletedPages()],
      ocr_blocks: ocrBlocks.length > 0 ? ocrBlocks : undefined,
      manual_blocks: manualBlocks.length > 0 ? manualBlocks : undefined,
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

  /**
   * Open whatever `target` names — the ONE place that decides how.
   *
   * A target is either a PROJECT DIRECTORY (it holds a manifest.json, so the
   * project loader runs and the saved edits come with it) or a bare DOCUMENT
   * file (Studio opens a variant PDF that way, and the corpus/library paths
   * hand over files too). Handing a file to the project loader is an error by
   * design, which is why the fork exists at all.
   *
   * It lives here because two callers made the same decision independently —
   * ngOnInit's embedded load and pipelineReloadSource — and a fix to one of
   * them silently missed the other.
   *
   * There is no third case: a target that is neither a project nor a file that
   * exists is an ERROR NAMING THE PATH, never a quiet fall back to the project
   * directory (that is what turned a deleted `source/exported.epub` into "the
   * old PDF, repainted").
   */
  private async openTarget(target: string, lightweight: boolean = false): Promise<void> {
    if (await this.electronService.fsExists(`${target}/manifest.json`)) {
      await this.loadProjectFromPath(target, lightweight);
      return;
    }
    if (!(await this.electronService.fsExists(target))) {
      this.showAlert({
        title: 'File Not Found',
        message: `${target}\n\nThis file is no longer on disk, and it is not a project folder either. `
          + 'Nothing was opened.',
        type: 'error',
      });
      return;
    }
    await this.loadPdf(target, lightweight);
  }

  async loadProjectFromPath(filePath: string, lightweight: boolean = false): Promise<void> {
    // Clear sourceFilePath when opening a project - finalize must use the project export flow
    this.sourceFilePath.set(null);
    // A station swap is this window changing which artifact it shows, not the
    // user opening a different book, so it does not send the ladder home.
    if (!this.stationSwapping) this.viewedStation.set('archive');

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

    // Third, fall back to the project's own export — located by the manifest
    // record the adapter resolved, never by a name in source/.
    if (!pdfPathToLoad) {
      const exportedEpubPath = project.exported_epub_path;
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
      const exportedPath = project.exported_epub_path;
      this.showAlert({
        title: 'Source File Not Found',
        message: `Could not find any source file for this project.\n\nOriginal: ${project.source_name || project.source_path || 'not set'}\nExported: ${exportedPath || 'not set'}\n\nThe file may need to be imported to your library on this machine.`,
        type: 'error'
      });
      return;
    }

    // Judged by the manifest's export record, not by which resolution branch
    // produced it: the file it names is the editor's own output no matter who
    // handed it back, and treating it as the original applies the source
    // session's saved blocks and deletions to a document they were never made
    // against. (The main-process adapter once reported a project's export as its
    // source_path, which sailed through the isLoadingOriginal comparison —
    // this holds even if a resolver regresses that way again.)
    if (this.isProjectOwnExport(pdfPathToLoad, project)) {
      usingExportedEpub = true;
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
        // No alert for the project's own export: its hash NEVER matches the
        // source's (that is what being a derived output means), so warning
        // about it would fire on every deliberate open of exported.*.
        if (!usingExportedEpub) {
          this.showAlert({
            title: 'Edits Not Applied',
            message: this.PROJECT_STATE_NOT_APPLIED_MESSAGE,
            type: 'warning'
          });
        }
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
        // THE TAB IS TITLED AFTER THE FILE IT SHOWS. `source_name` is the
        // project's ORIGINAL document, so using it for a derived version (the
        // book-named export, a cleaned EPUB) titled the open EPUB with the
        // PDF's filename — which is most of why a correct export still read as
        // "I am looking at the PDF again" (Aug 3 2026).
        name: isLoadingOriginal ? (project.source_name || quickResult.pdf_name) : quickResult.pdf_name,
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
        // Undo/redo entries are edits recorded against the ORIGINAL's blocks
        // and pages. Binding them to a derived document (the export, a cleaned
        // EPUB) lets one Cmd-Z replay a PDF-session deletion onto a book that
        // never had those blocks — the same reason deletedBlockIds and crops
        // are gated. A version whose saved edits were not applied has no
        // history either.
        undoStack: applySavedEdits ? (project.undo_stack || []) : [],
        redoStack: applySavedEdits ? (project.redo_stack || []) : [],
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
        if (project.manual_blocks && project.manual_blocks.length > 0) {
          this.editorState.addBlocks(project.manual_blocks);
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
   * Activate a task panel (or `null` for the document nav), carrying the
   * migrated per-panel side effects. OCR has no side effect now — it is a real
   * panel, not a modal trigger.
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

    this.activePanel.set(id);
  }

  /**
   * Open a tab of the document nav.
   *
   * Choosing a tab closes whatever panel had taken over the pointer, because the
   * nav is where the pointer belongs — a Label tab you cannot click a block from
   * is a palette, not a mode.
   *
   * For a corpus book, Label may only open over the corpus book's OWN blocks,
   * and that is checked before anything changes so a refusal leaves the window
   * exactly as it was. A session's labelling is otherwise only discovered to be
   * worthless when the save is refused at the end of it.
   */
  setNavTab(tab: DocumentNavTab): void {
    if (tab === 'label' && this.corpusMode() && !this.ensureCorpusLabelUniverse()) return;
    this.navTab.set(tab);
    this.activatePanel(null);
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

    // Select owns no panel: choosing it closes whatever panel had taken over the
    // pointer, so the click does what it looks like it does.
    if (id === 'select') {
      this.setNavTab('select');
      return;
    }

    // OCR has no state worth parking in a side panel — the panel existed only
    // to host a "Run OCR…" button. Open the settings modal straight from the
    // rail instead of making the user cross the window to reach it.
    if (id === 'ocr') {
      this.showOcrSettings.set(true);
      return;
    }

    if (id === 'crop') {
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
    this.landBlockDeletions(this.editorState.clearCrop(pages), false);
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
    // A crop is a bulk deletion with a rectangle for a reason, so it lands in
    // the document as the deletions it made and nothing else — the rectangle
    // itself is the editor's record of how to reverse them.
    this.landBlockDeletions(this.editorState.applyCrop(entries, allToDelete), true);
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

  /**
   * Context-menu "Mark as chapter": label these blocks `chapter`.
   *
   * That is the whole of it now. A chapter is a block whose one category field
   * says so, so marking one is a relabel and nothing else — no marker to place,
   * no title to keep in step with the block under it, no anchor bookkeeping. The
   * Chapter tab lists what comes out.
   */
  onChapterFromBlocks(event: { blockIds: string[] }): void {
    if (event.blockIds.length === 0) return;
    this.onSetBlockCategory({ blockIds: event.blockIds, categoryId: 'chapter' });
    this.setNavTab('chapter');
  }

  removeChapter(chapterId: string): void {
    // With a working document the chapter IS the block, so removing it removes
    // the block — anything else would put the list and the page into
    // disagreement, and the derived list would win back on the next read anyway.
    if (this.blockLayerRead() && this.blocks().some(b => b.id === chapterId)) {
      this.deleteBlock(chapterId);
      if (this.selectedChapterId() === chapterId) this.selectedChapterId.set(null);
      return;
    }
    this.chapters.update(chapters => chapters.filter(c => c.id !== chapterId));
    if (this.selectedChapterId() === chapterId) {
      this.selectedChapterId.set(null);
    }
    this.editorState.markChanged();
  }

  renameChapter(event: { chapterId: string; newTitle: string }): void {
    // Same rule: renaming a chapter edits the block's annotation text, which IS
    // the title the book is built with. There is no second copy to update.
    if (this.blockLayerRead()) {
      const block = this.blocks().find(b => b.id === event.chapterId);
      if (block) {
        const title = event.newTitle.trim();
        if (title.length > 0 && title !== block.text) {
          this.documentBlocks.retitle(block.id, title);
        }
        return;
      }
    }
    this.chapters.update(chapters =>
      chapters.map(c =>
        c.id === event.chapterId
          ? { ...c, title: event.newTitle }
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

    const defaults = getDefaultConfig();
    const model = learnFromBreaks(
      blocks, manualBreaks, baselines, deletedIds, defaults.shortLineDeadZone);
    const config: DetectionConfig = {
      ...defaults,
      weights: model.weights,
      threshold: model.threshold,
    };

    const result = detectParagraphBreaks(blocks, model, baselines, deletedIds, chapterBlockIds, manualBreaks, config);

    this.editorState.setParagraphBreaks(result.breaks);
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
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    this.landPageToggle(this.editorState.togglePageDeletion([pageNum]));
  }

  /** Both arms of a page toggle, landed in the document as the toggle decided. */
  private landPageToggle(toggled: { deleted: number[]; restored: number[] }): void {
    this.landPageDeletions(toggled.deleted, true);
    this.landPageDeletions(toggled.restored, false);
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
      this.landPageDeletions(this.editorState.restorePages(deletedArray), false);
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
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    if (pages.size === 0) {
      // Clear selection
      this.selectedPageNumbers.set(new Set());
      return;
    }

    // Toggle page deletion (delete if not deleted, restore if all are deleted)
    const pageArray = [...pages];
    this.landPageToggle(this.editorState.togglePageDeletion(pageArray));

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

  // ───────────────────────────────────────────────────────────────────────────
  // The working document
  //
  // Curation reads and writes `<Original>.working.pdf` — the block layer is real
  // PDF annotations, and every relabel, deletion, merge and chapter title is an
  // incremental update appended to that file (docs/DOCUMENT_PIPELINE.md
  // §Curation). `DocumentBlocksService` is the whole of the data layer; what
  // lives here is the two ends of it: opening the document for the book on
  // screen, and turning the picker's gestures into edits on it.
  //
  // What this replaces is worth naming, because the shape of the bug it produced
  // was always the same. The run directory was a SECOND place a book's blocks
  // could live — one that had to be re-attached to a window, re-mapped onto
  // whatever ids the last blocks run happened to mint, and re-reconciled against
  // the deletions a project file remembered by line. Every one of those steps
  // could quietly disagree with the page in front of the user: a deletion
  // re-applied to a block it never named, an export routed through a run that had
  // read a different file, a title unit auto-discarded twice. There is one place
  // now, it is a file, and opening it in Acrobat shows exactly what the picker
  // shows.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The documents for the book on screen, or null when there are none.
   *
   * A working document is cast into a PROJECT directory and named after the
   * project's primary, so a book with no project has none — a corpus book (which
   * is deliberately not a project), a loose file opened from the library, a
   * review EPUB. That is a real state and not a missing value: those books are
   * edited through the editor's own block list and never through annotations, so
   * the affordances that need a document say so rather than guessing.
   */
  readonly workingDocumentRef = computed<DocumentRef | null>(() => {
    if (this.corpusMode()) return null;
    const projectDir = this.projectPath();
    if (!projectDir) return null;
    // The PDF, never whatever artifact is on screen. The EPUB station puts this
    // project's book in the viewer, and main refuses an EPUB here BY NAME ("the
    // document pipeline casts a working PDF from the book's original") — so a
    // ref built from the displayed file would tear the block layer down every
    // time the user looked at the book they had just built.
    const sourcePath = this.curatedPdfPath();
    return sourcePath ? { projectDir, sourcePath } : { projectDir };
  });

  /**
   * The project PDF this window curates.
   *
   * Tracked rather than read off the viewer because the two are different
   * questions — "which file am I looking at" and "which file are the documents
   * cast from" — and they stopped having the same answer the moment the EPUB
   * became a station you can stand on. Null is a real state: a project that
   * arrived as a book has no PDF, and main says exactly that when asked.
   */
  private readonly curatedPdfPath = signal<string | null>(null);

  private readonly curatedPdfEffect = effect(() => {
    const path = this.effectivePath();
    if (!path || !path.toLowerCase().endsWith('.pdf')) return;
    untracked(() => this.curatedPdfPath.set(path));
  });

  /**
   * True once main has answered about this book's documents at all.
   *
   * What it gates is the pipeline's own affordances — Detect, Reset — and those
   * are exactly what a book with no blocks YET still needs: every book starts
   * with no block layer, and Detect is how it stops. So this is deliberately not
   * "has blocks".
   */
  readonly workingDocumentOpen = signal(false);

  /**
   * True once a block layer has actually been read off the document.
   *
   * Separate from the flag above because the mirror below REPLACES the editor's
   * blocks and deletions with the document's. Running it against a document that
   * has not been detected yet would wipe a project's restored deletions with an
   * empty set — a book that has never been through Detect has nothing to say
   * about them, and saying nothing is not the same as saying none.
   */
  private readonly blockLayerRead = signal(false);

  /**
   * The annotations, painted.
   *
   * One-way, and deliberately so: the document is the authority, the editor's
   * block list is the view of it. The service applies every edit to its own copy
   * the moment it is made and re-reads from the file if the write is refused, so
   * this fires with the document's answer either way — there is no window in
   * which the screen shows an edit the PDF does not have.
   *
   * `untracked` around the write because the editor's own signals are what this
   * writes INTO; reading them as dependencies would make the effect its own
   * trigger. The blocks are painted with `replaceTextBlocksOnPages` rather than
   * assigned, because that is the call the viewer, the category statistics and
   * the correction map are all built around.
   */
  private readonly documentBlocksMirror = effect(() => {
    if (!this.blockLayerRead()) return;
    const blocks = this.documentBlocks.blocks();
    const deleted = this.documentBlocks.deletedBlockIds();
    const deletedPages = this.documentBlocks.deletedPages();
    untracked(() => {
      const pages = [...new Set(blocks.map(b => b.page))].sort((a, b) => a - b);
      this.editorState.replaceTextBlocksOnPages(pages, blocks);
      this.editorState.deletedBlockIds.set(new Set(deleted));
      this.editorState.deletedPages.set(new Set(deletedPages));
      this.editorState.updateCategoryStats();
    });
  });

  /**
   * A deletion, landed in the document, at the gesture that made it.
   *
   * Deletion is written the way a relabel is: the ids the user acted on, named,
   * the moment they acted. Nothing infers deletions by comparing the editor's
   * set against the document's afterwards — a comparison has no record of
   * intent, so it cannot tell a deletion the user has just made from one the
   * mirror has already painted over, and whichever way it reads the difference
   * it does so silently.
   *
   * The picker's own image blocks stay out. They are extraction state — the
   * document has never carried an annotation for one, so there is nothing there
   * to flag, and one of their ids in a batch would have the whole batch refused
   * alongside the text deletions it arrived with. That is a domain boundary,
   * not a fallback: any OTHER id the document does not carry still goes
   * through, and its refusal is news — `lastError` says so.
   */
  private landBlockDeletions(blockIds: readonly string[], deleted: boolean): void {
    if (!this.blockLayerRead()) return;
    for (const id of blockIds) {
      if (this.editorState.getBlock(id)?.is_image) continue;
      this.documentBlocks.setDeleted(id, deleted);
    }
  }

  /** A page struck out of the book, landed in the document. */
  private landPageDeletions(pages: readonly number[], deleted: boolean): void {
    if (!this.blockLayerRead()) return;
    for (const p of pages) this.documentBlocks.setPageDeleted(p, deleted);
  }

  /**
   * Bring the document's deletion flags back in line with the editor's, as one
   * delta.
   *
   * For undo and redo only, and called explicitly by them. An undo does not say
   * what it undid in terms the document understands — one entry can restore a
   * whole crop, a class of blocks and a page at once — so the honest reading is
   * the difference between the two sets, taken immediately, in the same handler,
   * before anything else can write to either.
   */
  private reconcileDeletionsWithDocument(): void {
    if (!this.blockLayerRead()) return;

    // The background toggle parks the picker's own image-block ids in
    // `deletedBlockIds`, and the document has no annotation for those — see
    // `landBlockDeletions` for the boundary. Without this skip, the first undo
    // after that toggle would sweep them into a batch and poison it.
    const wanted = this.editorState.deletedBlockIds();
    const landed = this.documentBlocks.deletedBlockIds();
    for (const id of wanted) {
      if (landed.has(id)) continue;
      if (this.editorState.getBlock(id)?.is_image) continue;
      this.documentBlocks.setDeleted(id, true);
    }
    for (const id of landed) if (!wanted.has(id)) this.documentBlocks.setDeleted(id, false);

    const wantedPages = this.editorState.deletedPages();
    const landedPages = this.documentBlocks.deletedPages();
    for (const p of wantedPages) {
      if (!landedPages.has(p)) this.documentBlocks.setPageDeleted(p, true);
    }
    for (const p of landedPages) {
      if (!wantedPages.has(p)) this.documentBlocks.setPageDeleted(p, false);
    }
  }

  /**
   * The chapters of a book with a working document ARE its `chapter` blocks.
   *
   * There is no second list to keep in step and no green divider to drag: the
   * block on the page is the chapter, its id is the block's id, and its
   * annotation text is the definitive title. Relabelling any block to `chapter`
   * makes it a chapter; relabelling it away stops it being one, with nothing to
   * keep in step.
   *
   * Written from an effect rather than made a computed because `chapters` is a
   * signal the EPUB-source export path still reads and sets; this keeps that
   * surface intact. It writes only on a real change, so it cannot churn
   * `hasUnsavedChanges`.
   */
  private readonly documentChaptersEffect = effect(() => {
    if (!this.blockLayerRead()) return;
    const derived: Chapter[] = this.documentBlocks.chapterBlocks()
      .slice()
      .sort((a, b) => a.page - b.page || a.y - b.y)
      .map(b => ({
        id: b.id,
        title: b.text.trim(),
        page: b.page,
        blockId: b.id,
        y: b.y,
        level: 1,
        source: 'heuristic' as const,
      }));

    const same = (a: Chapter[], b: Chapter[]): boolean =>
      a.length === b.length
      && a.every((c, i) => c.id === b[i].id && c.title === b[i].title && c.page === b[i].page);
    untracked(() => {
      if (!same(derived, this.chapters())) this.chapters.set(derived);
    });
  });

  /**
   * True for a block the picker treats as a chapter opening: the one category
   * field says so. Used for the double-click too — a chapter block's title is
   * editable wherever you are, because editing it is the whole point of it being
   * a chapter.
   */
  isChapterBlock(block: TextBlock): boolean {
    return block.category_id === 'chapter' && !block.is_image;
  }

  /** The run key for this document — see `detectBookKey`. */
  bookKey(): string {
    return this.detectBookKey();
  }

  /**
   * A stage the queue ran for this book has finished: read the document again.
   *
   * The dialog that submitted it is destroyed when it closes, which is exactly
   * when a thirty-minute pass is most likely to finish, so the component that
   * outlives it does the reading.
   */
  async onDocumentReadyToPaint(): Promise<void> {
    await this.loadWorkingDocument();
  }

  /**
   * Read the working document and put its blocks on the pages.
   *
   * Three outcomes, and they are three different facts:
   *
   *  - **No ref.** The book is not a project (a corpus book, a loose file), so
   *    there are no documents and nothing failed. The editor's own block list
   *    stands.
   *  - **A ref, and no block layer to read yet.** Every book is in this state
   *    until Detect has run. The pipeline is still reachable — that is what
   *    `workingDocumentOpen` says — and main's own sentence goes to the console,
   *    because opening a book is not the moment to interrupt somebody about a
   *    stage they have not asked for.
   *  - **A block layer.** It replaces what is on screen. It is the document.
   */
  private async loadWorkingDocument(): Promise<void> {
    const ref = this.workingDocumentRef();
    if (!ref) {
      this.workingDocumentOpen.set(false);
      this.blockLayerRead.set(false);
      return;
    }
    this.blockLayerRead.set(false);
    try {
      await this.documentBlocks.open(ref);
    } catch (err) {
      // `open` sets the state before it reads the blocks, so a state in hand is
      // proof main answered about this book's documents and only the block layer
      // is absent.
      this.workingDocumentOpen.set(this.documentBlocks.state() !== null);
      void this.landOnArrival();
      console.info('[document] no block layer for this book yet:', err);
      return;
    }
    this.workingDocumentOpen.set(true);
    this.blockLayerRead.set(true);
    this.selectedBlockIds.set([]);
    void this.landOnArrival();
    this.saveCurrentDocumentState();
  }

  /**
   * The ARCHIVE ORIGINAL's measured class, or null until main has answered.
   *
   * Stamped with the project it was measured for, like every other main answer
   * this window holds: a window moves between books and the ask is a round trip,
   * so an unstamped answer about book B would be read as book A's — and this one
   * decides whether a book is cast without asking.
   */
  private readonly originalClassAnswer =
    signal<{ dir: string; documentClass: DocumentClass } | null>(null);

  /** The measured class for THIS project, or null. */
  private readonly originalClass = computed<DocumentClass | null>(() => {
    const answer = this.originalClassAnswer();
    const dir = this.projectPath();
    return answer && dir && answer.dir === dir ? answer.documentClass : null;
  });

  /**
   * Ask main which pipeline this book's original belongs to.
   *
   * Only for a book that has not been cast — once there is a working document
   * its marker is the authority, and re-measuring the original would be a second
   * answer to a settled question. A refusal leaves the class UNKNOWN, which
   * `decideArrival` reads as "stand still": there is no safe guess here, because
   * both wrong answers cost the user real time.
   */
  private async measureOriginalClass(): Promise<void> {
    const ref = this.workingDocumentRef();
    const dir = this.projectPath();
    if (!ref || !dir) return;
    try {
      const documentClass = await this.electronService.documentMeasureClass(ref);
      this.originalClassAnswer.set({ dir, documentClass });
    } catch (err) {
      // Ordinary for a book with no PDF original — main refuses that by name —
      // and a real fault for a damaged one. Either way nothing is assumed.
      this.originalClassAnswer.set(null);
      console.info('[document] could not measure this book\'s original:', (err as Error).message);
    }
  }

  /**
   * Stand where this book actually is — and, for a book that has nowhere to
   * stand yet, make somewhere.
   *
   * RULED 2026-08-04: you never START on a read-only book
   * (`shared/document/arrival.ts` holds the whole rule and why). This is the
   * window's half — measure, decide, act — and every branch is derived from the
   * documents rather than remembered from last session.
   *
   * A station swap is this window changing artifacts, and it decides for itself.
   */
  private async landOnArrival(): Promise<void> {
    if (this.stationSwapping) return;

    // The cheap answer first: a book that already has a working copy needs no
    // measurement at all, and asking for one on every open would put a
    // page-sampling read in front of every book in the library.
    if (this.presentStations().includes('working')) {
      this.viewedStation.set('working');
      await this.payOpenWhenFinished();
      return;
    }
    this.viewedStation.set('archive');

    if (this.autoCastAttempted) return;
    await this.measureOriginalClass();

    const action = decideArrival({
      hasProject: !!this.projectPath(),
      isCorpusBook: this.corpusMode(),
      book: this.bookDocuments(),
      documentClass: this.originalClass(),
      // The DOCUMENT stage, not `stationBusy()`. `stationBusy` also counts
      // `loading()` — the picker rendering pages — and this runs while a book is
      // still opening, so reading it here would skip the cast on the ordinary
      // path and leave every text PDF standing on its archive.
      //
      // A stage the QUEUE started is not visible from here, and it does not need
      // to be: `beginStage` refuses a second writer on one project BY NAME, and
      // that refusal lands on `lastError` where the nav shows it verbatim.
      stageRunning: this.documentBlocks.stageRunning() !== null,
    });

    switch (action) {
      case 'stand-on-working':
      case 'stand-on-archive':
        return;
      case 'offer-cast':
        // A scan costs minutes and 1.4 GB of page renders, so it is OFFERED and
        // never taken: the dialog opens with the run one press away and its
        // progress inline, and the archive stays on screen until it lands.
        this.autoCastAttempted = true;
        this.showOcrSettings.set(true);
        return;
      case 'cast-now':
        // Seconds, on the publisher's own text layer. Nothing is asked because
        // there is nothing worth interrupting somebody about.
        this.autoCastAttempted = true;
        await this.castOnArrival();
        return;
    }
  }

  /**
   * Once per book per window. Not idempotence for its own sake: `open()` runs
   * again after every stage and after every reload, and a cast that FAILED —
   * foundry missing, a damaged original — would otherwise be retried on every
   * one of them, forever, with the window unusable in between.
   */
  private autoCastAttempted = false;

  /**
   * Mint the working copy and stand on it. The text-PDF path, on open.
   *
   * `documentBlocks.getText()` and not a queue submission: this run is seconds
   * long, the window is right here to show it, and a queue row for it would be
   * gone before anyone looked. Its failure lands on `lastError`, which the
   * document nav shows verbatim — the same place every other stage's failure is
   * said.
   */
  private async castOnArrival(): Promise<void> {
    console.log('[document] casting the working copy on open (text PDF — seconds, not minutes)');
    await this.documentBlocks.getText();
    const failure = this.documentBlocks.lastError();
    if (failure) {
      console.error('[document] the cast on open did not land:', failure);
      return;
    }
    // Measured, not assumed: the cast is what makes the station exist, and the
    // station list is read off the documents `getText()` just re-read.
    if (this.presentStations().includes('working')) {
      this.blockLayerRead.set(true);
      this.viewedStation.set('working');
    }
  }

  /**
   * Pay out an "open when finished" promise, if this book is carrying one.
   *
   * The promise lives in MAIN (`electron/document-open-when-finished.ts`) so it
   * outlives the window that made it — the old version was a listener on this
   * component filtered to the project it happened to be showing, which meant it
   * only ever paid out for a user who had stayed and watched. Taking it is
   * atomic, so a book open in two windows is opened by one of them.
   *
   * Whether the station is actually THERE is answered here, from the measurement
   * already in hand: `document:stage-finished` fires from a `finally`, so a
   * stage that failed or was cancelled reaches this point too, and opening a
   * station that does not exist would show the user a document the run never
   * wrote.
   */
  private async payOpenWhenFinished(): Promise<void> {
    const projectDir = this.projectPath();
    if (!projectDir) return;
    const station = await this.electronService.documentTakeOpenWhenFinished(projectDir);
    if (station === null) return;
    // The window may have been pointed at another book across the round trip.
    if (this.projectPath() !== projectDir) return;
    if (!STATIONS.includes(station as StationId)) {
      throw new Error(
        `Main handed back "${station}" as a station to open, and this pipeline has no such `
        + 'station. Nothing is opened rather than guessing which one was meant.'
      );
    }
    const target = station as StationId;
    if (!this.presentStations().includes(target)) {
      console.log(
        `[open-when-finished] not opening the ${target} station for ${projectDir}: the run ended `
        + 'without writing it.'
      );
      return;
    }
    // `goToStation`, not `openStation`: this is the app keeping a promise the
    // user made, and the busy guard is there to stop a user changing artifacts
    // mid-stage. A window that is still painting its first page would otherwise
    // swallow the payout it was opened to deliver.
    await this.goToStation(target);
  }

  // ── The stages, as the picker offers them ─────────────────────────────────

  /**
   * Detect. ONE confirmation, because it overwrites hand curation.
   *
   * Nothing here stages or previews the result: if it ran, the annotations in
   * the PDF are the new truth, and the picker shows them because it re-reads the
   * document afterwards.
   */
  async runDetect(): Promise<void> {
    const state = this.documentBlocks.state();
    if (state && state.blockCount > 0) {
      const choice = await this.electronService.showConfirmDialog({
        title: 'Detect blocks again?',
        message:
          `This book already has ${state.blockCount} blocks, and detecting replaces all of them `
          + 'with a fresh reading of the pages.',
        detail:
          'Every label, deletion, merge and chapter title you have set by hand goes with them. '
          + 'Everything the pages say stays — this is a re-reading, not a loss of text.',
        confirmLabel: 'Detect blocks',
        cancelLabel: 'Keep what is there',
        type: 'warning',
      });
      if (!choice.confirmed) return;
    }
    await this.documentBlocks.detect();
    // The service re-reads the document after the stage and reports a failure on
    // `lastError` rather than throwing, so a clean run IS a block layer in hand.
    if (!this.documentBlocks.lastError()) this.blockLayerRead.set(true);
  }

  /**
   * Build the book. Reflow reads the working document and writes
   * `<Original>.epub`, properly named, in one pass.
   *
   * There is no second exporter to fall through to and no gate in front of this:
   * the documents on disk are the whole of the input, so a missing one is an
   * error naming the stage that writes it rather than a reason to rebuild a
   * different book out of the editor's block text.
   */
  private async reflowToEpub(): Promise<string> {
    const epubPath = await this.documentBlocks.reflow();
    const failure = this.documentBlocks.lastError();
    if (failure) throw new Error(failure);
    return epubPath;
  }

  /**
   * Put the working document back to how it stood at the end of a stage.
   *
   * One truncate of an append-only file: no GPU, no re-run, and the result is
   * not an approximation of that document but that document. Confirmed first,
   * because everything appended after the boundary — including every hand
   * correction — is what is being cut off.
   */
  async resetToStage(target: ResetTarget): Promise<void> {
    const label = DOCUMENT_STAGE_LABELS[target];
    const choice = await this.electronService.showConfirmDialog({
      title: `Reset to ${label}?`,
      message: `The working document goes back to exactly how it stood ${target === 'none'
        ? 'before any of the pages had been read'
        : `when ${label} finished`}.`,
      detail: 'Everything done to it since then — labels, deletions, merges, chapter titles — is '
        + 'discarded. The original in archive/ is untouched either way.',
      confirmLabel: `Reset to ${label}`,
      cancelLabel: 'Leave it alone',
      type: 'warning',
    });
    if (!choice.confirmed) return;
    await this.documentBlocks.resetTo(target);
    // Resetting past Get Text re-copies the archive primary, so there is no
    // block layer on the other side of it — only a document waiting to be read.
    if (target === 'none') this.blockLayerRead.set(false);
  }

  // ── Curation, written into the document ───────────────────────────────────

  /**
   * A chapter block's annotation text IS its title, so retitling is one edit to
   * one field — there is no chapter record beside the block to keep in step.
   */
  retitleChapterBlock(event: { blockId: string; title: string }): void {
    this.documentBlocks.retitle(event.blockId, event.title);
  }

  /**
   * A chapter row (or a shift-range of them) was clicked in the Chapter tab.
   *
   * It drives the SAME selection a click on the page does — there is one
   * selection in this window, so the Merge button, the page overlay and the
   * Label palette are all looking at what the user just picked, and Merge from
   * the Chapter tab is the Select tab's merge with nothing duplicated.
   */
  selectChapterBlocks(event: { blockIds: string[]; additive: boolean }): void {
    const { blockIds, additive } = event;
    if (blockIds.length === 0) return;

    if (additive) {
      const selected = [...this.selectedBlockIds()];
      for (const id of blockIds) {
        const at = selected.indexOf(id);
        if (at >= 0) selected.splice(at, 1); else selected.push(id);
      }
      this.setSelectionWithHistory(selected);
    } else {
      this.setSelectionWithHistory(blockIds);
    }

    // Take the page to the row the user landed on. A block the block layer does
    // not carry cannot be scrolled to, and that is a real state while a detect
    // is replacing the annotations — so it simply does not scroll.
    const last = blockIds[blockIds.length - 1];
    const block = this.blocks().find(b => b.id === last);
    if (block) this.scrollToPage(block.page);
  }

  /**
   * Merge the selected blocks into one.
   *
   * The "the system thinks this is two blocks and it isn't" correction, and the
   * service refuses the cases that are not merges — one block, or blocks on two
   * pages — by name rather than producing something that looks merged.
   */
  mergeSelectedBlocks(): void {
    let survivor: string;
    try {
      survivor = this.documentBlocks.merge(this.selectedBlockIds());
    } catch (err) {
      this.showAlert({
        title: 'Could not merge these blocks',
        message: err instanceof Error ? err.message : String(err),
        type: 'warning',
      });
      return;
    }
    // The blocks that were selected no longer exist as such — one of them now is
    // all of them, and the selection collapses onto it. Which one that is, is
    // the service's answer (the earliest in reading order), not a guess here.
    this.selectedBlockIds.set([survivor]);
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
    //
    // THE WHOLE DOCUMENT, not `processedBlocks`. This method is called once per
    // batch of OCR results, and blocks.json is written by REPLACEMENT — so
    // persisting the batch means the last batch is the only one that survives.
    // "Continue in background" splits a run in two at whatever page the user
    // pressed it on, and the second half silently deleted the first half from
    // disk. A single run over a whole book hides this perfectly, because there
    // the batch IS the document.
    //
    // Same filter as the project save above: OCR output only, never a hand-typed
    // chapter box, which is an authored artifact and not something a model should
    // be trained to reproduce.
    if (this.corpusMode()) {
      void this.persistCorpusOcr(this.blocks().filter(b => b.is_ocr && !b.is_manual));
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
    // cropRegions is restored via loadDocument() above (it lives on editorState).
    this.blankedPages.set(doc.blankedPages ?? new Set());
    this.projectCreatedAt = doc.createdAt ?? null;
    this.analyzedSourceSha256.set(doc.sourceSha256 ?? null);
    // Whether THIS tab is allowed to save project state travels with the tab.
    this.projectStateNotApplied.set(doc.projectStateNotApplied === true);
    // The working document is NOT snapshotted onto the tab. It is a file, and
    // the tab that comes forward names it: `workingDocumentEffect` sees the ref
    // change and reads it again. Carrying a copy of a book's block layer from
    // tab to tab is precisely the second place the run directory used to be.

    // Note: paragraphBreaks and categoryCorrections are now passed directly to
    // loadDocument() above, which applies corrections to blocks automatically.
  }

  private clearDocumentState(): void {
    this.activeDocumentId.set(null);
    // Per-document: a PDF remembered across a close would name the previous
    // book's original inside the next book's project directory, which main
    // refuses by name — correctly, and confusingly.
    this.curatedPdfPath.set(null);
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

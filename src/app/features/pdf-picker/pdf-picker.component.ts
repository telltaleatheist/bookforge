import { Component, inject, signal, computed, untracked, HostListener, ViewChild, ElementRef, effect, DestroyRef, ChangeDetectionStrategy, input, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { PdfService, TextBlock, Category, PageDimension, BlockCategoryProvenance } from './services/pdf.service';
import { ElectronService, Chapter, TocLine, EpubExportBlock, EpubExportChapter, EpubPreservingEdits } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction, BlockEdit, SplitDefinition, MergeDefinition, CropRegion } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
import { ExportService, DeletedHighlight, ExportResult as EpubExportResult } from './services/export.service';
import { PageRenderService } from './services/page-render.service';
import { DesktopThemeService } from '../../creamsicle-desktop/services/theme.service';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';
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
  type ChapterRow,
} from './components/document-nav/document-nav.component';
import type { DocumentRef, ResetTarget } from '@shared/document/pipeline-types';
import { toLaidOutBook, type LaidOutBlock, type LaidOutBook } from '@shared/document/laid-out-book';
import { PdfViewerComponent, CropRect } from './components/pdf-viewer/pdf-viewer.component';
import {
  EpubViewerComponent, type EpubViewerSource,
} from './components/epub-viewer/epub-viewer.component';
import { AnalysisPanelComponent } from './components/analysis-panel/analysis-panel.component';
import { MergePanelComponent } from './components/merge-panel/merge-panel.component';
import { RegexCriteria, defaultRegexCriteria } from './shared/regex-criteria';
import { FilePickerComponent } from './components/file-picker/file-picker.component';
import { CropPanelComponent } from './components/crop-panel/crop-panel.component';
import {
  PassOptionsModalComponent,
  type PassAiChoice,
  type PassOptionsKind,
  type PassOptionsResult,
} from './components/pass-options-modal/pass-options-modal.component';
import type { ChainPassRequest } from '@shared/processing/pass-types';
import { QueueService } from '../queue/services/queue.service';
import { SettingsService } from '../../core/services/settings.service';
import { computeBaselines, learnFromBreaks, detectParagraphBreaks, getDefaultConfig, type DetectionConfig } from './services/paragraph-detector';
import { recategorize as recategorizeBlocksFromLearner, classifyBlockHeuristic, computeBaselines as computeCategoryBaselines, isDefaultThresholds, detectMergeableGroups, createMergedBlock, type BlockAssignment, type ClassificationThresholds, type MergeGroup } from './services/category-learner';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, type ExportFormat } from './components/export-settings-modal/export-settings-modal.component';
import { TaskRailComponent } from './components/task-rail/task-rail.component';
import { BLOCK_CATEGORIES, BODY_CATEGORY, normalizeCategories, UNLABEL_CATEGORY } from '@shared/ocr/block-categories';
import { chapterOpeningsAfterDeletions, isChapterOpening } from '@shared/ocr/text-block';
import {
  TASK_ORDER,
  TASK_LABELS,
  STATUS_GLYPH,
  EPUB_PASS_IDS,
  TaskId,
  TaskGroup,
  PanelId,
  TaskStatus,
  isEpubPassId,
  deriveAllTaskStatuses,
  deriveNarrationCopyStatus,
  isBlockFullyOutside,
} from './tasks/task.model';
import {
  NARRATION_EXPORT_LABEL,
  railGroupsForArtifact,
  railShortcutsFor,
  railTaskForDigit,
  viewedArtifactOf,
  type EpubPassTaskId,
  type ViewedArtifact,
} from '@shared/document/rail-tasks';
import { samePath } from '@shared/document/same-path';
import { planArtifactOpen, type ArtifactOpenPlan } from '@shared/document/artifact-open';
import {
  describeWorkingCopyRemint,
  type WorkingCopyRemint,
} from '@shared/document/working-copy-remint';
import { narrationRefusal, type PassRecord } from '@shared/document/version-family';
import {
  deriveNarrationStrikes,
  describeUnstruckDeletions,
  narrationBlocksOnSourcePage,
  narrationDeletedBlockIds,
  narrationDeletedPages,
  narrationDeletionEdit,
  parseNarrationElementKey,
  type NarrationDeletionEdit,
  type NarrationDeletions,
  type NarrationElementKey,
  type NarrationLaidOutBlock,
  type NarrationState,
} from '@shared/vlm/narration-deletions';
import type { BookChapterTitles } from '@shared/vlm/chapter-titles';
import { parsePageRange } from './shared/page-range.util';

/**
 * The one thing a read-only artifact offers the user, or nothing.
 *
 * A closed set rather than a callback on the banner, so every arm is a compile
 * error away from being forgotten and the template can name each button without
 * knowing what it does.
 */
type ArtifactBannerAction = 'open-working' | 'generate-epub' | 'create-working';

/**
 * WHY a document is being opened — because one of the two answers can cost an
 * hour of GPU to say yes to.
 *
 *  - **by-user** — somebody asked for this book. A PDF with no book behind it is
 *    offered the conversion that would give it one, because that is the only way
 *    it becomes editable and the user is right there.
 *  - **restoring** — the window is putting back a document that was already
 *    there: a tab from the last session, the re-open after a chapter rename, the
 *    re-analysis after the viewer and the analyzer disagreed about the page
 *    count. Nothing was asked for, so nothing is offered. Raising the conversion
 *    modal over somebody who has just started the app — once per restored tab —
 *    is the failure this distinction exists to prevent.
 *
 * The redirect to the working copy is NOT conditioned on this. Landing on the
 * editable file is what opening a book means, whoever asked for it.
 */
type DocumentOpening = 'by-user' | 'restoring';

/** What the viewer says about a file that is not the working copy. */
interface ArtifactBanner {
  /** One sentence: what this file is, and where the editable one is. */
  readonly reason: string;
  /** What to do about it, or null when there is nothing to be done yet. */
  readonly action: ArtifactBannerAction | null;
}

interface OpenDocument {
  id: string;
  path: string;           // Original path (for display)
  libraryPath: string;    // Path to file in library (used for actual operations)
  fileHash: string;       // SHA256 hash of the file
  name: string;
  blocks: TextBlock[];
  categories: Record<string, Category>;
  /**
   * Where THIS tab's block categories came from — carried on the tab because
   * `editorState` holds only the ACTIVE document's, and a tab switch reloads
   * from here. `null` until an analysis has answered (a cache miss opens a tab
   * with no blocks yet). See PdfEditorStateService.categoryProvenance.
   */
  categoryProvenance: BlockCategoryProvenance['source'] | null;
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

/**
 * The one source an analysis STATED, or `null` because it stated none.
 *
 * The analyzer sends provenance exactly when it sends blocks — a cache hit
 * carries both, a cache miss carries neither, and a cached analysis missing its
 * provenance is refused rather than defaulted (electron/pdf-analyzer.ts
 * `cachedProvenance`). So `null` here means "no blocks have been classified
 * yet", never "classified, source unknown", and nothing downstream is entitled
 * to read `heuristic` into it: `heuristic` is the answer for a document that
 * states no categories, which is a different claim entirely.
 */
function statedProvenance(
  provenance: BlockCategoryProvenance | undefined,
): BlockCategoryProvenance['source'] | null {
  return provenance === undefined ? null : provenance.source;
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

  // ── What the layout guard has to say about this project ──────────────────
  //
  // Both come from `projects:load-from-path`, which settles WHICH pagination
  // this project's saved records belong to before it reads them
  // (electron/legacy-epub-layout.ts). Neither is a field of the project on
  // disk — they describe what happened while it was being opened — and both
  // are surfaced by `announceLayoutState`.

  /**
   * Why the project's saved page and block deletions were NOT loaded.
   *
   * Present only when the records could not be carried into this build's
   * layout of the book. Everything above that names a page or a block id came
   * back EMPTY in that case — withheld rather than corrected, because a picker
   * handed page numbers from a 218-page mupdf layout has no way to tell they
   * are about a different shape of the same book, and it will draw them.
   *
   * Nothing was deleted from the project: the records are still on disk, and
   * `project:save-to-path` refuses to overwrite them from this window.
   */
  stale_layout_refusal?: string;

  /**
   * What a one-time carry-over of those records came to, when one ran and
   * succeeded. Not a warning — the project's deletions ARE loaded and are now
   * recorded against this build's layout. It is said once because the book was
   * laid out twice to do it, and because the undo history and chapter markers
   * that could not be carried are gone.
   */
  layout_migration_notice?: string;
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
 * Single-key category assignment, active only while the Label tab is open and
 * blocks are selected.
 *
 * Correcting a book's categories by right-clicking into a submenu costs seconds
 * per block, and a curation pass is hundreds of them. The scheme is base key =
 * primary category, Shift = its paired variant.
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
// shortcut is the easiest way to put one back by accident.
// See autoDetectedCategoryList.

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
    EpubViewerComponent,
    AnalysisPanelComponent,
    MergePanelComponent,
    FilePickerComponent,
    CropPanelComponent,
    DocumentNavComponent,
    PassOptionsModalComponent,
    ExportSettingsModalComponent,
    TaskRailComponent,
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
          <!-- Left Tools Sidebar. Rendered with the document: what it CONTAINS
               is the artifact's business, what is pressable is disabledTasks'. -->
          <div
            class="tools-sidebar"
            [style.width.px]="toolsSidebarWidth()"
          >
            <app-task-rail
              [groups]="taskGroups()"
              [statuses]="taskStatuses()"
              [current]="railCurrent()"
              [shortcuts]="taskShortcuts()"
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

              <!-- The way back to an untouched book. Last in the rail, on its
                   own, because it undoes everything above it. -->
              <div rail-footer class="rendering-section">
                <div class="tools-label">Start over</div>
                <button
                  class="menu-item danger"
                  [class.disabled]="eraseRefusal() !== null || erasing()"
                  [disabled]="eraseRefusal() !== null || erasing()"
                  [title]="eraseRefusal() ?? 'Throw away every edit made to this book'"
                  (click)="eraseAllChanges()"
                >
                  <span class="menu-icon">🧹</span>
                  <span class="menu-text">{{
                    erasing() ? 'Erasing…' : 'Erase all changes and start over'
                  }}</span>
                </button>
              </div>
            </app-task-rail>

            <!-- Resize Handle -->
            <div
              class="sidebar-resize-handle"
              (mousedown)="onSidebarResizeStart($event)"
            ></div>
          </div>

          <!-- Chapter rail: a book's chapters beside the viewer, each row the
               chapter's WHOLE name, clicked to jump there. This is the EPUB's
               navigation column — the page timeline it replaces is a raster
               affordance and is not rendered for a book at all. -->
          @if (showsEpubViewer() && curationChapterRows().length > 0) {
            <div class="chapter-rail">
              <div class="chapter-rail-header">Chapters</div>
              <div class="chapter-rail-list">
                @for (row of curationChapterRows(); track row.id) {
                  <button
                    class="chapter-rail-item"
                    [title]="'Page ' + (row.page + 1)"
                    (click)="scrollToPage(row.page)"
                  >{{ row.title }}</button>
                }
              </div>
            </div>
          }

          <!-- Viewer + Timeline wrapper (stacked vertically) -->
          <div class="viewer-timeline-wrapper">
            <!-- Viewer -->
            <div class="viewer-pane">
              <!-- Said, never hidden: a document whose gestures silently do
                   nothing is indistinguishable from a broken picker. The banner
                   also carries the ONE thing that can be done about it, so the
                   user is never told where the editable file is without being
                   given a way to get there. -->
              @if (artifactBanner(); as banner) {
                <div class="review-banner">
                  <span class="review-banner-icon">🔒</span>
                  <span class="review-banner-text">{{ banner.reason }}</span>
                  @if (artifactBannerActionLabel(); as label) {
                    <button
                      class="review-banner-action"
                      [disabled]="artifactActionBusy()"
                      (click)="runArtifactBannerAction()"
                    >{{ artifactActionBusy() ? 'Working…' : label }}</button>
                  }
                </div>
              }
              <!-- A one-time note about something that succeeded — currently
                   the carry-over of an old project's deletions into this
                   build's page layout. Not a modal: nothing is wrong, and a
                   book that opened correctly should not be interrupted. -->
              @if (sessionNotice(); as notice) {
                <div class="review-banner session-notice">
                  <span class="review-banner-icon">📄</span>
                  <span class="review-banner-text">{{ notice }}</span>
                  <button
                    class="session-notice-dismiss"
                    (click)="dismissSessionNotice()"
                  >Dismiss</button>
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
                      <li>• Remove backgrounds</li>
                      <li>• Export to various formats</li>
                    </ul>
                  </div>
                </div>
              } @else if (showsEpubViewer()) {
                <!-- An EPUB shows its own DOM. The raster viewer is not
                     instantiated for one at all — no mixed mode, and nothing
                     below this branch changes for a PDF. -->
                @if (epubViewerReady(); as ready) {
                  <app-epub-viewer
                    [book]="ready.book"
                    [source]="ready.source"
                    [categories]="categoriesWithPreview()"
                    [hiddenCategoryIds]="hiddenCategoryIds()"
                    [selectedBlockIds]="selectedBlockIds()"
                    [deletedBlockIds]="deletedBlockIds()"
                    [deletedPages]="deletedPages()"
                    [selectedPages]="selectedPageNumbers()"
                    [tocSelectedBlockIds]="tocSelectedBlockIdSet()"
                    [zoom]="zoom()"
                    [layout]="layout()"
                    [showCategoryColors]="showCategoryColors()"
                    (blockClick)="onEpubBlockClick($event)"
                    (blockDoubleClick)="onEpubBlockDoubleClick($event)"
                    (blockHover)="onBlockHover($event)"
                    (selectLikeThis)="selectLikeThis($event)"
                    (deleteLikeThis)="deleteLikeThis($event)"
                    (deleteBlock)="deleteBlock($event)"
                    (marqueeSelect)="onMarqueeSelect($event)"
                    (mergeSelection)="mergeSelectedBlocks()"
                    (pageDeleteToggle)="togglePageDeleted($event)"
                    (pageSelect)="onPageSelect($event)"
                    (selectAllOnPage)="selectAllOnPage($event)"
                    (deselectAllOnPage)="deselectAllOnPage($event)"
                    (zoomChange)="onZoomChange($event)"
                  />
                } @else if (epubViewerWhyNot(); as why) {
                  <div class="lightweight-placeholder">
                    <div class="placeholder-content">
                      <span class="placeholder-icon">⚠️</span>
                      <h2>This book is not shown</h2>
                      <p>{{ why }}</p>
                    </div>
                  </div>
                } @else {
                  <div class="lightweight-placeholder">
                    <div class="placeholder-content">
                      <span class="placeholder-icon">📖</span>
                      <h2>Opening the book…</h2>
                      <p>Its pages are being laid out.</p>
                    </div>
                  </div>
                }
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
              [layout]="rasterLayout()"
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
              [showCategoryColors]="showCategoryColors()"
              (blockClick)="onBlockClick($event)"
              (chapterFromBlocks)="onChapterFromBlocks($event)"
              (pageDeleteToggle)="togglePageDeleted($event)"
              (pageSelect)="onPageSelect($event)"
              (deleteSelectedPages)="onDeleteSelectedPages($event)"
              (blockDoubleClick)="onBlockDoubleClick($event)"
              (blockHover)="onBlockHover($event)"
              (selectLikeThis)="selectLikeThis($event)"
              (deleteLikeThis)="deleteLikeThis($event)"
              (selectSourcePage)="selectSourcePage($event)"
              (deleteSourcePage)="deleteSourcePage($event)"
              (deleteBlock)="deleteBlock($event)"
              (mergeSelection)="mergeSelectedBlocks()"
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
              (sampleMouseDown)="onSampleMouseDown($event.event, $event.page, $event.pageX, $event.pageY)"
              (sampleMouseMove)="onSampleMouseMove($event.pageX, $event.pageY)"
              (sampleMouseUp)="onSampleMouseUp()"
              [getPageImageUrl]="getPageImageUrlFn"
            />
              }
            </div>

            <!-- The last step of the flow, in the bottom-right where a
                 next/continue action goes. A real row rather than a floating
                 overlay, so it can never sit on top of the page timeline it
                 shares the bottom of the window with.

                 Shown for every book and DISABLED with its own sentence when it
                 cannot run, for the same reason the rail says why a row is off:
                 a control that vanishes teaches nothing about how to reach
                 it. -->
            @if (showNarrationExport()) {
              <div
                class="narration-export-bar"
                [title]="narrationExportRefusal() ?? 'Write the book minus what you have struck out'"
              >
                <span class="narration-export-status">
                  {{ narrationExportLabel }} — {{ narrationCopyStatus().detail }}
                </span>
                <desktop-button
                  variant="primary"
                  size="lg"
                  iconRight="→"
                  [disabled]="narrationExportRefusal() !== null"
                  (click)="exportTtsCopy()"
                >{{ narrationExportLabel }}</desktop-button>
              </div>
            }

            <!-- Page Timeline (bottom of viewer). Not for an EPUB: its raster
                 thumbnails are gone with the raster path, and its navigation
                 job belongs to the chapter rail beside the viewer. -->
            @if (!showsEpubViewer()) {
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
            }

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
                The default nav: Select / Label / Chapter. Everything else in
                this switch is a tool that takes over the pointer for a while and
                hands it back.
              -->
              <app-document-nav
                [blocks]="textLayerFilteredBlocks()"
                [selectedBlockIds]="selectedBlockIds()"
                [chapterRows]="curationChapterRows()"
                [state]="documentBlocks.state()"
                [lastError]="documentBlocks.lastError()"
                [hasDocument]="workingDocumentOpen()"
                [tab]="navTab()"
                [documentMergeRefusal]="mergeSelectionRefusal()"
                (tabChange)="setNavTab($event)"
                (selectCategory)="selectAllOfCategory({ categoryId: $event, additive: false })"
                (assignCategory)="assignSelectedToCategory($event)"
                (selectAll)="selectAllBlocks()"
                (deselectAll)="clearSelection()"
                (merge)="mergeSelectedBlocks()"
                (chapterClick)="selectChapterBlocks($event)"
                (retitle)="retitleChapterBlock($event)"
                (demote)="demoteChapterBlock($event)"
                (resetTo)="resetToStage($event)"
              />
            }
          }
        </div>
      </desktop-split-pane>

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
        [formatRefusals]="exportFormatRefusals()"
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

    /* Something that WORKED and cost something, so it reads as information
       rather than as a lock: the same bar, normal weight, and it goes away when
       the user is done with it. */
    .session-notice .review-banner-text { font-weight: 400; }
    .session-notice-dismiss {
      margin-left: auto;
      flex-shrink: 0;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      padding: 4px 10px;
      border-radius: $radius-md;
      cursor: pointer;
    }

    /* The one thing that can be done about a read-only artifact. Pushed to the
       far end so the sentence reads first and the button is where the eye goes
       after it. */
    .review-banner-action {
      margin-left: auto;
      flex-shrink: 0;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--text-inverse);
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      padding: 5px 12px;
      border-radius: $radius-md;
      cursor: pointer;
      white-space: nowrap;
      transition: background $duration-fast $ease-out;

      &:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
      &:disabled { opacity: 0.55; cursor: default; }
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

    // The chapter rail: the EPUB's navigation column beside the viewer. Rows
    // wrap — the whole point is the WHOLE chapter name, never an ellipsis.
    .chapter-rail {
      width: 230px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
    }

    .chapter-rail-header {
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--border-subtle);
    }

    .chapter-rail-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--ui-spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .chapter-rail-item {
      text-align: left;
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      line-height: 1.35;
      color: var(--text-secondary);
      background: none;
      border: 0;
      border-radius: 6px;
      cursor: pointer;

      &:hover {
        background: var(--bg-elevated);
        color: var(--text-primary);
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

      /* Destructive, and coloured as one only on hover: the row is read a
         hundred times for every time it is pressed, and a permanently red row in
         the rail reads as an error state rather than an available action. */
      &.danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--accent-danger) 12%, transparent);
        border-color: var(--accent-danger);

        .menu-text, .menu-icon { color: var(--accent-danger); }
      }

      &.disabled { opacity: 0.45; cursor: default; }
    }

    .viewer-pane {
      flex: 1;
      height: 100%;
      min-height: 0; /* Allow flex child to shrink */
      overflow: auto;
      background: var(--bg-sunken);
      position: relative;
    }

    /* The EPUB viewer owns its own scrolling and virtualization, so it must be
       a BOUNDED box inside the pane — its \`:host { flex: 1 }\` is inert here
       because the pane is not a flex container, and an unbounded host makes
       every page-band measure "on screen": all of them mount, the frame budget
       evicts them in a loop, and the book blinks in and goes gray. */
    .viewer-pane app-epub-viewer {
      display: flex;
      height: 100%;
    }

    /* The narration copy: the one primary action of the book's flow, bottom-right.
       A flex row of the viewer/timeline column rather than an absolutely
       positioned overlay — it shares the bottom of the window with the page
       timeline, and a float would cover the thumbnails at the end of the book. */
    .narration-export-bar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--ui-spacing-md);
      flex-shrink: 0;
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-subtle);
    }

    .narration-export-status {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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

  /** Emitted when Finalize is clicked in embedded mode */
  readonly finalized = output<{ success: boolean; epubPath?: string; error?: string }>();

  /**
   * The book has been handed to narration and the main window has ACCEPTED it —
   * this window's work here is over.
   *
   * Deliberately not `finalized`. That event means "the book has been written",
   * and the host answers it with a success toast and a delayed close; both are
   * wrong for a hand-off, where the user is already looking at another window.
   * They were the same event until Phase C, which is why Next used to toast
   * "Project finalized successfully!" over a navigation that never happened.
   *
   * Emitted only after `app:show-narration` has succeeded, so a host that closes
   * on it is closing onto somewhere the user has actually been taken.
   */
  readonly handedOffToNarration = output<{ projectDir: string; epubPath: string }>();

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
  readonly themeService = inject(DesktopThemeService);
  private readonly dialogService = inject(DialogService);
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
   * has its own documents. A book with no ref (a loose file) is
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

  /**
   * PAINT the recorded strikes once the book's blocks are in the editor.
   *
   * The record is the state; the editor's two deletion sets are a VIEW of it
   * (shared/vlm/narration-deletions.ts). So this is a rebuild, not a merge: it
   * REPLACES both sets with what the record says, and writes nothing — there is
   * nothing to write, the record already is the answer.
   *
   * Keyed on the DOCUMENT plus the record's own timestamp plus the block count,
   * so it re-paints when the segmenter replaces the block list (the blocks a
   * recorded element names may not have existed a moment ago) and when the
   * record changes underneath, and not otherwise.
   *
   * There is no save effect beside it any more, and that is the point. There
   * used to be one, debounced, deriving the whole record from these two signals
   * — which made the volatile thing the authority over the durable one and lost
   * an evening's strikes to a document reload.
   */
  private appliedNarrationKey = '';
  private readonly narrationRestoreEffect = effect(() => {
    if (!this.pdfLoaded() || !this.canStrikeForNarration()) return;
    const recorded = this.narrationState()?.deletions;
    const docId = this.activeDocumentId() ?? '';
    // Read so the effect re-runs when the segmenter replaces the block list.
    const blockCount = this.blocks().length;
    if (blockCount === 0) return;
    // The two signals are in the key, so ANY writer of them that is not this
    // rebuild puts the view back under the record's authority on the next tick.
    //
    // That is the structural half of the guarantee, and it is what closes the
    // paths a per-gesture funnel cannot reach: a saved project's own
    // `deleted_block_ids` restored into the view, a legacy disabled-category
    // migration, the document mirror. None of those is a strike, none of them
    // may show as one, and none of them has to remember to say so — the view
    // simply cannot hold a deletion the record does not have for longer than a
    // tick.
    //
    // It settles rather than loops: the rebuild's output is a function of the
    // record, so the pass after it computes the same key it just applied.
    const key = `${docId}|${recorded?.updatedAt ?? ''}|${blockCount}`
      + `|${this.deletedBlockIds().size}|${this.deletedPages().size}`;
    if (this.appliedNarrationKey === key) return;
    this.appliedNarrationKey = key;
    this.rebuildNarrationView();
    this.appliedNarrationKey = `${docId}|${recorded?.updatedAt ?? ''}|${blockCount}`
      + `|${this.deletedBlockIds().size}|${this.deletedPages().size}`;
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
    });
  })();

  @ViewChild(PdfViewerComponent) pdfViewer!: PdfViewerComponent;
  @ViewChild(EpubViewerComponent) epubViewer?: EpubViewerComponent;
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

  // ─────────────────────────────────────────────────────────────────────────
  // The EPUB branch — a book shows its own pages
  //
  // Two viewers, and WHICH one is a property of the document, settled by the
  // document's own extension and by nothing else. There is no mixed mode: a
  // book on screen is either a raster of mupdf's reflow or the book's live DOM,
  // never both and never one falling back to the other. The raster path is
  // reached by PDFs exactly as it always was.
  //
  // What crosses the boundary is unchanged in both directions. The viewer is
  // given `LaidOutBook` — the picker's OWN blocks, the ones the analysis
  // produced and the user has been editing — and it emits gestures back in
  // block ids. Selection still becomes an element key through
  // `deriveNarrationStrikes`, and deletions still go through the one
  // transactional `narration:edit-deletions` pipeline. The viewer is a way of
  // pointing at blocks, not a second opinion about what they are.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Does the document on screen show itself, rather than a picture of itself?
   *
   * `lightweightMode` wins because it is a statement about not rendering pages
   * at all, and a live-DOM viewer renders the most of anything here.
   */
  readonly showsEpubViewer = computed(() =>
    this.isCurrentDocumentEpub() && !this.lightweightMode());

  private readonly epubViewerSource = signal<EpubViewerSource | null>(null);
  private readonly epubViewerRefusal = signal<string | null>(null);

  /** The open book's handle. It owns a session until it is given back. */
  private epubViewerHandle: string | null = null;
  /** Which path the current source is FOR — the effect's idempotence key. */
  private epubViewerOpenedFor: string | null = null;
  /** Bumped per open so a slow open cannot land on top of a newer one. */
  private epubViewerOpenSeq = 0;

  /**
   * Open the book when an EPUB comes on screen; give it back when one leaves.
   *
   * An effect rather than a line in `loadPdf`, because the document on screen
   * changes down several paths — opening a file, opening a project, switching
   * tabs, swapping to a variant — and a book left open by one of them is a
   * leaked session and a stale set of pages. Keyed on the path so it does
   * exactly one open per document.
   */
  private readonly epubViewerEffect = effect(() => {
    const wanted = this.showsEpubViewer() ? this.editorState.effectivePath() : '';
    if (wanted === this.epubViewerOpenedFor) return;
    this.epubViewerOpenedFor = wanted;
    if (wanted !== '' && !this.flowDefaultedFor.has(wanted)) {
      // An EPUB opens the way a book reader would show it: one flowing column
      // at reading size. ONCE per book — a layout the user picked by hand
      // afterwards survives switching tabs away and back.
      this.flowDefaultedFor.add(wanted);
      this.layout.set('flow');
      this.zoom.set(100);
    }
    void this.openEpubViewerFor(wanted);
  });

  /** EPUB paths already given their opening layout, so a book is defaulted once. */
  private readonly flowDefaultedFor = new Set<string>();

  /**
   * Give the book back when the window goes.
   *
   * `closeAllBooksForViewer()` on before-quit is the backstop, not the plan: a
   * picker window can close while the app keeps running, and an open book holds
   * an offscreen window and a whole session until somebody says otherwise.
   */
  private readonly epubViewerRelease = this.destroyRef.onDestroy(() => {
    const handle = this.epubViewerHandle;
    this.epubViewerHandle = null;
    if (handle !== null) void this.electronService.quireCloseBook(handle);
  });

  private async openEpubViewerFor(epubPath: string): Promise<void> {
    const seq = ++this.epubViewerOpenSeq;

    const previous = this.epubViewerHandle;
    this.epubViewerHandle = null;
    this.epubViewerSource.set(null);
    this.epubViewerRefusal.set(null);
    if (previous !== null) {
      const closed = await this.electronService.quireCloseBook(previous);
      if (!closed.success) console.warn('[epub-viewer] closing the last book failed:', closed.error);
    }
    if (epubPath === '') return;

    const result = await this.electronService.quireOpenBook(epubPath);
    if (seq !== this.epubViewerOpenSeq) {
      // A newer document won while this was in flight. Hand this one straight
      // back rather than leaving a session open for a book nobody is looking at.
      if (result.success && result.data?.handle) {
        void this.electronService.quireCloseBook(result.data.handle);
      }
      return;
    }
    if (!result.success || !result.data) {
      this.epubViewerRefusal.set(
        `${epubPath} could not be opened for viewing: ${result.error ?? 'no reason given'}`,
      );
      return;
    }
    this.epubViewerHandle = result.data.handle;
    this.epubViewerSource.set(result.data.source as EpubViewerSource);
    console.log('[epub-viewer] opened', epubPath, result.data.stats);
  }

  /**
   * What the viewer pane should show for an EPUB — one of three things, never a
   * blank.
   *
   * Every way this can fail to be a book is a NAMED refusal on screen rather
   * than an empty pane or a quiet fall back to the raster viewer. In
   * particular the page-count agreement: the analysis and the viewer paginate
   * the same book with the same geometry and must therefore get the same number
   * of pages, and if they ever did not, every page-keyed gesture — page delete,
   * the timeline, scroll-to-page — would point one page at two different places.
   * Deterministic pagination is what makes them agree; this is what happens if
   * that ever stops being true.
   */
  readonly epubViewerState = computed<
    | { kind: 'opening' }
    | { kind: 'refused'; why: string }
    | { kind: 'ready'; book: LaidOutBook; source: EpubViewerSource }
  >(() => {
    const refusal = this.epubViewerRefusal();
    if (refusal !== null) return { kind: 'refused', why: refusal };

    const source = this.epubViewerSource();
    if (source === null) return { kind: 'opening' };

    // The analysis has not landed yet. Not a refusal — the book is on its way.
    const blocks = this.blocks();
    if (blocks.length === 0 || this.totalPages() === 0) return { kind: 'opening' };

    const disagreement = this.epubPageCountDisagreement();
    if (disagreement !== null) {
      return {
        kind: 'refused',
        why:
          `This book was analyzed as ${disagreement.analyzed} page(s) but opens for viewing as `
          + `${disagreement.shown}. The two must be the same book laid out the same way — every `
          + 'page number recorded against it means a different place otherwise — so it is not '
          + 'shown rather than shown wrong. The stale analysis is discarded and the book '
          + 're-opened automatically, once; if this message stays, the analyzer and the viewer '
          + 'are genuinely laying the book out differently, which is a bug and not a cache '
          + 'problem.',
      };
    }

    const provenance = this.editorState.categoryProvenance();
    if (provenance === null) {
      return {
        kind: 'refused',
        why:
          'This book has blocks on screen but no record of where their categories came from, so '
          + 'it cannot be described to the viewer. Close and re-open it; if it persists, clear '
          + 'the analysis cache for this file.',
      };
    }

    try {
      return {
        kind: 'ready',
        book: toLaidOutBook(blocks, this.pageDimensions(), provenance),
        source,
      };
    } catch (err) {
      return { kind: 'refused', why: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * The analysis's page count against the viewer's, when they DISAGREE — null
   * in every other state, including every state where one of them is not known
   * yet. Structured rather than a string test, because two things react to it:
   * the refusal above, and the ONE automatic recovery below.
   */
  private readonly epubPageCountDisagreement = computed<
    { analyzed: number; shown: number } | null
  >(() => {
    if (this.epubViewerRefusal() !== null) return null;
    const source = this.epubViewerSource();
    if (source === null) return null;
    if (this.blocks().length === 0 || this.totalPages() === 0) return null;
    const shown = source.documents.reduce((n, d) => n + d.documentPageCount, 0);
    return shown === this.totalPages() ? null : { analyzed: this.totalPages(), shown };
  });

  /**
   * Books already re-opened once for a page-count disagreement. A second
   * disagreement on the same book means the analyzer and the viewer are LIVE
   * disagreeing — re-opening again would loop forever, so the refusal stands.
   */
  private readonly pageCountReopened = new Set<string>();

  /**
   * The recovery for a stale analysis: close the book and open it again.
   *
   * By the time the disagreement is observable the viewer bridge has already
   * deleted the poisoned page map and analysis payloads from this book's cache
   * (it does so whenever its live pagination contradicts the cached map), so a
   * re-open re-analyzes from scratch and lands on the viewer's own numbers.
   * The re-open is the app's real open path — `closeDocument` +
   * `openTarget` — not a hand-rolled partial reload, so project state comes
   * back exactly as a manual close-and-reopen would bring it back.
   */
  private readonly epubPageCountRecovery = effect(() => {
    const disagreement = this.epubPageCountDisagreement();
    if (disagreement === null) return;
    const docId = this.activeDocumentId();
    const doc = docId === null ? undefined : this.openDocuments().find(d => d.id === docId);
    if (doc === undefined) return;
    const target = doc.projectPath ?? doc.libraryPath;
    if (this.pageCountReopened.has(target)) return;
    this.pageCountReopened.add(target);
    console.warn(
      `[epub-viewer] ${doc.name}: analyzed as ${disagreement.analyzed} page(s) but lays out as `
      + `${disagreement.shown}. The stale analysis cache was discarded when the viewer opened; `
      + 're-opening the book to re-analyze it.',
    );
    queueMicrotask(() => {
      this.closeDocument(docId!);
      void this.openTarget(target, 'restoring');
    });
  });

  // The three arms, each its own signal, so the template narrows without
  // depending on discriminated-union narrowing inside a control-flow block.
  readonly epubViewerReady = computed(() => {
    const state = this.epubViewerState();
    return state.kind === 'ready' ? state : null;
  });
  readonly epubViewerWhyNot = computed(() => {
    const state = this.epubViewerState();
    return state.kind === 'refused' ? state.why : null;
  });

  // ── Reaching into the viewer ──────────────────────────────────────────────
  //
  // Seven methods on the raster viewer are called directly by this component
  // through `@ViewChild`. With two viewers in play every one of them needs an
  // answer for an EPUB, because `this.pdfViewer?.whatever()` on a document
  // showing the OTHER viewer is a silent no-op — the control appears to work,
  // nothing happens, and nothing says why. The seven, and their answer:
  //
  //   scrollToPage               → routed: the EPUB viewer has an equivalent.
  //   resetGridPagination        → nothing to reset; see viewerResetGridPagination.
  //   highlightSearchResults     ⎫ unreachable: `performSearch` refuses for an
  //   highlightCurrentSearchResult⎭ EPUB (searchRefusal) and produces no results,
  //                                so nothing ever asks for a hit to be painted.
  //   clearSearchHighlights      → still reached, by `clearSearch`. Left alone
  //                                on purpose: it erases highlights that on this
  //                                branch were never drawn, so doing nothing IS
  //                                the whole of the work, not a swallowed one.
  //   renderPageForExport        → unreachable: export-to-PDF is refused.
  //   clearCrop                  → unreachable: the crop TASK is already
  //                                disabled for an EPUB in `disabledTasks`
  //                                ("PDF only"), and every path into
  //                                `activatePanel('crop')` goes through that
  //                                gate — so the crop panel can never have been
  //                                open to leave. No second refusal is added
  //                                here; one description of that rule is enough.
  //
  // Note which signal these ask. The two ROUTING helpers ask `showsEpubViewer`,
  // because their question is "which viewer is mounted". The three REFUSALS ask
  // `isCurrentDocumentEpub`, because their question is "what kind of document is
  // this" — an EPUB in lightweight mode mounts no viewer at all, and searching
  // or PDF-exporting one is no more possible for that.
  //
  // The refusals are values (`searchRefusal`, `exportPdfRefusal`,
  // `cropRefusal`) so the controls can disable themselves and say the sentence,
  // rather than being hidden or left live over a viewer that cannot serve them.

  /** Put a page on screen, on whichever viewer this document mounted. */
  private viewerScrollToPage(pageNum: number): void {
    if (this.showsEpubViewer()) {
      // Absent only between the branch switching and Angular resolving the
      // query — the book opens scrolled to its first page either way.
      this.epubViewer?.scrollToPage(pageNum);
      return;
    }
    this.pdfViewer?.scrollToPage(pageNum);
  }

  /**
   * Re-seed the raster viewer's page window. Genuinely nothing to do for an
   * EPUB, and that is a fact about the two designs rather than a gap: the
   * raster grid keeps a windowing cursor that a document change invalidates,
   * and the EPUB viewer keeps none — its bands are a computed of the source and
   * the zoom, and it decides what to mount from the rectangles on every scroll.
   */
  private viewerResetGridPagination(): void {
    if (this.showsEpubViewer()) return;
    this.pdfViewer?.resetGridPagination();
  }

  /**
   * Why the document on screen cannot be searched, or null when it can.
   *
   * The picker's search paints its hits onto the raster viewer's overlay
   * (`highlightSearchResults`), and the live-DOM viewer has no such overlay —
   * marking a hit there means writing into the book's own document, which is a
   * Phase C decision about what the viewer may write and was deliberately not
   * taken. Finding results the user then cannot be shown would be worse than
   * saying so.
   */
  readonly searchRefusal = computed<string | null>(() =>
    this.isCurrentDocumentEpub()
      ? 'Search highlights are drawn over a rendered page, and this book is shown as its own '
        + 'live document. Searching an EPUB is not available yet.'
      : null);

  /** Why this document cannot be exported as a PDF, or null when it can. */
  readonly exportPdfRefusal = computed<string | null>(() =>
    this.isCurrentDocumentEpub()
      ? 'Exporting to PDF photographs each rendered page, and an EPUB has no rendered pages — it '
        + 'is shown as its own document. Export it as an EPUB instead.'
      : null);

  /**
   * The `TextBlock` a gesture's `LaidOutBlock` came from.
   *
   * The viewer speaks the MEANING half of the contract and several of the
   * picker's oldest handlers still take the analyzer's own block. Resolved by
   * id — the projection preserves it — and refused rather than guessed if the
   * id names nothing, because a gesture that silently hit no block is
   * indistinguishable from a picker that ignores clicks.
   */
  private textBlockFor(block: LaidOutBlock): TextBlock {
    const found = this.blocks().find(b => b.id === block.id);
    if (!found) {
      throw new Error(
        `The viewer reported a gesture on block ${block.id}, which is not in the document on `
        + 'screen. The book and the blocks describing it have gone out of step.',
      );
    }
    return found;
  }

  onEpubBlockClick(event: {
    block: LaidOutBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean;
  }): void {
    this.onBlockClick({
      block: this.textBlockFor(event.block),
      shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
    });
  }

  onEpubBlockDoubleClick(event: {
    block: LaidOutBlock; metaKey: boolean; ctrlKey: boolean;
  }): void {
    this.onBlockDoubleClick({
      block: this.textBlockFor(event.block),
      metaKey: event.metaKey, ctrlKey: event.ctrlKey,
    });
  }

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
  /** `flow` is the EPUB viewer's third mode (chapters as continuous columns);
   *  the raster viewer never sees it — see {@link rasterLayout}. */
  readonly layout = signal<'vertical' | 'grid' | 'flow'>('grid');

  /**
   * The layout as the RASTER viewer understands it. A rasterized page cannot
   * flow — there is no reflowable content behind it — so if the user set flow
   * on an EPUB and then opened a PDF, the raster viewer shows the vertical
   * list, which is what flow degrades to when pages are pictures.
   */
  readonly rasterLayout = computed<'vertical' | 'grid'>(() => {
    const l = this.layout();
    return l === 'flow' ? 'vertical' : l;
  });
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
    // A stage this window did not start still changes what this project HAS —
    // Studio mints working copies and converts PDFs into books, and those run in
    // MAIN. So what is on screen is re-measured whenever any stage for THIS
    // project lands.
    const unwatchFinished = this.electronService.onDocumentStageFinished((event) => {
      if (event.projectDir !== this.projectPath()) return;
      void this.onProjectStageFinished();
    });
    this.destroyRef.onDestroy(unwatchFinished);

    if (this.embedded() && this.projectDir()) {
      // Embedded mode - load whatever projectDir() points at (see openTarget)
      const filePath = this.projectDir();
      setTimeout(() => void this.openTarget(filePath, 'by-user'), 0);
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

    // Ctrl/Cmd + E for export (not while typing in a field).
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

      // Digits activate the rail row bound to them (the pointer modes keep S/E).
      // The binding is per RAIL, so a digit can only ever reach a row the user
      // can see — pressing 1 over the book runs the book's first pass, not a
      // crop the book has no rail entry for.
      if (key >= '1' && key <= '9') {
        const taskId = railTaskForDigit(this.viewedArtifact(), Number(key));
        if (taskId && !this.disabledTasks().has(taskId)) {
          event.preventDefault();
          this.onRailPanelClick(taskId);
        }
        return;
      }

      // Category assignment — only with the Label tab open. Normal editing keeps
      // these keys free: someone cleaning a book shouldn't be able to reassign a
      // category by brushing a letter key with blocks selected.
      if (this.navTab() === 'label' && this.selectedBlockIds().length > 0
          && !this.curationLocked()) {
        const categoryId = CATEGORY_SHORTCUTS[event.shiftKey ? `shift+${key}` : key];
        if (categoryId) {
          event.preventDefault();
          this.onSetBlockCategory({ blockIds: [...this.selectedBlockIds()], categoryId });
          return;
        }
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
  // ONE SCREEN — the file on screen decides the tools
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Owen, 2026-08-07. There is no station bar, no ladder and no walk: this
  // window shows a file and offers what that file can be given. Three kinds,
  // and the difference between them is a MEASUREMENT rather than a state:
  //
  //  - the **archive original** (a PDF the project has no working copy of, or
  //    the copy is not what is open) — read-only. Analysis and Search, and a
  //    sentence pointing at the versions page for the copy that can be edited.
  //  - the **working copy** (`<Original>.working.pdf`, named by main and
  //    reported on `document:state`) — full curation, written into that file as
  //    PDF annotations.
  //  - an **EPUB** — the project's book, or the original of a project that
  //    arrived as one. Struck through for narration, chaptered, and rewritten by
  //    the text passes.
  //
  // Everything below is derived from the path in the viewer and main's answers
  // about the project. Nothing is remembered, so nothing can disagree with the
  // files: that was the whole failure of the ladder this replaced, which kept a
  // station in a signal and could show the built book while claiming to be
  // standing on the working copy.

  /** Set while this window swaps one artifact for another — not the user leaving. */
  private artifactSwapping = false;

  /**
   * Which KIND of file is in the viewer, measured from its own extension.
   *
   * The whole of the rule is `shared/document/rail-tasks.ts`'s, and it is one
   * fact: an EPUB is a book, anything else is a source document. The rail is
   * keyed by it and so is everything that asks "can this be struck through".
   */
  readonly viewedArtifact = computed<ViewedArtifact>(() =>
    viewedArtifactOf(this.effectivePath()));

  /** An EPUB is on screen — the book, whichever of the project's it is. */
  readonly viewingBook = computed(() => this.viewedArtifact() === 'book');

  /**
   * The project's book EPUB, as MAIN answers for it (`projects:export-info`),
   * never composed here. The export is named after the book — the manifest owns
   * that name — and it is located by its manifest record rather than by scanning
   * `source/`, so an unrecorded stray is not adopted as a project's book.
   * Existence is checked on that side too, so a record pointing at a deleted
   * file reads as null.
   *
   * Main's last answer, STAMPED with the project it was about.
   *
   * The stamp is the whole point. A window moves between books, the ask is a
   * round trip, and an answer that did not say which project it concerned would
   * be read as the current one — so a failed ask about book B would leave book
   * A's EPUB standing as B's, with a live tab that opens the wrong book. An
   * answer is only ever read back for the project it names (`bookEpubPath`).
   */
  private readonly bookEpubAnswer = signal<{
    dir: string;
    path: string | null;
    /**
     * The book cast from this project's PDF, when it has one on disk.
     *
     * Null for an EPUB-native project and for a PDF nobody has converted. It
     * arrives on the same round trip as the working copy's path because the two
     * facts are one answer about one project — and the banner has to tell those
     * two read-only EPUBs apart to say why each is read-only.
     */
    generatedPath: string | null;
    /**
     * `manifest.outputs.epub.appliedPasses` for that book, in execution order.
     *
     * It arrives with the path because it is the same round trip and the same
     * book: the rail's pass entries say what has been run, and a second ask
     * would be a second answer about one file.
     */
    appliedPasses: readonly PassRecord[];
  } | null>(null);

  /**
   * Main's refusal when it could not answer where the book is, stamped the same
   * way and for the same reason.
   *
   * Kept apart from the path because "we could not ask" and "there is none" are
   * different states, and collapsing them would tell somebody with a damaged
   * manifest that its project simply has no book yet, which is a different
   * thing and points nowhere useful.
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

  /**
   * What has been done to THIS project's book, or an empty list.
   *
   * Empty covers three real states and needs to distinguish none of them: no
   * project, no answer yet, and a book nothing has been run over. In each of
   * them every pass entry reads "not run", which is true — whether the entry
   * can be PRESSED is `disabledTasks`' question, and it is answered there with
   * its own sentence.
   */
  readonly bookAppliedPasses = computed<readonly PassRecord[]>(() => {
    const answer = this.bookEpubAnswer();
    const dir = this.projectPath();
    return answer && dir && answer.dir === dir ? answer.appliedPasses : [];
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
      this.bookEpubAnswer.set({
        dir,
        path: info.exported ? info.exported.absPath : null,
        generatedPath: info.generated ? info.generated.absPath : null,
        appliedPasses: info.appliedPasses,
      });
      // ── The working copy was made AGAIN, and the user is told ───────────────
      //
      // Main sets this on exactly the ask that re-minted the file, so showing it
      // whenever it arrives shows it once per re-mint — there is no flag to keep
      // and nothing to remember between windows.
      //
      // INFORMATION, not a warning: deleting the working copy starts the book
      // over, and main cleared every record made against the old one before
      // minting this. Nothing is being corrected — this is the receipt for what
      // the user asked for. See shared/document/working-copy-remint.ts.
      if (info.remint !== null) this.announceRemint(info.remint);
    } catch (err) {
      // Main's own sentence, kept and shown on the EPUB tab. The last proved
      // path for THIS project is left alone — a round trip that failed is not
      // evidence the book stopped existing — and it is stamped, so it can never
      // be read as another project's answer.
      const message = err instanceof Error ? err.message : String(err);
      this.bookEpubErrorAnswer.set({ dir, message });
      console.error('[picker] could not resolve this project\'s book EPUB:', message);
    }
    await this.refreshNarrationState();
    // The book's own chapter names come off the same file, so they are re-read
    // wherever it is: one round trip's worth of work, and no surface can be
    // looking at the titles of a book that has since been replaced.
    await this.refreshBookChapterTitles();
  }

  // ─── The converted book, and what is struck out of it for narration ───────
  //
  // `foundry vlm-convert` writes the COMPLETE book — footnotes at the end of
  // their chapter, figures, captions. What a listener does not want to hear is
  // struck out here, and exported as a SECOND file; the book itself is never
  // rewritten. See shared/vlm/narration-deletions.ts for the whole contract.

  /**
   * Main's answer about the project's book and its strikes, STAMPED with the
   * project it was about — the same discipline, for the same reason, as
   * `bookEpubAnswer`: a window moves between books and an unstamped answer would
   * put one book's strikes on another.
   */
  private readonly narrationAnswer = signal<{ dir: string; state: NarrationState } | null>(null);

  /** Main's answer for THIS project, or null while it is about another. */
  readonly narrationState = computed<NarrationState | null>(() => {
    const answer = this.narrationAnswer();
    const dir = this.projectPath();
    return answer && dir && answer.dir === dir ? answer.state : null;
  });

  /**
   * The narration copy this project already has, or null.
   *
   * Main's answer, so the button says "written" from the file on disk rather
   * than from anything this window remembers doing.
   */
  readonly narrationCopyPath = computed<string | null>(() =>
    this.narrationState()?.narrationPath ?? null);

  /** What the export button is called. One name, stated once. */
  readonly narrationExportLabel = NARRATION_EXPORT_LABEL;

  /**
   * The bottom-right primary action is OFFERED — i.e. the artifact on screen is
   * the kind of thing a narration copy is cut from.
   *
   * Presence is a fact about the FILE (an EPUB is a book), exactly as the rail's
   * contents are. Whether it can be PRESSED is the separate question below, and
   * conflating them is what put the passes somewhere they could not live: a
   * control that vanishes teaches nothing about how to reach it, so the button
   * is shown for every book and says why when it is off.
   */
  readonly showNarrationExport = computed(() => this.viewingBook());

  /**
   * Why the narration copy cannot be written from here, or null.
   *
   * ONE reason: it needs a project to write into. It does NOT need a recorded
   * book, and that is the whole of the EPUB-native case — main mints the book
   * copy as it saves the first strike (`ensureBookEpub`), so a project whose
   * only EPUB is its original still has something to cut a copy from.
   */
  readonly narrationExportRefusal = computed<string | null>(() => this.noProjectReason());

  /**
   * What the button says under its label: written, or not written yet.
   *
   * The same derivation the rail used when it carried this entry — moving a
   * control is not a reason for it to start answering differently.
   */
  readonly narrationCopyStatus = computed<TaskStatus>(() =>
    deriveNarrationCopyStatus(this.narrationCopyPath() !== null));

  /**
   * The book on screen can be struck through for narration.
   *
   * THE WORKING COPY, and nothing else. This used to be "any EPUB is on screen",
   * which was right while the picker only ever showed one EPUB per project. It
   * is wrong under the artifact model: the archive EPUB and the `.tts.epub` are
   * also EPUBs, they are also openable now, and striking through either would
   * record positions inside a file nobody edits — silently, against a book the
   * export does not read.
   *
   * A project with no working copy yet reads false, and that is not a gap: main
   * makes the copy as the project opens (`projects:export-info`), and until it
   * has, the banner over the viewer says so and offers to make it.
   */
  readonly canStrikeForNarration = computed(() => this.viewingWorkingEpub());

  private async refreshNarrationState(): Promise<void> {
    const dir = this.projectPath();
    if (!dir) {
      this.narrationAnswer.set(null);
      return;
    }
    const answer = await this.electronService.narrationState(dir);
    if (!answer.success || !answer.state) {
      // Not a failure worth a modal: a project with no book has no strikes, and
      // main's sentence is on the console for a damaged one. The stamp keeps a
      // stale answer from being read as this project's.
      this.narrationAnswer.set(null);
      if (answer.error) console.error('[picker] narration state:', answer.error);
      return;
    }
    this.narrationAnswer.set({ dir, state: answer.state });
    // A record that no longer describes the book was CLEARED by main, and the
    // user is told once — their strikes are gone and they need to know before
    // they export a narration copy that has everything in it.
    if (answer.state.staleReason) {
      this.showAlert({
        title: 'Your narration deletions were cleared',
        message: answer.state.staleReason,
        type: 'warning',
      });
    }
  }

  // The working PDF used to be here — `<Original>.working.pdf`, curated through
  // annotations, and the answer to "can this page be edited" for a PDF project.
  // It is gone with the model it belonged to (Owen, 2026-08-08: the working file
  // is ALWAYS an EPUB, and a PDF reaches one through vlm-convert, always). The
  // machinery that writes those annotations is still in main and still backs
  // `documentBlocks` for a document that has one; what changed is that no path
  // in this window mints one and no PDF on screen is editable. Measured before
  // deciding: the library holds 385 projects and ZERO `.working.pdf` files, so
  // this retires a path nothing was using rather than one somebody's book is in.

  /**
   * Why this document can run nothing that writes into a project, or null.
   *
   * One sentence, read by every rail entry that needs a project: two wordings of
   * the same refusal is two answers to "why is this off".
   */
  private readonly noProjectReason = computed<string | null>(() =>
    this.projectPath()
      ? null
      : 'This document does not belong to a BookForge project, and everything here writes into '
        + 'one. Import it from Studio first.');

  /**
   * The file on screen IS this project's working copy — the one editable file.
   *
   * ── The whole of the artifact model, in one comparison ──────────────────────
   *
   * Owen, 2026-08-08: "one working copy per archive file, ground truth and
   * definitive, the only editable file… the user should be able to look at the
   * other files at least, if not edit them." So there is exactly one editable
   * artifact in a project and it is `outputs.epub` — `<archive basename>.working.epub`
   * — and everything else the picker can show (the archive PDF, the archive
   * EPUB, the `.tts.epub` cut for narration) is a thing to LOOK at.
   *
   * Compared against MAIN's answer for where the book is, never against a
   * filename pattern: main derives that name (`exportEpubRelPath`) and a second
   * derivation here is how two surfaces come to disagree about one file.
   */
  readonly viewingWorkingEpub = computed(() => {
    const book = this.bookEpubPath();
    if (book === null) return false;
    return samePath(this.effectivePath(), book);
  });

  /**
   * The `.tts.epub` is on screen — the narration cut, opened to be previewed.
   *
   * Main's answer again (`narration:state`), for the same reason.
   */
  private readonly viewingNarrationCopy = computed(() => {
    const tts = this.narrationCopyPath();
    if (tts === null) return false;
    return samePath(this.effectivePath(), tts);
  });

  /**
   * The book cast from this project's pages is on screen.
   *
   * Main's answer (`projects:export-info`), for the same reason as the two
   * above: this window must never decide from a filename which artifact it is
   * looking at, because the manifest is where those names are derived.
   */
  private readonly viewingGeneratedEpub = computed(() => {
    const generated = this.bookEpubAnswer();
    const dir = this.projectPath();
    const path = generated && dir && generated.dir === dir ? generated.generatedPath : null;
    if (path === null) return false;
    return samePath(this.effectivePath(), path);
  });

  /**
   * What a read-only artifact says about itself, and the one thing it offers.
   *
   * ── Said, and never silent ──────────────────────────────────────────────────
   *
   * A read-only page whose gestures quietly do nothing is indistinguishable from
   * a broken picker, so every artifact that is not the working copy carries a
   * banner naming what it is and where the editable file is. The banner is also
   * the only explanation the disabled gestures get — `curationLocked` reads this
   * same answer, so the refusal and the reason cannot drift apart.
   *
   * `action` is what the user can do about it, and there are exactly three:
   *
   *  - **open-working** — the project has a working copy. Go there.
   *  - **generate-epub** — the archive is a PDF and nothing has read its pages.
   *    A PDF reaches a book through `foundry vlm-convert`, always, even for a
   *    born-digital one: one path, no converter choice. It is an hour of GPU, so
   *    it is a queued job the user starts, never a side effect.
   *  - **create-working** — the project has an archive-grade book and the instant
   *    byte copy has not happened. It normally happens as the project opens
   *    (`projects:export-info`), so reaching this means that failed or the window
   *    got here first; either way the button does exactly what the automatic
   *    path does.
   *
   * ── The generated book is read-only too, and for its own reason ─────────────
   *
   * This comment used to state as law that "the working copy of a PDF is what
   * `foundry vlm-convert` writes". It is not, as of 2026-08-09: the cast lands
   * on `<archive basename>.generated.epub`, which joins `archive/` in the class
   * of files nothing may write to, and the working copy is a byte-identical copy
   * minted from it exactly as an EPUB-native project's is minted from the file
   * the user handed us (Owen: "an epub generated from a pdf… should be treated
   * as an archive file. a working copy of the generated epub is created").
   *
   * So there are now two read-only EPUBs a project can show, and they are
   * read-only for different reasons a user is owed in different words: the
   * archive is what they handed us, and the generated book is what the reader
   * made of their pages. The banner says which.
   *
   * ── What this is FOR now, since a project open no longer lands here ─────────
   *
   * Owen, 2026-08-09: "instead of prompting the user to open the working copy,
   * lets just open the working copy… if they open an archive epub, it just opens
   * a new working copy seamlessly." So a project pointed at either archive-grade
   * EPUB is redirected to its working copy before anything is displayed
   * (`resolveProjectOpen`), and the two EPUB arms below — **open-working** and
   * **create-working** — are no longer how a user normally gets to their book.
   *
   * They are kept, and the banner with them, because three things still reach it
   * and each is real:
   *
   *  - **The archive PDF.** A project with a book browses its pages read-only
   *    and crosses to the copy through this button; a project with none is
   *    offered the conversion as it opens, and this banner is what remains on
   *    screen if the user cancels.
   *  - **The narration copy**, opened deliberately to preview what will be read
   *    aloud. It is not redirected — previewing it is the whole point of opening
   *    it — so it keeps the banner and the way back.
   *  - **A read-only file that is on screen anyway**, because a redirect refused
   *    or because the window bound to its project only after the file had been
   *    opened as a loose one. The banner is the honest fallback for exactly
   *    that: a redirect that did not happen must still leave the user told where
   *    the editable file is, rather than silently curating nothing.
   */
  readonly artifactBanner = computed<ArtifactBanner | null>(() => {
    // A document that is still arriving has not said what it is: main's answers
    // are round trips, so for that moment the working copy reads as an unknown
    // file. Curation is refused for the duration, because "we do not know yet"
    // is not "go ahead" — and no action is offered, because there is nothing yet
    // to act on.
    if (this.loading()) return { reason: 'This book is still opening.', action: null };

    // A loose file belongs to no project, so there is no archive to protect and
    // no working copy to point at. An EPUB opened on its own is edited on its
    // own, exactly as it was before this model existed; a PDF is not, because
    // nothing in this window writes into a PDF any more.
    if (!this.projectPath()) {
      if (this.viewingBook()) return null;
      return {
        reason: 'This PDF does not belong to a BookForge project. Import it from Studio, and its '
          + 'pages can be read into a book you can edit.',
        action: null,
      };
    }

    if (this.viewingWorkingEpub()) return null;

    const what = this.viewingNarrationCopy()
      ? 'This is the narration copy — the book with what you struck out already removed. It is '
        + 'rewritten from scratch every time you export it, so nothing edited here would survive.'
      : this.viewingGeneratedEpub()
        ? 'This is the book read out of your PDF\'s pages, kept exactly as the reader made it so '
          + 'your working copy can be made from it again without reading them a second time. '
          + 'Nothing may write to it.'
        : this.viewingBook()
          ? 'This is the archive original — the file you handed BookForge, which nothing may write to.'
          : 'This is the archive PDF — the file you handed BookForge, which nothing may write to.';

    if (this.bookEpubPath() !== null) {
      return { reason: `${what} Your edits live in the working copy.`, action: 'open-working' };
    }
    if (this.viewingBook()) {
      return {
        reason: `${what} This project has no working copy yet.`,
        action: 'create-working',
      };
    }
    return {
      reason: `${what} A PDF is edited by reading its pages into a book first.`,
      action: 'generate-epub',
    };
  });

  /** The banner's button, in words. Null when the banner only explains. */
  readonly artifactBannerActionLabel = computed<string | null>(() => {
    switch (this.artifactBanner()?.action) {
      case 'open-working': return 'Open working copy';
      case 'generate-epub': return 'Generate EPUB';
      case 'create-working': return 'Create working copy';
      default: return null;
    }
  });

  /**
   * Why curation is refused on the file currently on screen, or null.
   *
   * The banner's sentence, and only ever the banner's sentence. Every mutation
   * entry point asks `curationLocked`, which asks this, which asks the banner —
   * one answer, so a gesture can never be refused for a reason the screen does
   * not show.
   */
  readonly curationReadOnlyReason = computed<string | null>(() =>
    this.artifactBanner()?.reason ?? null);

  /** True when nothing on screen may be curated. Every mutation entry point asks. */
  readonly curationLocked = computed(() => this.curationReadOnlyReason() !== null);

  /**
   * The chapter rows the right-hand nav lists, for whichever artifact is on
   * screen. Three sources, asked in the order of how much the artifact states.
   *
   *  1. **The working PDF**, while its block layer is live. Its chapters ARE its
   *     `chapter` blocks and the block's annotation text is the title — one
   *     field, no mirror. Unchanged by everything below: the artifact boundary
   *     is asked first, exactly as it is by the block mirror and by every
   *     document write.
   *  2. **A book with `chapter` blocks.** A conversion stamps
   *     `data-bf-cat="chapter"` on the heading it split each chapter document
   *     at, and those arrive as `chapter` blocks through the ONE category field
   *     — so the Label tab's relabels add and remove rows here reactively,
   *     exactly as they do for the working PDF. The TITLE is the book's own nav
   *     entry rather than the block's text: see `bookChapterRows`.
   *  3. **A book with none at all** — converted before foundry stamped the
   *     class, or an EPUB from somewhere else entirely. Its chapters are what
   *     `tryLoadOutline` read out of its navigation, and they have no block
   *     behind them (`blockId: null`), so they are shown and not editable.
   *
   * 2 and 3 are exclusive on purpose. The moment a book has chapter blocks they
   * ARE the list, because the nav rows describe the same chapters — listing both
   * would show every chapter of the book twice.
   *
   * 1 and 2 list only what survives the strikes (`visibleBlocks`,
   * `bookChapterOpeningBlocks`); 3 is not filtered by them, because those rows
   * are the book's own table of contents rather than markers on any page, and
   * striking a page out of the narration does not edit what the book says about
   * itself.
   */
  readonly curationChapterRows = computed<readonly ChapterRow[]>(() => {
    if (this.documentLayerLive()) {
      // Already in reading order, and already without the struck ones — see
      // `chapterOpeningsAfterDeletions`, which the service derives them by.
      return this.documentBlocks.chapterBlocks()
        .map(b => ({
          id: b.id, title: b.text.trim(), page: b.page, blockId: b.id, readOnlyReason: null,
        }));
    }

    const openings = this.bookChapterOpeningBlocks();
    if (openings.length > 0) return this.bookChapterRows(openings);

    // `blockId: null` even for a chapter record that carries one. Those records
    // are the legacy PDF chapter-marker path, whose blockId points into a
    // document that is not live here; a row claiming to be backed by it would
    // offer a selection the page would not paint.
    return this.chapters().map(c => ({
      id: c.id,
      title: c.title,
      page: c.page,
      blockId: null,
      readOnlyReason: 'read from this book\'s own table of contents, with no block on any page '
        + 'behind it. Label the heading a chapter opening to edit it here.',
    }));
  });

  /**
   * The chapter-opening blocks of the book on screen, as rows.
   *
   * ── Which row carries the book's title ──────────────────────────────────
   *
   * A nav entry names a DOCUMENT, and a converted book is one document per
   * chapter, so the title belongs to the block that OPENS that document — the
   * first chapter-opening block in it, in reading order. That is the same
   * decision foundry made when it split the book there, read back off the file.
   *
   * A later chapter-opening block in the same document is a split point the book
   * does not have YET: the user has just labelled a heading mid-chapter to say
   * "the next build should break here". It shows its own printed text and is not
   * renameable, because the alternative — showing the document's one nav title on
   * two rows and letting either overwrite it — would let a user rename a chapter
   * from a row that is not that chapter.
   *
   * Every refusal is answered HERE and travels ON the row, so the pencil and the
   * refusal cannot disagree and no affordance is offered that would be refused
   * after the fact.
   */
  private bookChapterRows(openings: readonly TextBlock[]): ChapterRow[] {
    const navTitles = this.bookChapterTitleByFile();
    const isBook = this.viewingBook();
    const claimed = new Set<string>();

    return openings.map(block => {
      const element = block.bf_element;
      const file = element === undefined ? null : parseNarrationElementKey(element).file;
      const opensDocument = file !== null && navTitles.has(file) && !claimed.has(file);
      if (file !== null) claimed.add(file);

      // The nav entry when this row owns it; the print otherwise. The book's
      // OWN chapter names are the authority (Owen, 2026-08-09: "the chapter
      // names are stored in this epub") — the thing that should change to
      // match them is the OPENER BLOCK'S TEXT, because that is what TTS
      // reads, not the name shown here.
      const title = opensDocument ? navTitles.get(file)! : block.text.trim();

      return {
        id: block.id,
        title,
        page: block.page,
        blockId: block.id,
        readOnlyReason: this.bookRetitleRefusal(isBook, file, navTitles, opensDocument),
      };
    });
  }

  /**
   * Why this row's title cannot be retyped, or null when it can be.
   *
   * Four answers, and each names a different thing that is missing rather than
   * collapsing to "not available". They are asked in the order of how far the
   * row gets: is this even the book, is there an element key, does the book's
   * table of contents list that element's document, and is this the row that
   * document's entry belongs to.
   */
  private bookRetitleRefusal(
    isBook: boolean,
    file: string | null,
    navTitles: ReadonlyMap<string, string>,
    opensDocument: boolean,
  ): string | null {
    if (!isBook) {
      return 'a chapter title is written into the book\'s table of contents, and what is on screen '
        + 'is not the book. Open the book to rename its chapters.';
    }
    if (file === null) {
      return 'this heading could not be matched to the markup it was laid out from, so there is no '
        + 'chapter document to rename.';
    }
    if (!navTitles.has(file)) {
      return 'this book\'s table of contents does not list the document this heading is in, so the '
        + 'chapter has no title there to change.';
    }
    if (!opensDocument) {
      return 'this heading is not the one its chapter document opens with, so the book has no '
        + 'separate chapter here yet. Build the book again to split at it.';
    }
    return null;
  }

  /**
   * The blocks of the book on screen that are chapter openings, in reading
   * order.
   *
   * The SAME question `documentBlocks.chapterBlocks` answers for the working
   * PDF, asked of the editor's own block list — which is where a book's blocks
   * live, and which already carries the effective category: the analyzer writes
   * the stamped one (`readConversionCategories`) and `setCategoryCorrection`
   * writes the user's relabel over it, both into `category_id`. So there is one
   * field to read here too, and no correction map to overlay by hand.
   *
   * The strikes are read HERE rather than off a pre-filtered list, so the tab
   * tracks them: deleting the page a chapter marker sits on takes its row out
   * immediately, and restoring the page brings it back. See
   * `chapterOpeningsAfterDeletions`, which is also what the working PDF's own
   * chapter blocks are resolved by.
   */
  private readonly bookChapterOpeningBlocks = computed<TextBlock[]>(() =>
    chapterOpeningsAfterDeletions(this.blocks(), this.deletedBlockIds(), this.deletedPages()));

  /**
   * Main's last answer about what the project's book calls its chapters,
   * STAMPED with the project it was about — the same discipline, for the same
   * reason, as `bookEpubAnswer`: a window moves between books, and an unstamped
   * answer would put one book's chapter titles on another's pages.
   *
   * `titles: null` inside the answer is a real state — the project has no book
   * on disk — and is kept apart from "no answer yet" so a project that has never
   * been converted is not mistaken for one still being read.
   */
  private readonly bookChapterTitlesAnswer =
    signal<{ dir: string; titles: BookChapterTitles | null } | null>(null);

  /** Chapter document (zip entry) → the title the book navigates by. */
  private readonly bookChapterTitleByFile = computed<ReadonlyMap<string, string>>(() => {
    const answer = this.bookChapterTitlesAnswer();
    const dir = this.projectPath();
    if (!answer || !dir || answer.dir !== dir || answer.titles === null) return new Map();
    return new Map(answer.titles.chapters.map(c => [c.file, c.navTitle]));
  });

  /**
   * Ask main what the book calls its chapters. Called wherever the book itself
   * is re-resolved, and again after a rename — the book is the only store, so
   * re-reading it is the whole of "did that land".
   */
  private async refreshBookChapterTitles(): Promise<void> {
    const dir = this.projectPath();
    if (!dir) {
      this.bookChapterTitlesAnswer.set(null);
      return;
    }
    const answer = await this.electronService.bookChapterTitles(dir);
    if (!answer.success) {
      // The book is there and could not be read. Not a modal: the Chapter tab
      // falls back to the printed headings, which is what it showed before this
      // existed, and main's sentence is on the console for a damaged book.
      this.bookChapterTitlesAnswer.set(null);
      console.error('[picker] could not read this book\'s chapter titles:', answer.error);
      return;
    }
    // Main answers `titles: null` for a project with no book. The `undefined`
    // arm is the wire shape's optionality and not a second meaning — every
    // successful answer carries the field — so the two collapse to the one state
    // they both describe.
    this.bookChapterTitlesAnswer.set({
      dir,
      titles: answer.titles === undefined ? null : answer.titles,
    });
  }

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

  /**
   * The rail the file on screen gets — the curation modes and their tasks over
   * the source, the book's own text passes over the book.
   *
   * The rule is `shared/document/rail-tasks.ts`'s and it is keyed by the
   * measured artifact, so this is one lookup. It deliberately does NOT ask
   * whether curation is allowed: what the rail CONTAINS is a fact about which
   * file is in the viewer, and what is PRESSABLE is `disabledTasks`, with its
   * own sentence per entry. Asking those as one question is what hid the rail
   * over the book, which is where the passes live.
   */
  readonly taskGroups = computed<readonly TaskGroup[]>(() =>
    railGroupsForArtifact(this.viewedArtifact()) as readonly TaskGroup[]);

  /** The key hints for the rail on screen; digits run over the rows shown. */
  readonly taskShortcuts = computed(() => railShortcutsFor(this.viewedArtifact()));

  // Collapsed rail groups (persisted; see rail persistence effect).
  readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  // Viewer editor mode: crop while that panel owns the pointer, else select.
  readonly viewerEditorMode = computed<string>(() =>
    this.activePanel() === 'crop' ? 'crop' : 'select');

  // The rail has no visibility condition of its own any more. It is rendered
  // with the document (`@if (pdfLoaded())`), because every artifact has
  // something to offer: the source has the curation modes, the book has its
  // passes (Owen, 2026-08-04 — "lets move translate/simplify/footnotes to a
  // left side nav just like the select/edit modes were when in a pdf").
  //
  // It used to be gated on `!curationLocked()`, which hid it over exactly the
  // artifact the passes live on. The lock has not gone anywhere: it now disables
  // the CURATION entries and carries the same sentence onto each of them
  // (`disabledTasks`), so a curation tool is never live over an artifact that
  // refuses it — said, rather than achieved by leaving nothing on screen to say
  // it about.

  // Crop mode state (derived from activePanel)
  readonly cropMode = computed(() => this.activePanel() === 'crop');
  readonly cropCurrentPage = signal(0);
  readonly currentCropRect = signal<CropRect | null>(null);
  private previousLayout: 'vertical' | 'grid' | 'flow' = 'grid';

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
  // into a merge and read by the merge grouping and the EPUB exporter, and
  // nothing here is for the user to set.

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
   * A one-time, non-blocking note about this session — shown under the viewer,
   * dismissed by the user, and never used for anything a refusal should say.
   *
   * Separate from `showAlert` on purpose. A modal is the right shape for "your
   * edits were not loaded, here is what to do"; it is the wrong shape for "this
   * worked, and here is what it cost", which is what a completed layout
   * migration is. Interrupting a book that opened correctly trains people to
   * dismiss without reading, which is exactly how the refusals stop working.
   */
  readonly sessionNotice = signal<string | null>(null);

  dismissSessionNotice(): void { this.sessionNotice.set(null); }

  /** Projects whose layout-guard verdict has already been said, this session. */
  private readonly layoutStateAnnounced = new Set<string>();

  /**
   * Say what the layout guard did to this project's saved records.
   *
   * The main process settles which pagination a project's `deleted_pages` and
   * `deleted_block_ids` belong to BEFORE it hands them over, and reports one of
   * two things (electron/legacy-epub-layout.ts). Neither may be swallowed:
   *
   *  - a REFUSAL means the payload arrived with every positional field emptied,
   *    so this window is about to show a book with no strikes on it and the user
   *    would otherwise conclude their work had been lost. It gets the modal, in
   *    the same shape as the stale-source refusal above: what happened, what was
   *    NOT changed, and the one thing to do about it.
   *  - a NOTICE means the records were carried across successfully. Nothing is
   *    wrong, so nothing blocks; but the book was laid out twice to do it and
   *    some records (undo history, chapter markers) did not survive, so it is
   *    said once rather than not at all.
   *
   * Both are possible only for EPUB projects saved before the quire cutover. A
   * PDF project, or one already stamped with this build's layout, carries
   * neither field and this does nothing.
   */
  private announceLayoutState(project: BookForgeProject, projectPath: string): void {
    // Opening a project can reach the load handler twice — once to open it, and
    // once more when the freshly loaded document is bound back to it
    // (`restoreProjectState`). The guard is per PROJECT rather than per call so
    // the sentence is said once, whichever of the two got there first.
    if (this.layoutStateAnnounced.has(projectPath)) return;
    this.layoutStateAnnounced.add(projectPath);

    const refusal = project.stale_layout_refusal;
    if (refusal) {
      console.warn(`[loadProjectFromPath] layout refusal: ${refusal}`);
      this.showAlert({
        title: 'Saved Deletions Not Loaded',
        message:
          refusal
          + '\n\nThe rest of the project — its metadata, its highlights, its audiobook settings — '
          + 'opened normally. Strike out what you want left out again and save, and the new '
          + 'records will be written against the layout you are looking at.',
        type: 'warning',
      });
      return;
    }

    const notice = project.layout_migration_notice;
    if (notice) {
      console.log(`[loadProjectFromPath] layout migration: ${notice}`);
      this.sessionNotice.set(notice);
    }
  }

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
    return panel === null || panel === 'merge';
  });
  readonly selectedPageNumbers = signal<Set<number>>(new Set());  // Selected pages for bulk operations
  private lastSelectedPage: number | null = null;  // For shift-click range selection

  // Page image cache - maps page number to data URL
  // Delegate to PageRenderService
  get pageImages() { return this.pageRenderService.pageImages; }

  // Multi-document support
  readonly openDocuments = signal<OpenDocument[]>([]);
  readonly activeDocumentId = signal<string | null>(null);

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
      // Next → Narration is a plain toolbar button now, not the last rung of a
      // station bar. It is offered while the BOOK is on screen — narration takes
      // an EPUB — and disabled with its own sentence otherwise, because a
      // control that vanishes teaches nothing about how to reach it.
      const narrationRefusalText = this.narrationRefusalReason();
      const searchRefusalText = this.searchRefusal();
      const actionItems: ToolbarItem[] = [
        { id: 'export', type: 'button', icon: '📤', label: 'Export', tooltip: 'Export document (Cmd+E)' },
        {
          id: 'narrate',
          type: 'button',
          icon: '🎧',
          label: 'Next: Narration',
          tooltip: narrationRefusalText
            ?? 'Hand this book to narration — opens the Process tab in the main window',
          disabled: narrationRefusalText !== null,
        },
      ];

      return [
        ...baseItems,
        ...actionItems,
        {
          id: 'search',
          type: 'button',
          icon: '🔍',
          label: 'Search',
          // Two reasons it can be off, and the more specific one is told: an
          // EPUB has nowhere to paint a hit, which is a different fact about a
          // different thing from lightweight mode's "pages are not rendered".
          tooltip: searchRefusalText
            ?? (lightweight ? 'Not available in lightweight mode' : 'Search text (Ctrl+F)'),
          disabled: lightweight || searchRefusalText !== null
        },
        { id: 'divider1', type: 'divider' },
        { id: 'undo', type: 'button', icon: '↩', tooltip: lightweight ? 'Not available in lightweight mode' : 'Undo (Ctrl+Z)', disabled: lightweight || !this.canUndo() },
        { id: 'redo', type: 'button', icon: '↪', tooltip: lightweight ? 'Not available in lightweight mode' : 'Redo (Ctrl+Shift+Z)', disabled: lightweight || !this.canRedo() },
        { id: 'spacer', type: 'spacer' },
        { id: 'divider2', type: 'divider' },
        {
          id: 'layout',
          type: 'toggle',
          // The button names where a click TAKES you, as it always has. On an
          // EPUB the cycle is grid → list → flow → grid; elsewhere it stays
          // the two-state toggle, because a raster page has no flow to show.
          icon: this.layout() === 'grid' ? '☰' : this.layout() === 'flow' ? '⊞' : (this.showsEpubViewer() ? '¶' : '⊞'),
          label: this.layout() === 'grid' ? 'List' : this.layout() === 'flow' ? 'Grid' : (this.showsEpubViewer() ? 'Flow' : 'Grid'),
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
      mergeCount: this.editorState.blockMerges().size,
      // The book's own record of what has been run over it. A pass that has run
      // says so, and it says it from the manifest rather than from anything this
      // window remembers doing.
      appliedPasses: this.bookAppliedPasses(),
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

    // The book's passes answer to the BOOK, not to the viewer: they rewrite the
    // file main has recorded, and neither the page renderer nor the block layer
    // is involved. So they are refused for the two reasons that are actually
    // theirs, by name, and are not touched by the curation rules below.
    const passRefusal = this.epubPassRefusal();
    if (passRefusal) {
      for (const id of EPUB_PASS_IDS) disabled.set(id, passRefusal);
    }

    // The narration copy is not on this map any more: it left the rail on
    // 2026-08-08 for the bottom-right primary action, and its own refusal is
    // `narrationExportRefusal` below.

    for (const id of TASK_ORDER) {
      if (id === 'select') continue;
      if (isEpubPassId(id)) continue;
      // Curation is refused on the artifact on screen — the archive original,
      // a book handed to narration. The rail says so on each entry rather than
      // vanishing: the reason is the same sentence the banner over the viewer
      // carries, so there is one explanation and not two that can drift.
      const curation = this.curationReadOnlyReason();
      if (curation) {
        disabled.set(id, curation);
        continue;
      }
      if (isEpub && id === 'crop') {
        disabled.set(id, 'PDF only — not available for EPUB');
        continue;
      }
      if (lightweight) {
        disabled.set(id, 'Not available in lightweight mode');
        continue;
      }
    }
    return disabled;
  });

  /**
   * Why the book's text passes cannot run here, or null.
   *
   * Two states, and neither is inferred from the other: a document that belongs
   * to no project has nowhere to record a pass, and a project with no book has
   * nothing for a pass to read. Main refuses both by name (`requireBookEpub`);
   * this is the same refusal said before the press rather than after it.
   */
  private readonly epubPassRefusal = computed<string | null>(() => {
    const noProject = this.noProjectReason();
    if (noProject) return noProject;
    if (this.bookEpubPath() === null) {
      return 'This project has no book yet, and the text passes rewrite the book — convert its '
        + 'PDF to an EPUB from the versions page first.';
    }
    return null;
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
    // A quire EPUB does not stream: the analysis delivers every page's blocks
    // in ONE answer, and the raster pipeline this counter watches does not run
    // for it at all — an mupdf raster of an EPUB is a DIFFERENT pagination
    // wearing the same page numbers (mupdf lays Killing America out as 218
    // pages where quire lays 235, so this counter sat at 218/235 forever and
    // held the bulk-gesture guard shut on a fully-arrived book). Everything
    // that reads this signal is asking "has the whole book arrived"; for an
    // EPUB it has, by construction, as soon as there is a book at all.
    if (this.isCurrentDocumentEpub()) return this.totalPages();
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
      case 'narrate':
        void this.goToNarration();
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
          // On an EPUB the cycle has three stops — grid, list, flow — because
          // a live book can show its chapters as unbroken columns. A raster
          // document keeps the two-state toggle; if it somehow stands on
          // 'flow' (EPUB set it, then a PDF opened), the click leaves for
          // 'grid' exactly as the label promised.
          const epub = this.showsEpubViewer();
          const newLayout = l === 'grid' ? 'vertical'
            : l === 'vertical' ? (epub ? 'flow' : 'grid')
            : 'grid';
          // When switching to grid, auto-zoom and reset pagination
          if (newLayout === 'grid') {
            this.userAdjustedZoom = false;
            setTimeout(() => {
              this.autoZoomForGrid();
              this.viewerResetGridPagination();
            }, 0);
          }
          // Flow is the reading mode, and reading size is 100% — the same
          // way grid picks its own zoom on entry.
          if (newLayout === 'flow') {
            this.zoom.set(100);
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
  /**
   * Deliberately NOT a narration strike, either arm of it.
   *
   * This is a SCAN affordance: it hides the page photograph a PDF was rendered
   * from, and its own flag (`remove_backgrounds`) is what persists it. An EPUB
   * has no page photograph, so on a book there is nothing here for it to find —
   * and routing it through `landBlockDeletions` would let a view-only toggle
   * strike a book's plates out of the narration copy for good. The two arms
   * cancel in the strike derivation anyway: an id in the view before and after a
   * gesture contributes to both sides of the difference.
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
    if (this.refuseBulkGestureWhileLoading('Deleting a whole text layer')) return;
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
    if (this.documentLayerLive()) {
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
  private surfaceAnalysisWarnings(warnings: string[] | undefined, analyzedPath: string): void {
    if (!warnings || warnings.length === 0) return;

    // An EPUB cannot produce one of these any more, and that is structural
    // rather than lucky. Every warning this modal was built for comes from the
    // block→markup ALIGNER — blocks mupdf laid out that could not be matched
    // back to the elements they came from — and the quire path has no aligner
    // to fail: a block IS an element, handed the key BookForge stamped on it.
    //
    // So a warning arriving for an EPUB is not news for the user, it is a bug
    // in this app, and it is logged as one instead of being shown as if the
    // book were at fault. PDFs are untouched: the aligner is still how a
    // reflowed PDF finds its markup, and it can still come up short.
    if (analyzedPath.toLowerCase().endsWith('.epub')) {
      console.error(
        `[analysis] ${analyzedPath} came back with ${warnings.length} analysis warning(s), which `
        + 'the EPUB path is not supposed to be able to produce. Not shown to the user. '
        + `Warnings: ${warnings.join(' | ')}`,
      );
      return;
    }

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
      this.surfaceAnalysisWarnings(data.warnings, libraryPath);

      // Say which input class this document is: a book our own pipeline wrote
      // states its block categories outright, a publisher's EPUB states its
      // structure in its markup, and a PDF states nothing and gets the
      // font/geometry guess. Logged rather than assumed, because all three look
      // identical on the canvas.
      const provenance = data.categoryProvenance;
      if (provenance) {
        console.log(
          provenance.source === 'document'
            ? `[PdfPicker] categories are the book's own record: ${provenance.stampedBlocks} stamped, `
              + `${provenance.unstampedElementBlocks} on unstamped elements, `
              + `${provenance.unalignedBlocks} unaligned (those are guesses)`
            : provenance.source === 'markup'
              ? `[PdfPicker] categories were read off the book's own markup: `
                + `${provenance.stampedBlocks} from their source elements, `
                + `${provenance.unalignedBlocks} unaligned (those are guesses)`
              : '[PdfPicker] categories are this app\'s font/geometry guess — the document states none',
        );
      }

      // Update editor state if this doc is still the active one
      if (this.activeDocumentId() === docId) {
        this.editorState.updateTextData({
          blocks: data.blocks as TextBlock[],
          categories: data.categories as Record<string, Category>,
          categoryProvenance: statedProvenance(provenance),
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

        // (The mupdf-era auto-consolidation of EPUB line-blocks into paragraph
        // blocks is gone: quire's blocks ARE the book's own paragraphs, so
        // there are no line fragments to merge and a merged block would carry
        // no element key for the viewer to point at.)
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
    // The PROJECT survives an artifact swap. A swap changes which of this
    // project's files is in the viewer; it does not change which project the
    // window is on, and dropping it here is what left the book with no project
    // at all — Simplify and Translate greyed out reading "this document does not
    // belong to a BookForge project" (second real session, 2026-08-04).
    // `loadPdf` cannot put it back either: `autoCreateProject` is skipped during
    // a swap, precisely so the window stays bound to the manifest project rather
    // than rebinding to the artifact.
    if (!this.artifactSwapping) this.projectService.reset();

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
      this.surfaceAnalysisWarnings(quickResult.warnings, libraryPath);

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
        categoryProvenance: statedProvenance(quickResult.categoryProvenance),
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
        categoryProvenance: statedProvenance(quickResult.categoryProvenance),
        pageDimensions: quickResult.page_dimensions,
        totalPages: quickResult.page_count,
        pdfName: quickResult.pdf_name,
        pdfPath: path,
        libraryPath: libraryPath,
        fileHash: fileHash
      });
      this.pageRenderService.clear();
      // Same rule as closePdf: an artifact swap keeps the project. Every other
      // caller of loadPdf really is opening a different document, and for those
      // the binding is rebuilt below by autoCreateProject.
      if (!this.artifactSwapping) this.projectService.reset();
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
        this.viewerResetGridPagination();
      }

      // Auto-create project file for this document
      // Only auto-create project in non-embedded mode
      // In embedded mode, the project already exists (we're editing a version of it).
      // Also skip during pipeline transitions (review / paragraph-fix reloads of a
      // DERIVED epub) — projectPath already points at the manifest project and must
      // stay bound to it, not rebind to the exported artifact's (absent) project.
      if (!this.artifactSwapping) {
        if (!this.embedded()) {
          await this.autoCreateProject(path, quickResult.pdf_name);
        } else if (!this.projectPath()) {
          // Embedded on a FILE rather than a project folder: Studio's "Open" on
          // an archive variant hands the picker the variant's path, and
          // `openTarget` only binds when the target IS the folder. The window
          // then stood in a project it had not been told about, and every
          // rail entry refused with "this document does not belong to a
          // BookForge project" — which was false; the file was inside one.
          // Bind, never create: an embedded window edits a book that already
          // has a project, and minting a second is the phantom-project bug.
          await this.bindContainingProject(path);
        }
      }

      // Auto-extract chapters from EPUBs (they have nav.xhtml with TOC)
      // PDFs may or may not have outlines, so we only auto-load for EPUBs
      if (libraryPath.toLowerCase().endsWith('.epub')) {
        this.tryLoadOutline();
      }

      // Start on-demand page rendering (non-blocking, only renders visible pages)
      // Additional pages render as the user scrolls via the pdf-viewer effect.
      // NOT for an EPUB: the rasters would be mupdf's OWN pagination of the
      // book — a different page count under the same page numbers — and the
      // quire viewer shows the live DOM, so nothing may display them.
      if (!lightweight && !libraryPath.toLowerCase().endsWith('.epub')) {
        this.pageRenderService.startOnDemandRendering(quickResult.page_count);
      }

      // If text not ready (cache miss), start background extraction.
      if (!quickResult.textReady) {
        this.startBackgroundTextExtraction(libraryPath, docId);
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

  onBlockHover(_block: LaidOutBlock | null): void {
    // Could show tooltip here
  }

  // Takes a LaidOutBlock, not a TextBlock: the only thing it reads is
  // `category_id`, which is in the MEANING half of the contract. Whatever
  // viewer emitted the gesture, the answer is the same.
  selectLikeThis(block: LaidOutBlock, additive: boolean = false): void {
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

  /**
   * Select everything that was read off this block's SOURCE page.
   *
   * The page of the PDF, stated on every element of a converted book
   * (`data-bf-page`), and never `block.page` — that is the page mupdf invented
   * when it laid the EPUB out at its own size, and it has no relationship to the
   * paper. Selecting by it is what makes "this whole page was a table of
   * contents" a thing a user can act on in a book that has no pages.
   */
  selectSourcePage(block: LaidOutBlock, additive: boolean = false): void {
    if (block.bf_source_page === undefined) return;
    const deleted = this.deletedBlockIds();
    const matching = narrationBlocksOnSourcePage(
      this.blocks().map(b => ({
        id: b.id,
        ...(b.bf_source_page !== undefined ? { sourcePage: b.bf_source_page } : {}),
      })),
      block.bf_source_page
    ).filter(id => !deleted.has(id));

    if (additive) {
      const current = new Set(this.selectedBlockIds());
      matching.forEach(id => current.add(id));
      this.setSelectionWithHistory([...current]);
    } else {
      this.setSelectionWithHistory(matching);
    }
  }

  /**
   * The destructive twin, resolving the page the same way the selection does —
   * a delete that reached a different set than the one Select would light up
   * would be far worse than a selection that did.
   */
  deleteSourcePage(block: LaidOutBlock): void {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    if (block.bf_source_page === undefined) return;
    const deleted = this.deletedBlockIds();
    const ids = narrationBlocksOnSourcePage(
      this.blocks().map(b => ({
        id: b.id,
        ...(b.bf_source_page !== undefined ? { sourcePage: b.bf_source_page } : {}),
      })),
      block.bf_source_page
    ).filter(id => !deleted.has(id));
    if (ids.length === 0) return;

    const affectedPages = new Set(
      this.blocks().filter(b => ids.includes(b.id)).map(b => b.page));
    this.landBlockDeletions(this.editorState.deleteBlocks(ids), true);
    this.editorState.clearSelection();
    for (const pageNum of affectedPages) this.rerenderPageWithEdits(pageNum);
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
    // A selection spanning more than one page came from a select-all-like-this
    // or a drag over the timeline, which is a bulk gesture wearing a selection's
    // clothes. A single page's worth is what the user can see and is not.
    if (new Set(selected.map(id => this.editorState.getBlock(id)?.page)).size > 1
      && this.refuseBulkGestureWhileLoading('Deleting a selection spanning several pages')) return;

    const deleted = this.deletedBlockIds();

    // On a book, a page whose every block is struck is presented as a deleted
    // PAGE and its blocks are taken OUT of the block-strike set
    // (rebuildNarrationView). So "is this block deleted" must ask the page
    // too, or a selection of page-carried strikes reads as undeleted, the
    // toggle re-deletes it, and the record answers "already recorded" — a
    // gesture that visibly does nothing (measured: an evening of it on
    // Killing America's footnote pages). Raster documents keep the plain
    // block-set answer: their page deletions are a gesture of their own, not
    // a presentation of block strikes.
    const pages = this.deletedPages();
    const pageCarried = new Set(
      this.showsEpubViewer()
        ? selected.filter(id => {
            if (deleted.has(id)) return false;
            const page = this.editorState.getBlock(id)?.page;
            return page !== undefined && pages.has(page);
          })
        : [],
    );

    // Check if ALL selected blocks are already deleted - toggle to restore
    const allDeleted = selected.every(id => deleted.has(id) || pageCarried.has(id));

    if (allDeleted) {
      // Restore all selected blocks (toggle off)
      // Get affected pages before restoration
      const affectedPages = new Set<number>();
      for (const blockId of selected) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }

      if (pageCarried.size === 0) {
        this.landBlockDeletions(this.editorState.restoreBlocks(selected), false);
        this.editorState.clearSelection();
      } else {
        // Restoring a page-carried strike opens its page and re-strikes the
        // page's UNSELECTED blocks individually — the page stops being fully
        // struck, so the page presentation no longer covers them. The record
        // edit is landed ONCE from the before/after sets around the whole
        // compound; landing each step would post the middle states.
        const beforeBlocks = this.narrationStruckBlockIds();
        const beforePages = new Set(pages);

        const selectedSet = new Set(selected);
        const pagesToOpen = [...new Set(
          [...pageCarried].map(id => this.editorState.getBlock(id)!.page),
        )];
        const keepStruck = this.blocks()
          .filter(b => pagesToOpen.includes(b.page) && !selectedSet.has(b.id) && !deleted.has(b.id))
          .map(b => b.id);
        if (keepStruck.length > 0) this.editorState.deleteBlocks(keepStruck);
        this.editorState.restorePages(pagesToOpen);
        const ownStruck = selected.filter(id => deleted.has(id));
        if (ownStruck.length > 0) this.editorState.restoreBlocks(ownStruck);
        this.editorState.clearSelection();

        this.postNarrationEdit(
          beforeBlocks, beforePages, this.narrationStruckBlockIds(), this.deletedPages());
      }

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
      // …and into the RECORD, if the artifact on screen is a book. This wrote
      // only the signal, which under the record-authoritative model is a
      // deletion the screen shows and the narration copy never hears about —
      // and, since the restore effect now repaints the view from the record,
      // one that would silently vanish again on the next tick. The migration is
      // a statement of the user's intent, so it goes where intent lives.
      this.landNarrationBlockStrikes(toDelete.map(b => b.id), true);
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

  deleteLikeThis(block: LaidOutBlock): void {
    if (this.curationLocked()) return;  // the artifact on screen is not curated here
    if (this.refuseBulkGestureWhileLoading('Deleting every block like this one')) return;
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
    if (this.documentLayerLive()) {
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

  /** Apply a category to the current selection (label-mode palette click). */
  assignSelectedToCategory(categoryId: string): void {
    const selected = this.selectedBlockIds();
    if (selected.length === 0) return;
    this.onSetBlockCategory({ blockIds: [...selected], categoryId });
  }

  clearCategoryCorrections(): void {
    this.editorState.clearAllCategoryCorrections();
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

  /**
   * Why splitting is off, or null when it can run.
   *
   * Both halves of splitting are PDF machinery. The split POINTS come from
   * mupdf's spans, which a live EPUB has none of; and the text-mode fallback
   * below would go further and do real damage on this path, because a block of
   * a quire-paginated book IS one element of the book — splitting it would
   * leave two blocks naming one element, and striking either would strike the
   * whole of it. The narration writer deletes elements, not halves of them.
   *
   * A DOM-Range equivalent is a design (where does a split land in the markup?
   * what does the export writer do with half an element?), not a setting, so v1
   * says no and says why. The commit shape (`SplitDefinition`) is untouched, so
   * nothing has to be unpicked when the answer changes.
   */
  readonly splitBlockRefusal = computed<string | null>(() => {
    if (this.curationLocked()) {
      return 'The document on screen is a finished artifact, not the working copy, so its blocks '
        + 'are not edited here.';
    }
    if (this.isCurrentDocumentEpub()) {
      return 'A block of an EPUB is one element of the book itself, and half an element is not '
        + 'something the book can be written back out as. Splitting is available on PDFs, where a '
        + 'block is a box of spans rather than a paragraph of the source.';
    }
    return null;
  });

  async onSplitBlockRequest(block: TextBlock): Promise<void> {
    const splitRefusal = this.splitBlockRefusal();
    if (splitRefusal !== null) {
      this.showAlert({ title: 'This block cannot be split', message: splitRefusal, type: 'warning' });
      return;
    }
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
    // A quire-paginated EPUB's blocks ARE the book's own paragraphs — there are
    // no line fragments to consolidate, and a merged block would carry no
    // element key for the live viewer to point at. Same refusal the other merge
    // surfaces give an EPUB, said at the press.
    if (this.isCurrentDocumentEpub()) {
      await this.electronService.showConfirmDialog({
        title: 'Merge is not available for EPUBs',
        message: 'This book\'s blocks are its own paragraphs, read straight from the markup — '
          + 'there are no line fragments to merge back together.',
        confirmLabel: 'OK',
        type: 'info',
      });
      return;
    }
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
    // Merge does not exist for EPUBs (see mergeAdjacentBlocks), so a saved EPUB
    // project carrying merges holds state this surface can no longer honour —
    // in practice, output of the retired auto-segmentation step. Not applying
    // them is lossless: the source blocks are the analysis blocks, still
    // present, and the next save writes the project without the merges.
    if (this.isCurrentDocumentEpub()) {
      console.warn(
        `[restoreBlockMerges] Skipping ${merges.length} saved block merge(s): merge is not `
        + 'available for EPUBs, and a merged block carries no element key the live viewer '
        + 'could point at. The source blocks are shown as analyzed; saving will drop the record.',
      );
      return;
    }
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
    // The two sets as they stand BEFORE the entry is applied. An undo says what
    // it undid in the editor's vocabulary, not in elements, so the strike record
    // is edited by the difference — read here, in the same handler, before
    // anything else can touch either set.
    const struckBefore = this.narrationStruckBlockIds();
    const pagesBefore = new Set(this.deletedPages());
    const action = this.editorState.undo();
    if (!action) return;
    // One history entry can restore a crop's worth of blocks, a class of them
    // and a page at once, so what an undo means to the document is the
    // difference it just made — taken here, before anything else writes.
    this.reconcileDeletionsWithDocument();
    this.landNarrationHistory(struckBefore, pagesBefore);

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
    const struckBefore = this.narrationStruckBlockIds();
    const pagesBefore = new Set(this.deletedPages());
    const action = this.editorState.redo();
    if (!action) return;
    this.reconcileDeletionsWithDocument();
    this.landNarrationHistory(struckBefore, pagesBefore);

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

  // Scroll to a specific page (used by timeline)
  scrollToPage(pageNum: number): void {
    this.currentPageIndex.set(pageNum);
    this.viewerScrollToPage(pageNum);
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
    // The toolbar button is disabled and says why; this is the keyboard's
    // answer to the same question, since Ctrl+F does not read that button.
    const refusal = this.searchRefusal();
    if (refusal !== null) {
      this.showAlert({ title: 'This book cannot be searched', message: refusal, type: 'warning' });
      return;
    }
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
    // Refused rather than run: the results would be real and the highlights
    // that show where they are would not exist, so the search box would fill
    // with hits the user cannot be taken to. The control itself is disabled and
    // carries this sentence; this is the same answer for anything that reaches
    // the method another way (the debounce already in flight, a shortcut).
    if (this.searchRefusal() !== null) {
      this.searchResults.set([]);
      this.currentSearchIndex.set(-1);
      return;
    }

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
    this.viewerScrollToPage(result.page);
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

    // A PDF has no book in it that this window can write. Said by name rather
    // than by a button that does nothing: the one route from a PDF to an EPUB is
    // the conversion, and it is not here.
    this.showAlert({
      title: 'This document cannot be exported as an EPUB',
      message: 'A book is made from a PDF by reading its pages with a document vision model, which is '
          + 'Convert to EPUB on this project\'s versions page in Studio. There is no exporter here '
          + 'that can turn a PDF into one.',
      type: 'warning',
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
    // text, exactly as finalizeProject() does. Same destination either way —
    // the book-named export recorded in manifest.outputs.epub — and the same
    // navigation to the producer that navigateAfter: true gives below.
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

    // Everything else is a PDF, and a PDF has no book in it that this window can
    // write. The producer takes an EPUB, so there is nothing to hand it.
    this.showAlert({
      title: 'This document has no book to produce from',
      message: 'A book is made from a PDF by reading its pages with a document vision model, which is '
          + 'Convert to EPUB on this project\'s versions page in Studio. There is no exporter here '
          + 'that can turn a PDF into one.',
      type: 'warning',
    });
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
        // A PDF has no markup to preserve and no exporter here that can make one
        // out of it. Refused by name rather than writing something that is not
        // the book: the conversion is what makes a book from pages.
        result = {
          success: false,
          message: 'A book is made from a PDF by reading its pages with a document vision model, which is '
          + 'Convert to EPUB on this project\'s versions page in Studio. There is no exporter here '
          + 'that can turn a PDF into one.',
        };
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
    // The file the user opened is the ALIGNMENT BASELINE — every block id in the
    // edit set was resolved against its bytes. So the book's own XHTML is edited
    // in place, in main, and the canonical export is the target. Save As is how
    // the user writes a preserved EPUB anywhere else.
    if (!this.useEpubPreservingExport()) {
      // A PDF has no markup to preserve, and nothing here makes a book out of
      // one. The conversion does, and it lives on the versions page.
      this.loading.set(false);
      const refusal = 'A book is made from a PDF by reading its pages with a document vision model, which is '
          + 'Convert to EPUB on this project\'s versions page in Studio. There is no exporter here '
          + 'that can turn a PDF into one.';
      this.finalized.emit({ success: false, error: refusal });
      this.showAlert({ title: 'There is no book to save', message: refusal, type: 'warning' });
      return;
    }

    try {
      const result = await this.runEpubPreservingExport(projectPath, null);

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
  // Opening the book, and handing it on
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A stage for this project finished — anywhere. Re-measure.
   *
   * A conversion started from Studio writes this project's book, and a working
   * copy minted there appears under this window's feet. Neither is this
   * component's work, and both change what it is looking at, so both are
   * measured again rather than remembered.
   */
  private async onProjectStageFinished(): Promise<void> {
    const projectDir = this.projectPath();
    if (!projectDir) return;

    // `refreshState` throws for a project with no PDF original — main refuses to
    // resolve a working document for a book — and that is an ordinary state for
    // exactly the projects whose stages this handler cannot be about. So its
    // refusal does not stop the book measurement.
    try {
      await this.documentBlocks.refreshState();
    } catch (err) {
      console.info('[document] this project has no working document to re-measure:', err);
    }
    await this.refreshBookEpub();
  }

  // ─── Erase all changes ────────────────────────────────────────────────────

  /** Set while the reset is in flight. */
  readonly erasing = signal(false);

  /**
   * Why this book's edits cannot be thrown away from here, or null.
   *
   * A project is needed because the edits live in its manifest, and that is the
   * whole of it. Deliberately NOT gated on the artifact being the working copy:
   * a user looking at the archive and wanting to start over is asking for the
   * same thing, the records are the project's rather than the open file's, and
   * refusing them there would mean opening a different file to press a button
   * about the project.
   */
  readonly eraseRefusal = computed<string | null>(() => this.noProjectReason());

  /**
   * Throw away every edit recorded against this project's book.
   *
   * ── One reset, not a second one ─────────────────────────────────────────────
   *
   * This is `pipeline:reset-editor-state` — the contract Studio's context menu
   * and the Project Files panel already use — and nothing else. That handler
   * clears `manifest.editor` WHOLESALE (undo/redo, block edits, category
   * corrections, learned categories, paragraph breaks, splits, merges, crops),
   * the deletion keys grafted onto `manifest.source`, the chapter markers, and —
   * since this button existed — the narration strikes. A second reset shape
   * here would be a second answer to "what counts as an edit", and the two would
   * drift the first time the editor learned to record something new.
   *
   * ── What it does NOT touch, and why the dialog says so ──────────────────────
   *
   * The working copy FILE and the archive both stay exactly as they are. That
   * distinction is the whole reason this is safe to offer: the edits are records
   * ABOUT the book, the book itself is bytes, and starting over means forgetting
   * the records rather than rebuilding anything. A user who has just spent an
   * evening striking footnotes needs to read that sentence before saying yes.
   *
   * For a project made from a PDF the same call clears the inert PDF-side
   * records — page and block deletions made against the scan, which never
   * migrate into the book (electron/narration-editor-state.ts) and have been
   * sitting there unused. They are edits the user made and they are cleared by
   * the same act, because "erase all changes" that left some behind would be a
   * lie about what it did.
   *
   * ── Why THIS window is the dangerous one ────────────────────────────────────
   *
   * Main destroys any registered EDITOR window for the project as it resets, so
   * those cannot autosave their copy of the state back. It cannot do that to the
   * window that pressed the button, and that window holds the same state: the
   * struck sets, the chapters, the undo stacks, the merges, a snapshot per open
   * document, and a debounced writer (`autoSaveTimeout` → `project:save-to-path`).
   * Every one of them is a way for the erase to be undone seconds after it
   * succeeded.
   *
   * So the invariant is built here rather than hoped for:
   *
   *  1. `erasing` is set BEFORE the reset IPC and cleared only after the reload
   *     has finished, and every manifest writer in this component refuses while
   *     it is set (`scheduleAutoSave`, `performAutoSave`, `saveProjectToPath`,
   *     `postNarrationEdit`). Nothing can slip through the window between the
   *     reset returning and this window having re-read the manifest.
   *  2. The pending autosave timer is cancelled outright, and
   *     `appliedNarrationKey` is cleared so the next restore rebuilds the view
   *     from the CLEARED record rather than believing it has already painted
   *     this book.
   *  3. Every open document of this project is DROPPED, which takes its snapshot
   *     of the edit set with it, and the live editor is closed. Reloading only
   *     the file on screen would leave the other tabs holding the old sets, and
   *     switching back to one and touching anything would write them back.
   *  4. Only then is the artifact re-opened, from the now-clean manifest.
   */
  async eraseAllChanges(): Promise<void> {
    if (this.eraseRefusal() !== null || this.erasing()) return;
    const projectDir = this.projectPath();
    if (!projectDir) return;

    const strikes = this.narrationState()?.deletions?.elements.length ?? 0;
    const detail = [
      `• ${this.deletedBlockIds().size} deleted block(s) and ${this.deletedPages().size} deleted page(s)`,
      `• ${strikes} element(s) struck out for narration`,
      '• every category correction, chapter marker, text edit, merge, split and crop',
      '',
      'The working copy itself is NOT rewritten, and the archive original is not touched. '
      + 'This forgets what was recorded about the book, not the book.',
    ].join('\n');

    const { confirmed } = await this.electronService.showConfirmDialog({
      title: 'Erase all changes and start over',
      message: 'Throw away every edit recorded against this book?',
      detail,
      confirmLabel: 'Erase everything',
      cancelLabel: 'Cancel',
      type: 'warning',
    });
    if (!confirmed) return;

    // Where the user is standing, read BEFORE anything is torn down: the erase
    // should not move them to a different file.
    const onScreen = this.effectivePath();

    // Set first, and it is what every writer in this component checks. From here
    // to the `finally` this window cannot write to the manifest.
    this.erasing.set(true);
    this.cancelScheduledProjectWrites();
    this.loading.set(true);
    this.loadingText.set('Erasing every change...');
    try {
      const result = await this.electronService.resetEditorState(projectDir);
      if (!result.success) {
        throw new Error(result.error || 'The changes could not be erased.');
      }
      // Nothing this window remembers about the project survives it.
      this.forgetProjectDocuments(projectDir);
      // Re-measure everything this window believes about the project from the
      // files, in the order the open path does: what the book is, what is struck
      // out of it, and then the document itself.
      await this.refreshBookEpub();
      await this.refreshNarrationState();
      // The book when the project has one — that is what the rail is about and
      // what the user was almost certainly looking at — and otherwise the file
      // they were on, which for a project with no book yet is its archive. Two
      // named cases, not a ladder: a project with a book never lands on the
      // second, and a project without one has no book to land on.
      const book = this.bookEpubPath();
      const reopen = book !== null ? book : onScreen;
      if (reopen) await this.showArtifact(reopen);
      this.showAlert({
        title: 'Everything was erased',
        message: 'This book is back to the way it arrived. The file itself was never rewritten.',
        type: 'info',
      });
    } catch (err) {
      this.showAlert({
        title: 'Could not erase the changes',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
    } finally {
      this.erasing.set(false);
      this.loading.set(false);
    }
  }

  /**
   * Cancel every write this window has SCHEDULED but not yet made.
   *
   * There is exactly ONE now: `autoSaveTimeout`, which fires
   * `project:save-to-path` (the editor container and the deletion keys under
   * `manifest.source`). A cancelled timer is not enough on its own — a timer
   * that had ALREADY fired is an in-flight promise — which is why the writer
   * itself refuses while `erasing` is set; this is the half that stops new ones
   * being born.
   *
   * The strike record used to have a debounced writer of its own here. It has
   * none now: strikes are posted at the gesture that makes them
   * (`postNarrationEdit`), and that call refuses outright while `erasing` is
   * set, so there is no scheduled strike write left to cancel.
   *
   * `appliedNarrationKey` goes back to its opening value on purpose: it is what
   * makes the next `narrationRestoreEffect` run rebuild the view from the
   * record as it stands AFTER the erase, rather than believing it has already
   * painted this book.
   */
  private cancelScheduledProjectWrites(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }
    this.appliedNarrationKey = '';
  }

  /**
   * Drop everything this window is holding about a project, documents included.
   *
   * Called only from the erase, and it is the structural half of it: the state
   * cannot be written back if the window is not holding it. Clearing the live
   * editor alone would not do — `openDocuments` keeps a per-document SNAPSHOT of
   * the same fields (deletions, undo and redo stacks, chapters, corrections,
   * crops), taken on every tab switch and restored on the way back, so a project
   * open as both its archive and its book would keep one full copy of the erased
   * edit set per tab.
   *
   * `closePdf` does the live half, and it is the same call the artifact swap
   * makes — `artifactSwapping` is set around it for the reason it always is: the
   * window stays bound to the project, which it must, because the very next act
   * is to re-open one of that project's files.
   */
  private forgetProjectDocuments(projectDir: string): void {
    this.openDocuments.set(
      this.openDocuments().filter(d => !(d.projectPath && samePath(d.projectPath, projectDir))));
    this.activeDocumentId.set(null);
    this.artifactSwapping = true;
    try {
      this.closePdf();
    } finally {
      this.artifactSwapping = false;
    }
    // Cancel again: closing the document writes to the signals the auto-save
    // effect watches, and an effect that ran during it could have scheduled one.
    this.cancelScheduledProjectWrites();
    this.editorState.markSaved();
  }

  /** Set while the banner's button is doing its one thing. */
  readonly artifactActionBusy = signal(false);

  /**
   * The banner's button was pressed. Three arms, one per action, and the switch
   * is exhaustive so a fourth action cannot be added without being handled.
   *
   * Every arm ends with the user somewhere they can work: on the working copy,
   * or in front of the queue watching the job that will make one. None of them
   * leaves the read-only file on screen having quietly done something.
   */
  async runArtifactBannerAction(): Promise<void> {
    const action = this.artifactBanner()?.action;
    if (!action || this.artifactActionBusy()) return;
    const projectDir = this.projectPath();
    if (!projectDir) return;  // the banner offers no action without one

    this.artifactActionBusy.set(true);
    try {
      switch (action) {
        case 'open-working': {
          const book = this.bookEpubPath();
          if (book === null) {
            // Unreachable through the button — this arm is only offered when the
            // path is there — but said rather than returned in silence.
            throw new Error(
              'This project reported a working copy a moment ago and does not now. Close the '
              + 'window and open the book again.');
          }
          await this.showArtifact(book);
          return;
        }
        case 'create-working': {
          const answer = await this.electronService.ensureWorkingEpub(projectDir);
          if (!answer.success || !answer.path) {
            throw new Error(answer.error || 'The working copy could not be made.');
          }
          // Said HERE and not after the refresh below: by then the file exists,
          // so the ask that follows has no re-mint to report. See
          // `refreshBookEpub` for the whole of why this is said at all.
          if (answer.remint) this.announceRemint(answer.remint);
          await this.refreshBookEpub();
          await this.showArtifact(answer.path);
          return;
        }
        case 'generate-epub': {
          // Reading a PDF's pages is an hour of GPU and belongs in the queue, so
          // this hands the job to the MAIN window — the one that owns the queue —
          // exactly as `goToNarration` hands the finished book to the Process
          // tab. This window is often its own BrowserWindow with no queue and no
          // nav rail of its own; enqueueing here would put the job in a second
          // queue nobody is watching.
          await this.electronService.showBookConversion(projectDir);
          return;
        }
        default: {
          const unknown: never = action;
          throw new Error(`There is no ${String(unknown)} action on the banner.`);
        }
      }
    } catch (err) {
      this.showAlert({
        title: 'That could not be done',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
    } finally {
      this.artifactActionBusy.set(false);
    }
  }

  /**
   * The file this project should ACTUALLY display, having been pointed at
   * `asked` — and, when there is no book to point at, the job that would make
   * one.
   *
   * ── Why an open is redirected at all ────────────────────────────────────────
   *
   * Owen, 2026-08-09: "instead of prompting the user to open the working copy,
   * lets just open the working copy… theyll open the original version — the
   * archive epub created by the vlm. but it will ACTUALLY open the working copy
   * with the changes applied."
   *
   * Every door in pointed at an archive-grade file. `EditorRouteService` hands
   * an EPUB project its `archive/<Book>.epub` so the export can align against
   * the book's own markup, and the versions page's generated row hands over the
   * cast book. Both are files nothing may write to, so both landed the user in
   * front of a banner whose one offer was to go one click further to the file
   * they had asked for in the first place.
   *
   * ── ONE choke point, and this is it ─────────────────────────────────────────
   *
   * Called from `loadProjectFromPath`, at the instant `pdfPathToLoad` is settled
   * and before anything is done with it. That is the single place a PROJECT's
   * displayed file is chosen — the route's default, the versions page's explicit
   * `?source=`, a restored tab and `openTarget`'s project branch all arrive at
   * it — so the redirect is stated once instead of at four call sites that can
   * drift. A loose file has no project and never reaches here; it is edited
   * standalone exactly as it was.
   *
   * ── Refusals are LOUD ───────────────────────────────────────────────────────
   *
   * A project that cannot be given a working copy throws, with main's own
   * sentence naming what is missing. Showing the read-only file instead would be
   * the precise failure this replaces: a window that promised the editable book
   * and quietly delivered the one the user must not touch.
   */
  private async resolveProjectOpen(
    projectDir: string,
    asked: string,
  ): Promise<{ display: string; plan: ArtifactOpenPlan }> {
    // Main's answer about all three artifacts, in one round trip. This ask is
    // also what MINTS a first working copy (`projects:export-info`), so by the
    // time the plan is read the copy it may redirect to usually already exists.
    const info = await this.electronService.projectsExportInfo(projectDir);
    // The receipt, said here rather than waited for: this is the ask that
    // discovered the file was gone, and main reports a re-mint on exactly the
    // one that performed it. See `refreshBookEpub` for the whole of why.
    if (info.remint !== null) this.announceRemint(info.remint);

    const plan = planArtifactOpen({
      asked,
      archiveOriginal: info.archive ? info.archive.absPath : null,
      generatedEpub: info.generated ? info.generated.absPath : null,
      workingCopy: info.exported ? info.exported.absPath : null,
    });

    if (plan.kind !== 'working-copy') return { display: asked, plan };

    // Ensure rather than trust: the copy may never have been made, and this call
    // both mints it and names its chapter openings, which is what makes the
    // redirected book read the way a book opened any other way reads.
    const answer = await this.electronService.ensureWorkingEpub(projectDir);
    if (!answer.success || !answer.path) {
      throw new Error(answer.error
        || 'This project has no working copy and could not be given one, and the file you opened '
          + 'is archive-grade — nothing may write to it.');
    }
    if (answer.remint) this.announceRemint(answer.remint);
    return { display: answer.path, plan };
  }

  /**
   * The working copy was made again, and the user is owed the receipt.
   *
   * One wording, in one place, because a re-mint is reported from three asks now
   * — the project's own opening, the banner's button and the redirect above —
   * and three spellings of it would read as three different events.
   */
  private announceRemint(remint: WorkingCopyRemint): void {
    this.showAlert({
      title: 'The working copy was created again, and the book was started over',
      message: describeWorkingCopyRemint(remint),
      type: 'info',
    });
  }

  /**
   * Show one of this project's files, closing whatever is on screen for it.
   *
   * Named for the artifact rather than for the book because it is handed a book
   * on almost every call and an archive on one: the erase re-opens the file the
   * user was standing on, and for a project that has no book yet that is its
   * archive. The mechanics are identical either way — this closes a document and
   * opens another one inside the same project.
   */
  private async showArtifact(artifactPath: string): Promise<void> {
    this.loading.set(true);
    this.loadingText.set('Opening the book...');
    try {
      // The tab is dropped first because `loadPdf` refuses a document that is
      // already open, and `artifactSwapping` is what keeps the close-then-open
      // from being read as the user leaving the project.
      const currentDocId = this.activeDocumentId();
      if (currentDocId) {
        this.openDocuments.update(docs => docs.filter(d => d.id !== currentDocId));
      }
      this.artifactSwapping = true;
      this.closePdf();
      await this.loadPdf(artifactPath);
      this.activatePanel(null);
    } catch (error) {
      this.showAlert({
        title: 'Could not open the file',
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    } finally {
      this.artifactSwapping = false;
      this.loading.set(false);
    }
  }

  /**
   * Why this window cannot hand its book to narration, or null.
   *
   * Read by the Next button and by its tooltip, so a lock is explained with one
   * sentence rather than two that can drift. Narration takes a BOOK, so this is
   * offered only while one is on screen — from a PDF there is nothing to hand.
   */
  readonly narrationRefusalReason = computed<string | null>(() => {
    if (!this.viewingBook()) {
      return 'Narration reads the book. Open this project\'s EPUB to hand it on.';
    }
    const noProject = this.noProjectReason();
    if (noProject) return noProject;
    return narrationRefusal({ bookEpubExists: this.bookEpubPath() !== null });
  });

  /**
   * Hand the finished book on: put the user in front of narration, then close.
   *
   * Three acts, and the ORDER is the design:
   *
   *  1. Ask MAIN to raise the main window and open narration for this project
   *     (`app:show-narration`). The picker is often its own BrowserWindow and
   *     has no reach into the main window's router.
   *  2. A refusal is SAID, and the window stays open. Closing on a failed
   *     hand-off would leave the user with no picker, no narration and no
   *     explanation of where their book went.
   *  3. Only then is the host told this window's work is done — and it is told
   *     with its OWN event. `finalized` means "the book has been written", which
   *     the host answers with a success toast and a delayed close; a hand-off
   *     has already moved the user to another window, so a toast here is
   *     addressed to nobody and the delay is a window lingering over a book the
   *     user has left.
   */
  async goToNarration(): Promise<void> {
    if (this.narrationRefusalReason() !== null) return;
    const epubPath = this.bookEpubPath();
    const projectDir = this.projectPath();
    if (epubPath === null || !projectDir) {
      // Unreachable through the button, which is disabled with the sentence that
      // says so. Said out loud rather than returned in silence if some other
      // caller gets here.
      this.showAlert({
        title: 'Narration could not be opened',
        message: 'This window is not on a project with a book, so there is nothing to narrate.',
        type: 'error',
      });
      return;
    }

    try {
      await this.electronService.showNarration(projectDir);
    } catch (err) {
      // Main's own sentence — it knows which half was missing.
      this.showAlert({
        title: 'Could not open narration',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
      return;
    }

    // The window holds no unsaved book state: every curation edit is already an
    // incremental update in the working document, and the strikes on a book are
    // saved before this. Cleared only now, once the hand-off has been accepted.
    this.editorState.hasUnsavedChanges.set(false);
    this.handedOffToNarration.emit({ projectDir, epubPath });
  }

  /**
   * A pass replaced the book in place — show the file that is there NOW.
   *
   * The passes rewrite `outputs.epub` at its own path, so nothing about the
   * window's idea of where the book is has changed and nothing would prompt it
   * to re-read: a picker showing the book would go on rendering the bytes it
   * loaded before the run. So the provenance is re-asked (the rail's pass
   * statuses come from it) and, when the book is what is on screen, the file is
   * loaded again. `showArtifact` closes the tab and re-opens it, and the
   * analysis cache is keyed by the file's SHA-256, so the rewritten book is
   * analysed afresh rather than served from the old one's entry.
   */
  async onBookReplacedByPass(): Promise<void> {
    await this.refreshBookEpub();
    if (!this.viewingBook()) return;
    const epubPath = this.bookEpubPath();
    // Unreachable in practice — a pass that landed recorded the book it wrote —
    // and said rather than ignored if main has stopped answering for it.
    if (!epubPath) {
      this.showAlert({
        title: 'The book was rewritten, but this window cannot find it',
        message: 'The pass finished and recorded its work, but this project no longer reports '
          + 'where its book is. Reopen the book from the versions page.',
        type: 'warning',
      });
      return;
    }
    await this.showArtifact(epubPath);
  }

  // ─── The narration copy ───────────────────────────────────────────────────

  /**
   * Write the TTS copy: the book minus what is struck out of it.
   *
   * ONE option is asked, because it is the one thing the copy does that the
   * strikes do not describe: a `<sup>55</sup>` left in the markup is read aloud
   * as "fifty-five", and that is not something the user can see struck through
   * on the page. It DEFAULTS ON — every audiobook wants it — and it is offered
   * rather than assumed because a book of numbered chapter epigraphs is a real
   * book and the strip cannot tell one from a footnote reference.
   *
   * The strikes are SAVED first, synchronously, and the export then reads them
   * off the manifest rather than being handed a list — so the file that lands is
   * always explained by a record, and there is no way to produce one that is not.
   *
   * Public because the bottom-right primary action calls it directly. It is no
   * longer reachable through the rail (2026-08-08), so the rail's disabled-task
   * gate no longer stands in front of it — the refusal it has to honour is its
   * own, and it is asked for here.
   */
  async exportTtsCopy(): Promise<void> {
    if (this.narrationExportRefusal() !== null) return;
    const dir = this.projectPath();
    if (!dir) return;

    const choice = await this.dialogService.confirmWithCheckbox({
      title: NARRATION_EXPORT_LABEL,
      message:
        'The narration copy is the book minus what you have struck out. The book itself is never '
        + 'rewritten — this writes a second file beside it.',
      checkboxLabel: 'Remove footnote reference numbers',
      checkboxChecked: true,
      confirmLabel: 'Export',
      cancelLabel: 'Cancel',
      type: 'question',
    });
    if (!choice.confirmed) return;

    this.loading.set(true);
    this.loadingText.set('Writing the TTS copy...');
    try {
      // Whatever this window has posted and not yet heard back about. There is
      // nothing to SAVE here any more — the record already is the state, and the
      // export reads it — but a gesture still in flight must land before the
      // cut, or the file would be one gesture behind the screen.
      await this.narrationEdits;

      // ── The screen and the record must agree before a file is cut ─────────
      //
      // The cut is made from the RECORD. The user's belief about what is in it
      // comes from the SCREEN. Any difference between the two is a file that is
      // not what the person who asked for it thinks it is, so it is a refusal
      // here rather than a reconciliation: reconciling would mean this window
      // deciding which of the two is right, and it is exactly the window whose
      // view was wrong when this was measured.
      const divergence = this.narrationExportDivergence();
      if (divergence !== null) {
        throw new Error(divergence);
      }

      const answer = await this.electronService.exportNarrationEpub(dir, {
        stripSupMarkers: choice.checkboxChecked,
      });
      if (!answer.success || !answer.result) {
        throw new Error(answer.error || 'The TTS copy could not be written.');
      }
      const { result } = answer;
      await this.refreshNarrationState();

      // The two records, counted apart. `translated` is what the editor's own
      // page and block deletions added that the strike record did not already
      // name — it is zero for a book curated since the picker recorded both,
      // and it is the whole story for one curated before.
      const provenance = result.translated > 0
        ? ` (${result.fromStrikes} already struck, ${result.translated} translated from pages and `
          + 'blocks deleted in the editor)'
        : '';
      // Main's own report of what the cut could not strike, alone. The picker's
      // derivation (`narrationUnstruckReport`) computes the SAME facts from the
      // same deletion sets over the same book — showing both here repeated every
      // sentence twice ("5 deleted page(s) had nothing…" appeared once from
      // each), and the export's report is the authoritative one because it
      // describes the cut that actually ran, not the editor's preview of it.
      const unresolved = [result.unresolved]
        .filter((s): s is string => s !== null && s.length > 0);

      // A document the strikes emptied is taken out of the copy rather than left
      // in it as a blank page. Said, and said with NAMES, because this is the
      // sentence that answers the question the user opens the copy to ask: they
      // deleted 64 pages, and if two documents' worth of them are simply not in
      // the book any more they need to be told that rather than left to wonder
      // whether the pages went missing or the deletion went wrong.
      const pruned = result.removedDocuments.length === 0
        ? ''
        : ` ${result.removedDocuments.length} document(s) your deletions emptied were removed `
          + `from the copy rather than left as blank pages: `
          + `${result.removedDocuments.map(d => d.split('/').pop()).join(', ')}.`;

      // The chapter-name rule, reported when it did anything: an opener that
      // prints "2" is in the copy as "Chapter 2: An Opportunity to Hope", and
      // the user checking the copy should know that was deliberate.
      const spoken = result.overriddenChapterOpenings > 0
        ? ` ${result.overriddenChapterOpenings} chapter opening(s) are written as their stored `
          + 'chapter names, each on a single line.'
        : '';

      this.showAlert({
        title: 'TTS copy written',
        message:
          `${result.relPath} — ${result.removedElements} of ${result.totalElements} element(s) `
          + `left out${provenance}, ${result.removedSupMarkers} footnote marker(s) stripped. The book `
          + `itself is unchanged.${spoken}${pruned}`
          + (unresolved.length > 0 ? `\n\n${unresolved.join('\n\n')}` : '')
          + '\n\nThe Process tab\'s narration step will offer this file.',
        type: unresolved.length > 0 ? 'warning' : 'info',
      });
    } catch (err) {
      this.showAlert({
        title: 'Could not write the TTS copy',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The book on screen as a VIEWER-AGNOSTIC book — the boundary the strike
   * machinery reads across, rather than this viewer's own block model.
   *
   * The raster viewer is the only viewer today, so this is a mapping of
   * `TextBlock[]`/`PageDimension[]`. That is the whole point: it is the proof
   * that the shape a live-DOM EPUB viewer will produce is a shape THIS viewer
   * already produces, so the deletion and strike paths never learn which one is
   * mounted. Geometry rides along inside `LaidOutBlock.geometry` and nothing
   * below this line reads it.
   *
   * Provenance is REQUIRED by the contract and this window either knows it or
   * refuses. It cannot be defaulted: `heuristic` is a claim (the document states
   * no categories), not a stand-in for not knowing, and the analyzer guarantees
   * it is stated wherever blocks are — so a book with blocks and no provenance
   * is a bug that gets named here instead of being painted over.
   */
  private laidOutBook(): LaidOutBook {
    const provenance = this.editorState.categoryProvenance();
    if (provenance === null) {
      throw new Error(
        'This document has blocks on screen but no record of where their categories came from, '
        + 'so the book cannot be described. Close and re-open it; if it persists, clear the '
        + 'analysis cache for this file.',
      );
    }
    return toLaidOutBook(this.blocks(), this.pageDimensions(), provenance);
  }

  /**
   * The blocks of the book on screen, in the shape the strike derivation reads.
   *
   * One place, because the derivation and the restore both need it and two
   * mappings of the same block list is two answers to "what did the aligner
   * place this block on".
   *
   * Reads `LaidOutBlock`, not `TextBlock`: every field it takes is in the
   * MEANING half of the contract, which is exactly why the strike machinery can
   * outlive the raster viewer. `bf_element` keeps flowing through here even
   * though a DOM viewer's blocks would be 1:1 with elements — the escalation to
   * a whole-document key and the unstruck-deletion diagnostics live inside
   * `deriveNarrationStrikes` and are lost the moment anything routes around it.
   */
  private narrationLaidOutBlocks(): NarrationLaidOutBlock[] {
    // A book with no blocks projects to no blocks, and it also has no
    // provenance to state — describing it is neither possible nor needed.
    // (Both branches return the same thing for an empty list; this one just
    // does not ask a question nobody has an answer to yet.)
    if (this.blocks().length === 0) return [];
    const laid: readonly LaidOutBlock[] = this.laidOutBook().blocks;
    return laid.map(b => ({
      id: b.id,
      page: b.page,
      ...(b.bf_element !== undefined ? { element: b.bf_element } : {}),
      // The ONE class the aligner skips by design, read off the block's own
      // flag — see NarrationLaidOutBlock.unplaceable. `is_image` is NOT in here
      // any more: a picture is matched to an image element by document and
      // ordinal now, so an image block with no element is a REFUSAL to guess and
      // must be reported like any other deletion that reached nothing.
      //
      // The flag is declared optional on LaidOutBlock and an absent one means
      // the block is not a marker: it is set on every block the analyzer produces,
      // and the picker's own constructed blocks set it literally false. A real
      // state, not a missing fact, which is why it is read as one here.
      unplaceable: b.is_footnote_marker === true,
      excerpt: b.text.slice(0, 80),
    }));
  }

  /**
   * What the last gesture could NOT strike, or null when it struck everything
   * the user deleted.
   *
   * Held so the export can say it at the moment the user asks for the file. A
   * modal per gesture would make the picker unusable — but a deletion that
   * quietly does nothing is exactly the failure this whole change is about, so
   * it is said on the console as it happens and in front of the user at export.
   */
  private readonly narrationUnstruckReport = signal<string | null>(null);

  /**
   * The strike edits this window has in flight, chained.
   *
   * Each is a read-modify-write of one manifest record. Main takes the project
   * lock for each, so two of them cannot interleave ON DISK — but two of them
   * racing would still land in an order this window did not choose, and the
   * order of a strike and the unstrike that follows it is the whole meaning of
   * an undo. So they are posted one after another, in gesture order.
   */
  private narrationEdits: Promise<void> = Promise.resolve();

  /**
   * Send ONE GESTURE to the record: what it struck, and what it put back.
   *
   * ── Why a difference, computed from the same layout, twice ─────────────────
   *
   * The two derivations run over ONE `narrationLaidOutBlocks()` snapshot, so the
   * difference between them is exactly what this gesture changed and nothing
   * else — not a block the segmenter added between them, not a document that
   * reloaded underneath. And it is a DIFFERENCE rather than the "after" set
   * because the after set is a view, and a view that has just been reset is
   * indistinguishable from a book with nothing struck in it. That mistake is
   * what this whole change exists to end: the old debounced save derived the
   * WHOLE record from these two signals and overwrote the manifest with it.
   *
   * Taking the difference is also what makes overlapping gestures come out
   * right. An element two blocks were laid out from stays struck when only one
   * of them is restored, because it is still in the after set — nothing has to
   * remember which gesture named it.
   */
  private postNarrationEdit(
    beforeBlockIds: ReadonlySet<string>,
    beforePages: ReadonlySet<number>,
    afterBlockIds: ReadonlySet<string>,
    afterPages: ReadonlySet<number>,
  ): void {
    // Not a book, so there is no strike record for this gesture to land in.
    // A domain boundary, not a swallowed failure: the working PDF's own writer
    // (`landBlockDeletions`) answers for that artifact.
    if (!this.canStrikeForNarration()) return;
    // The strikes are one of the records the erase clears, and this window's
    // struck sets are what it is clearing them of — see `eraseAllChanges`.
    if (this.erasing()) {
      console.warn('[picker] not recording narration deletions: this project\'s changes are being erased.');
      return;
    }
    const dir = this.projectPath();
    if (!dir) {
      // The book on screen IS this project's working copy — that is what
      // `canStrikeForNarration` just said — so there is no reading of a missing
      // project path other than a bug, and a gesture that quietly did nothing is
      // the failure this whole contract exists to end.
      throw new Error(
        'A book is on screen for narration curation and this window has no project directory, so '
        + 'the deletion has nowhere to be recorded.'
      );
    }

    const laid = this.narrationLaidOutBlocks();
    const before = deriveNarrationStrikes(laid, beforeBlockIds, beforePages);
    const after = deriveNarrationStrikes(laid, afterBlockIds, afterPages);

    const unstruck = describeUnstruckDeletions(after);
    this.narrationUnstruckReport.set(unstruck);
    if (unstruck) console.warn('[picker] narration strikes:', unstruck);

    const edit = narrationDeletionEdit(new Set(before.elements), new Set(after.elements));
    if (edit.strike.length === 0 && edit.unstrike.length === 0) return;
    this.sendNarrationEdit(dir, edit);
  }

  /**
   * Post one edit, behind whatever this window has already posted — and RECONCILE
   * the screen with the answer.
   *
   * ── The screen may not show a deletion the record does not have ────────────
   *
   * Owen, 2026-08-09: "it should just delete the blocks we tell it to delete,
   * without fail. a guarantee; a promise."
   *
   * This used to post the edit, and on failure show an alert and leave the
   * strike on screen. That is the exact shape of the measured failure: the user
   * saw 36 footnotes struck through in chapter one, the record held 31, and the
   * copy was cut from the record. An alert cannot fix that — it is one modal
   * against a page of strike-through the user goes on trusting for the rest of
   * the evening.
   *
   * So the answer decides what is on screen, both ways. On success the returned
   * record IS the new truth and the view is checked against it. On failure the
   * view is REPAINTED from the record as main still has it, which puts the
   * user's deletion back on the page exactly as it was before the gesture, and
   * the alert says which blocks refused and why.
   */
  private sendNarrationEdit(dir: string, edit: NarrationDeletionEdit): void {
    const posted: Promise<void> = this.narrationEdits.then(async () => {
      const answer = await this.electronService.editNarrationDeletions(dir, edit);
      if (!answer.success || !answer.deletions) {
        throw new Error(answer.error || 'The narration deletions could not be recorded.');
      }
      const recorded = answer.deletions;
      // The record main just wrote, kept here so the next gesture's rebuild and
      // the export's report describe the same answer the file does.
      const state = this.narrationAnswer();
      if (state && state.dir === dir) {
        this.narrationAnswer.set({ dir, state: { ...state.state, deletions: recorded } });
      }
      // The tripwire runs AFTER the restore effect has consumed this answer —
      // never in the same turn. `narrationRestoreEffect` deliberately rewinds
      // the view to the record's state while a gesture's write is in flight
      // ("the view cannot hold a deletion the record does not have for longer
      // than a tick"), so at THIS moment the screen may be standing in the
      // rewound state; comparing the fresh record against it reports the whole
      // gesture as missing and tells the user their screen is wrong when it is
      // one effect-flush away from correct (measured 2026-08-09: a 320-element
      // footnote sweep on an empty record fired exactly that modal). A
      // macrotask runs after the flush. And only the LAST in-flight gesture
      // checks: while the queue drains, the screen is legitimately ahead of
      // the record it is being compared with.
      setTimeout(() => {
        if (this.narrationEdits !== posted) return;
        this.assertNarrationViewMatchesRecord(recorded);
      }, 0);
    }).catch(async (err) => {
      console.error('[picker] could not record the narration deletions:', err);
      await this.undoUnrecordedGesture(edit, err);
    });
    this.narrationEdits = posted;
  }

  /**
   * A gesture the record refused: take it off the screen, and say what refused.
   *
   * The record is re-read from main rather than assumed, because the reason the
   * edit failed may be that main knows something this window does not (the book
   * moved on, another window struck something). Repainting from what main
   * actually has is the only statement that cannot be wrong in the dangerous
   * direction.
   */
  private async undoUnrecordedGesture(edit: NarrationDeletionEdit, err: unknown): Promise<void> {
    const named = edit.strike.length > 0 ? edit.strike : edit.unstrike;
    const SHOWN = 5;
    const which = named.slice(0, SHOWN).map(k => `  • ${this.narrationElementLabel(k)}`).join('\n')
      + (named.length > SHOWN ? `\n  • …and ${named.length - SHOWN} more` : '');

    let repainted = true;
    try {
      await this.refreshNarrationState();
      this.repaintNarrationFromRecord();
    } catch (repaintErr) {
      repainted = false;
      console.error('[picker] could not repaint the view from the record:', repaintErr);
    }

    this.showAlert({
      title: repainted
        ? 'That deletion was not recorded, so it has been undone'
        : 'That deletion was not recorded',
      message:
        `${named.length} element(s) could not be ${edit.strike.length > 0 ? 'struck' : 'restored'}:\n`
        + `${which}\n\n${err instanceof Error ? err.message : String(err)}\n\n`
        + (repainted
          ? 'The page has been put back the way the record has it, so what you see is what will be '
            + 'left out of the narration copy. Try the deletion again.'
          : 'The narration copy is cut from the record, so what you just struck out would still be '
            + 'read aloud, and this window could not put the page back. Re-open the book.'),
      type: 'error',
    });
  }

  /** An element key, said the way the user can recognize it: page and opening. */
  private narrationElementLabel(key: NarrationElementKey): string {
    const block = this.blocks().find(b => b.bf_element === key);
    if (!block) return key;
    return `page ${block.page + 1}, "${block.text.trim().slice(0, 60)}"`;
  }

  /**
   * Repaint the two deletion signals from the record, WHATEVER is in them now.
   *
   * `rebuildNarrationView` is idempotent and cheap, but it is guarded by a key
   * so opening a book does not repaint on every block that streams in. This
   * clears the key, which is the difference between "paint if something changed"
   * and "the record is the truth, put it on the screen".
   */
  private repaintNarrationFromRecord(): void {
    this.appliedNarrationKey = '';
    this.rebuildNarrationView();
  }

  /**
   * THE TRIPWIRE: what is on screen, derived, against what the record says.
   *
   * Cheap (one derivation over the block list this window already holds) and
   * always on, because the whole class of bug this change exists to end is a
   * divergence nobody notices. Every gesture path was audited and funnelled;
   * this is what catches the one that was missed, or the one somebody adds next
   * year.
   *
   * ── Why only one direction is unconditional ────────────────────────────────
   *
   * ON SCREEN BUT NOT RECORDED is always a bug: the user is looking at a
   * deletion that will not happen. RECORDED BUT NOT ON SCREEN is only a bug once
   * the book is fully laid out — while pages are still streaming in, a recorded
   * element whose blocks do not exist yet cannot be derived from a view that
   * does not contain them, and reporting that would cry wolf on every open.
   */
  /**
   * A deletion set with every `#doc` key expanded to the document's elements.
   *
   * A fully-struck document has TWO spellings — its elements one by one, or
   * the single `<file>#doc` escalation — and which one a set carries depends
   * on when it was written (a record laid down element-by-element across
   * sessions keeps the elements; a fresh derivation escalates). They mean the
   * SAME deletion, so every comparison of two sets must expand both sides
   * first or it reports a divergence over notation (measured: copy.xhtml as
   * 18 recorded elements vs the screen's one #doc — the same struck page).
   */
  private expandDocDeletionKeys(
    elements: Iterable<string>,
    laid: readonly NarrationLaidOutBlock[],
  ): Set<string> {
    const out = new Set<string>();
    let byFile: Map<string, string[]> | null = null;
    for (const key of elements) {
      if (parseNarrationElementKey(key).kind !== 'doc') { out.add(key); continue; }
      if (byFile === null) {
        byFile = new Map();
        for (const b of laid) {
          if (b.element === undefined) continue;
          const file = parseNarrationElementKey(b.element).file;
          let list = byFile.get(file);
          if (!list) { list = []; byFile.set(file, list); }
          list.push(b.element);
        }
      }
      for (const el of byFile.get(parseNarrationElementKey(key).file) ?? []) out.add(el);
    }
    return out;
  }

  private assertNarrationViewMatchesRecord(record: NarrationDeletions): void {
    const laid = this.narrationLaidOutBlocks();
    if (laid.length === 0) return;
    const view = deriveNarrationStrikes(
      laid, this.narrationStruckBlockIds(), this.deletedPages());
    const diff = narrationDeletionEdit(
      this.expandDocDeletionKeys(record.elements, laid),
      this.expandDocDeletionKeys(view.elements, laid));
    const fullyLoaded = this.pagesLoaded() >= this.totalPages();
    const onScreenOnly = diff.strike;
    const recordedOnly = fullyLoaded ? diff.unstrike : [];
    if (onScreenOnly.length === 0 && recordedOnly.length === 0) return;

    const parts: string[] = [];
    if (onScreenOnly.length > 0) {
      parts.push(
        `${onScreenOnly.length} element(s) are struck through on screen and are NOT in the record, `
        + `so they would still be read aloud — the first is ${onScreenOnly[0]}.`);
    }
    if (recordedOnly.length > 0) {
      parts.push(
        `${recordedOnly.length} element(s) are in the record and are NOT struck through on screen `
        + `— the first is ${recordedOnly[0]}.`);
    }
    const sentence = parts.join(' ');
    console.error('[picker] narration view/record divergence:', sentence, diff);

    // SURFACED, because a tripwire nobody sees is a log line in a build nobody
    // runs with the console open. Once per distinct divergence: it can only fire
    // on a bug, and when it does it fires on every gesture after the one that
    // caused it, which would be a modal the user cannot get past.
    if (this.surfacedNarrationDivergence === sentence) return;
    this.surfacedNarrationDivergence = sentence;
    this.showAlert({
      title: 'What is on screen and what is recorded have come apart',
      message:
        `${sentence}\n\nThe narration copy is cut from the record, so the screen is the one that `
        + 'is wrong. Re-open the book to put the record on screen. Export will refuse until they '
        + 'agree.',
      type: 'error',
    });
  }

  /**
   * The divergence sentence this window has already put in front of the user.
   *
   * Not a signal: nothing renders it, and it exists only so the same bug is not
   * reported twice on two consecutive gestures.
   */
  private surfacedNarrationDivergence: string | null = null;

  /**
   * Why this window must NOT export a narration copy right now, or null.
   *
   * Three questions, asked of the live view against the record main last gave
   * this window, at the one moment it decides what a file contains:
   *
   *  1. Is anything struck through on screen that the record does not have?
   *     That is a deletion that would not happen.
   *  2. Is anything in the record that is not struck through on screen? That is
   *     a deletion the user cannot see and did not ask for. Only asked once the
   *     book is fully laid out, for the reason in `assertNarrationViewMatchesRecord`.
   *  3. Did anything the user deleted reach no markup at all? Then the copy
   *     cannot leave it out, and main will refuse too — but this window can say
   *     it with the page and the words on it, which main cannot.
   */
  private narrationExportDivergence(): string | null {
    if (!this.canStrikeForNarration()) return null;
    const record = this.narrationState()?.deletions;
    const laid = this.narrationLaidOutBlocks();
    if (laid.length === 0) return null;

    const view = deriveNarrationStrikes(laid, this.narrationStruckBlockIds(), this.deletedPages());

    const unstruck = describeUnstruckDeletions(view);
    if (unstruck !== null) {
      return (
        'The narration copy was not written, because some of what you deleted could not be matched '
        + `to the book's markup.\n\n${unstruck}\n\nStrike the whole page or the whole document `
        + 'those blocks are in — a document is removed by name, so everything in it goes whether or '
        + 'not each piece could be identified — or restore them, and export again.'
      );
    }

    const diff = narrationDeletionEdit(
      this.expandDocDeletionKeys(record?.elements ?? [], laid),
      this.expandDocDeletionKeys(view.elements, laid));
    const onScreenOnly = diff.strike;
    const recordedOnly = this.pagesLoaded() >= this.totalPages() ? diff.unstrike : [];
    if (onScreenOnly.length === 0 && recordedOnly.length === 0) return null;

    const SHOWN = 5;
    const list = (keys: readonly string[]): string =>
      keys.slice(0, SHOWN).map(k => `  • ${this.narrationElementLabel(k)}`).join('\n')
      + (keys.length > SHOWN ? `\n  • …and ${keys.length - SHOWN} more` : '');

    const parts: string[] = [];
    if (onScreenOnly.length > 0) {
      parts.push(
        `${onScreenOnly.length} element(s) are struck through on this page and are NOT in the `
        + `record the copy is cut from, so they would be read aloud:\n${list(onScreenOnly)}`);
    }
    if (recordedOnly.length > 0) {
      parts.push(
        `${recordedOnly.length} element(s) are in the record and are NOT struck through on this `
        + `page, so they would be left out without your having asked:\n${list(recordedOnly)}`);
    }
    return (
      'The narration copy was not written, because what is on screen and what is recorded do not '
      + `agree.\n\n${parts.join('\n\n')}\n\nNothing was written. Re-open the book — the record is `
      + 'what it will be cut from, and re-opening puts exactly that on screen.'
    );
  }

  /**
   * A gesture that means "everywhere in this book" is REFUSED while the book is
   * still being laid out.
   *
   * ── Why a bulk gesture over a partial book is worse than no gesture ────────
   *
   * "Delete all like this" acts on the blocks that exist RIGHT NOW. Pressed at
   * page 40 of 240 it deletes a sixth of what the user meant, reports nothing
   * unusual, and leaves a book whose footnotes are struck out at the front and
   * read aloud from chapter four on — which is indistinguishable, on screen,
   * from a book where the gesture worked. Every deletion it did make is recorded
   * correctly, so nothing downstream can tell either.
   *
   * The refusal names the numbers because "still loading" alone does not tell
   * the user whether to wait five seconds or two minutes.
   */
  private refuseBulkGestureWhileLoading(what: string): boolean {
    const total = this.totalPages();
    const loaded = this.pagesLoaded();
    if (total === 0 || loaded >= total) return false;
    this.showAlert({
      title: 'The book is still loading',
      message:
        `${what} acts on every page of the book, and only ${loaded} of ${total} are laid out so `
        + 'far. Doing it now would silently leave out everything on the pages that have not '
        + 'arrived. Wait for the page count to finish, then try again.',
      type: 'warning',
    });
    return true;
  }

  /**
   * The struck block ids AS A STRIKE RECORD reads them: the deletion set, minus
   * the blocks a SPLIT hid.
   *
   * `editorState.splitBlock` puts the original block's id in `deletedBlockIds`
   * to hide it behind its children — a re-segmentation of the view, not a
   * deletion, and the one writer of that signal that must never reach the
   * record. Left in, the next gesture's derivation would strike the paragraph
   * the user split, and it would be gone from the narration copy for good.
   *
   * The children carry no element key of their own, so a user who then deletes
   * them gets an honest "could not be matched" refusal at export rather than a
   * silent miss.
   */
  private narrationStruckBlockIds(): Set<string> {
    const struck = new Set(this.deletedBlockIds());
    for (const originalId of this.editorState.blockSplits().keys()) struck.delete(originalId);
    return struck;
  }

  /**
   * A BLOCK gesture, landed in the record.
   *
   * The "before" set is reconstructed from the ids the gesture acted on rather
   * than snapshotted, because every call site hands the ids in as the RESULT of
   * the editor-state call that already made the change (`landBlockDeletions(
   * this.editorState.deleteBlocks(ids), true)`). Reconstructing is exact — those
   * ids ARE the difference, reported by the one place that decided it.
   */
  private landNarrationBlockStrikes(blockIds: readonly string[], deleted: boolean): void {
    if (blockIds.length === 0 || !this.canStrikeForNarration()) return;
    const after = this.narrationStruckBlockIds();
    const before = new Set(after);
    for (const id of blockIds) {
      if (deleted) before.delete(id);
      else before.add(id);
    }
    const pages = this.deletedPages();
    this.postNarrationEdit(before, pages, after, pages);
  }

  /**
   * A PAGE gesture, landed in the record.
   *
   * A page deletion is the same statement as striking every block laid out on
   * it, said in one gesture — `deriveNarrationStrikes` resolves it that way, so
   * the difference this posts is the page's own elements. With image blocks now
   * carrying element keys, that finally includes a page holding nothing but a
   * picture, which is the case that let cover, half-title and title pages
   * through to a finished narration copy.
   */
  private landNarrationPageStrikes(pages: readonly number[], deleted: boolean): void {
    if (pages.length === 0 || !this.canStrikeForNarration()) return;
    const after = this.deletedPages();
    const before = new Set(after);
    for (const p of pages) {
      if (deleted) before.delete(p);
      else before.add(p);
    }
    const blockIds = this.narrationStruckBlockIds();
    this.postNarrationEdit(blockIds, before, blockIds, after);
  }

  /**
   * UNDO and REDO, landed in the record as the difference they made.
   *
   * One history entry can restore a crop's worth of blocks, a class of them and
   * a page at once, and it says so in the editor's vocabulary rather than in
   * elements. So the honest reading is the same one the document mirror takes:
   * the two sets as they were before the entry was applied, against the two sets
   * now. The caller snapshots them immediately before calling `editorState.undo`
   * and hands them here, in the same handler, before anything else can write.
   */
  private landNarrationHistory(
    beforeBlockIds: ReadonlySet<string>,
    beforePages: ReadonlySet<number>,
  ): void {
    if (!this.canStrikeForNarration()) return;
    this.postNarrationEdit(
      beforeBlockIds, beforePages, this.narrationStruckBlockIds(), this.deletedPages());
  }

  /**
   * PAINT the record: the editor's two deletion sets, rebuilt from what is
   * recorded, replacing whatever was in them.
   *
   * ── The inversion this is half of ──────────────────────────────────────────
   *
   * `outputs.epub.narrationDeletions` is the state. These two signals are a VIEW
   * of it, and every gesture posts its difference to the record rather than the
   * record being re-derived from them. So opening a book is a rebuild, and it
   * writes nothing at all — there is nothing to write.
   *
   * ── Which of the two sets a strike shows up in ─────────────────────────────
   *
   * The record does not say whether the user struck a page or its blocks, and it
   * does not need to: both resolve to the same elements. But the SCREEN has to
   * choose, and the choice matters for what the next gesture can undo. A page
   * every strikeable block of which is struck is presented as a deleted PAGE,
   * and its blocks are then left out of the block set — otherwise restoring the
   * page would leave several hundred block deletions the user never made, and
   * the page would come back still struck through.
   *
   * One element can own SEVERAL blocks (mupdf re-lays the book out and a
   * paragraph becomes one block per visual line), so the fan-out is a fan-out
   * and every block of a struck element is struck.
   *
   * ── A struck DOCUMENT ──────────────────────────────────────────────────────
   *
   * `<zip entry>#doc` fans out to every block of that document
   * (`narrationDeletedBlockIds`), which is the exact inverse of the escalation
   * that produced it — so the next gesture's "before" derivation over this view
   * returns the document key rather than its elements, and a reload does not
   * rewrite the shape of the record.
   *
   * A page holding NOTHING that could be struck stays undeleted on screen even
   * inside a struck document — the plate gallery's middle pages hold no text at
   * all, so no block on them names the document, and presenting them as deleted
   * would be a claim this projection has no evidence for. Their pictures go with
   * the document at the cut all the same.
   */
  private rebuildNarrationView(): void {
    const recorded = this.narrationState()?.deletions;
    const blocks = this.blocks();
    const struckIds = new Set(
      recorded === undefined || recorded === null
        ? []
        : narrationDeletedBlockIds(
            blocks.map(b => ({
              id: b.id,
              ...(b.bf_element !== undefined ? { element: b.bf_element } : {}),
            })),
            recorded.elements,
          ),
    );

    const pages = narrationDeletedPages(this.narrationLaidOutBlocks(), struckIds);
    const pageOf = new Map(blocks.map(b => [b.id, b.page]));
    for (const id of [...struckIds]) {
      const page = pageOf.get(id);
      if (page !== undefined && pages.has(page)) struckIds.delete(id);
    }

    // The blocks a SPLIT hid are put back: they are in `deletedBlockIds` to be
    // invisible behind their children, not because anything struck them, and the
    // record has nothing to say about them either way. Painting the record over
    // them would make every split block on screen reappear on top of its own
    // children — see `narrationStruckBlockIds` for the same boundary read from
    // the other end.
    for (const originalId of this.editorState.blockSplits().keys()) struckIds.add(originalId);

    // Set, never `deleteBlocks`: this is the view being brought in line with the
    // record, not an edit. Going through the editor's deletion methods would
    // push an undo entry for work the user did in another session, and mark the
    // project dirty for a change that is not one.
    this.editorState.deletedBlockIds.set(struckIds);
    this.editorState.deletedPages.set(pages);
  }

  /**
   * A rail entry that runs a pass over the book was pressed.
   *
   * Both are AI runs over a whole book — hours — so both go to the queue, and
   * their options dialog is where their settings are chosen.
   */
  private startEpubPass(kind: EpubPassTaskId): void {
    switch (kind) {
      case 'simplify':
        this.passOptionsKind.set('simplify');
        return;
      case 'translate':
        this.passOptionsKind.set('translate');
        return;
      default: {
        const unknown: never = kind;
        throw new Error(`There is no ${String(unknown)} pass on the rail.`);
      }
    }
  }

  /**
   * Queue one text pass over this project's book.
   *
   * Simplify and Translate: AI rewrites of a whole book, hours each, so the
   * queue is where they are watched and cancelled.
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
   * Answers whether the run was QUEUED so a caller can tell a refusal from a
   * submission — the refusal itself is main's own sentence, shown verbatim.
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
  /** Formats the export dialog must show as disabled, with the sentence why. */
  readonly exportFormatRefusals = computed<Partial<Record<ExportFormat, string>>>(() => {
    const pdf = this.exportPdfRefusal();
    return pdf === null ? {} : { pdf };
  });

  private async exportAsPdf(settings: ExportSettings): Promise<void> {
    // The format button is disabled and carries this sentence. Said again here
    // because `onExportSettingsResult` routes anything it does not recognise to
    // this method, so "PDF" is also what an unknown format becomes — and that
    // must not turn into a silent nothing on a book with no pages to render.
    const refusal = this.exportPdfRefusal();
    if (refusal !== null) {
      this.showAlert({ title: 'Cannot export this book as a PDF', message: refusal, type: 'warning' });
      return;
    }

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
   * Bind an embedded window to the project that CONTAINS the file it opened.
   *
   * The matcher's first rule is directory containment, so a variant opened out
   * of `projects/<slug>/archive/` resolves to `<slug>` without touching a hash
   * or a filename. A file that belongs to no project leaves the window
   * unbound, which is the honest answer — the rail entries then refuse by name
   * and nothing is invented.
   */
  private async bindContainingProject(filePath: string): Promise<void> {
    if (this.bindingProject) return;   // restoreProjectState re-enters loadPdf
    this.bindingProject = true;
    try {
      const match = await this.electronService.findManifestProjectBySource(
        this.fileHash(), filePath);
      if (match.found && match.projectPath) {
        await this.restoreProjectState(match.projectPath);
      }
    } finally {
      this.bindingProject = false;
    }
  }

  private bindingProject = false;

  private async autoCreateProject(pdfPath: string, pdfName: string): Promise<void> {

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
    this.announceLayoutState(project, projectFilePath);
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
    // An erase is in flight: this window's edit set is the thing being thrown
    // away, so scheduling a write of it is scheduling the erase to be undone.
    // See eraseAllChanges for the whole of the rule.
    if (this.erasing()) {
      console.warn('[scheduleAutoSave] Suppressed: this project\'s changes are being erased.');
      return;
    }

    // A session that declined to load the project's edits must not autosave over
    // them — see projectStateNotApplied. Silent by design: the user was told once,
    // with an alert, when the document was bound.
    if (this.projectStateNotApplied()) {
      console.warn('[scheduleAutoSave] Suppressed: the project\'s saved edits were not loaded into this document.');
      return;
    }

    // A BOOK on screen is a DERIVED artifact and the manifest describes the
    // SOURCE. An auto-save here either writes this session's state (the book's
    // own blocks, no deletions, no merges) over the source's edit set, or,
    // with the binding dropped by the document swap, reaches autoCreateProject,
    // rebinds to the owning project and pulls the source's deletions and pages
    // onto the book (Working Towards The Führer, Aug 2 2026 — both arms of this
    // actually happened). A book is edited by the passes, on disk, and by the
    // narration strikes, in the manifest's own record — never through this.
    if (this.viewingBook()) return;

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
    // Checked at fire time as well as at schedule time: a timer set before the
    // user pressed erase would otherwise land in the middle of it.
    if (this.erasing()) return;
    // Checked again at fire time: a save scheduled over the working copy can
    // reach this timer AFTER a swap put the book on screen, and it would then
    // run against the wrong document — see scheduleAutoSave.
    if (this.viewingBook()) return;

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

    // The manifest's editor state is being erased. Every field this would write
    // — the deletions, the undo stacks, the chapters, the corrections — is what
    // the erase is removing, so the write is refused for as long as the erase is
    // in flight, whichever caller reached here (an autosave timer that had
    // already fired, a save-on-close, finalize). This is the LAST gate rather
    // than the only one: eraseAllChanges also cancels the timers, and the gates
    // exist so a caller that arrives by some other route cannot get past.
    if (this.erasing()) {
      console.warn(`[saveProjectToPath] REFUSED ${filePath}: this project's changes are being erased.`);
      return;
    }

    // The one place every project-state write goes through, so the one place that
    // can guarantee a session which declined to load the project's edits cannot
    // overwrite them (see projectStateNotApplied). Callers that export as well as
    // save — finalizeProject — still export: the export
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
      // A save can succeed and still not have written the deletions: the
      // manifest keeps its old page and block records when this window was
      // never given them, rather than letting an empty set overwrite them. The
      // metadata and everything else DID go to disk, so this is not a failure —
      // but the user just pressed save on a book they have been striking out,
      // and must not be left believing those strikes are on file.
      //
      // Said even on a `silent` (auto)save. Silence is for routine success, and
      // "your deletions are not saved" is not routine.
      if (result.staleLayoutRefusal) {
        console.warn(`[saveProjectToPath] deletions NOT written: ${result.staleLayoutRefusal}`);
        this.showAlert({
          title: 'Deletions Not Saved',
          message:
            result.staleLayoutRefusal
            + '\n\nEverything else about the project was saved. To record what you have struck '
            + 'out in this session, the project has to be opened on the book those records can '
            + 'be read against.',
          type: 'warning',
        });
      }
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
  private async openTarget(
    target: string,
    opening: DocumentOpening,
    lightweight: boolean = false,
  ): Promise<void> {
    if (await this.electronService.fsExists(`${target}/manifest.json`)) {
      await this.loadProjectFromPath(target, opening, lightweight);
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

  async loadProjectFromPath(
    filePath: string,
    opening: DocumentOpening,
    lightweight: boolean = false,
  ): Promise<void> {
    // Clear sourceFilePath when opening a project - finalize must use the project export flow
    this.sourceFilePath.set(null);

    // Check if this project is already open
    const existingDoc = this.openDocuments().find(d => d.projectPath === filePath);
    if (existingDoc) {
      // Switch to existing tab
      this.saveCurrentDocumentState();
      this.restoreDocumentState(existingDoc.id);
      return;
    }

    // Shown BEFORE the call, not after it, because the slow thing happens
    // inside it. Opening an EPUB project saved before the quire cutover lays
    // the book out twice — once by mupdf to read what the old records meant,
    // once by quire to write them back — and until that returns there is
    // nothing else on screen to explain the wait. The main process reports its
    // own progress on `pdf:analyze-progress` while it runs, which upgrades this
    // to name the book; a project that needs no migration returns before the
    // first frame and this is never seen.
    this.loading.set(true);
    this.loadingText.set('Opening the project…');
    let result;
    const unsubMigration = this.electronService.onAnalyzeProgress((progress) => {
      this.loadingText.set(progress.message);
    });
    try {
      result = await this.electronService.projectsLoadFromPath(filePath);
    } finally {
      unsubMigration();
      this.loading.set(false);
    }

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
    this.announceLayoutState(project, result.filePath || filePath);
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

    // First, check if an override source path was provided (from version picker).
    //
    // With ONE exception, and it is an artifact swap rather than an open: a window
    // opened straight onto the built book (versions page → EPUB row → the
    // editor's `?source=`) carries that book in `overrideSourcePath` for its
    // whole life. Re-resolving it when the user presses the Working tab would
    // reload the book they are already looking at and call it going back — the
    // window would look broken, and the one way back to the source would be gone.
    // So a swap away from the book resolves the project's SOURCE instead.
    //
    // Narrowed to the project's own EXPORT on purpose: an EPUB-native book is
    // opened on `archive/<Book>.epub`, which is not an export but its original,
    // and the markup-preserving build aligns against exactly that file.
    const chosenPath = this.overrideSourcePath();
    const overridePath =
      chosenPath && this.artifactSwapping && this.isProjectOwnExport(chosenPath, project)
        ? null
        : chosenPath;
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

    // ── The archive-grade books redirect to the copy the user can edit ─────────
    //
    // THE choke point for a project open: everything above has decided which
    // file this project was POINTED at, and this decides which one it shows.
    // Reading pages into a book is the one act that cannot be done by copying,
    // so it is offered rather than performed — and offered AFTER the load, so
    // the pages are on screen behind the modal for a user who cancels.
    let openPlan: ArtifactOpenPlan;
    try {
      const resolved = await this.resolveProjectOpen(actualProjectPath, pdfPathToLoad);
      pdfPathToLoad = resolved.display;
      openPlan = resolved.plan;
    } catch (err) {
      this.loading.set(false);
      this.showAlert({
        title: 'Could not open this book',
        message: err instanceof Error ? err.message : String(err),
        type: 'error',
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
      this.surfaceAnalysisWarnings(quickResult.warnings, pdfPathToLoad);

      // Create new document for tabs
      const docId = this.generateDocumentId();

      // Is the file ON SCREEN the project's original source, rather than a
      // derived version (exported/cleaned)? This is what the tab is TITLED from,
      // so it is judged on the file actually displayed and on nothing else — a
      // derived book wearing the original's name is what made a correct export
      // read as "I am looking at the PDF again" (Aug 3 2026).
      const resolvedOriginalPath = project.library_path || project.source_path;
      const showingOriginal = !usingExportedEpub && (
        !overridePath ||  // No override in force = loading original
        pdfPathToLoad === resolvedOriginalPath ||  // Override matches original
        pdfPathToLoad === project.library_path  // Override is the library copy
      );

      // Do the project's saved edits DESCRIBE the file on screen? The same
      // question with one more true answer, and it is the redirect's: a swap to
      // the working copy put up a file minted as the archive original's exact
      // bytes (`mintWorkingCopyFrom` refuses to record one that is not), so
      // every block id and page number recorded against the original addresses
      // it precisely. Without this, the first seamless open of a book would take
      // the user's own deletions off their screen — the redirect would have
      // swapped in an identical file and been read as a different one.
      //
      // It is not a claim that the bytes are STILL identical: a pass rewrites
      // the working copy in place, and the SHA comparison below is what proves
      // that and drops the edits, exactly as it does for any other file.
      const isLoadingOriginal = showingOriginal || openPlan.kind === 'working-copy';

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
        name: showingOriginal ? (project.source_name || quickResult.pdf_name) : quickResult.pdf_name,
        blocks: quickResult.blocks || [],
        categories: quickResult.categories || {},
        categoryProvenance: statedProvenance(quickResult.categoryProvenance),
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
        categoryProvenance: statedProvenance(quickResult.categoryProvenance),
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

      // Start on-demand page rendering (skip if lightweight mode). NOT for an
      // EPUB: the rasters would be mupdf's OWN pagination of the book — a
      // different page count under the same page numbers — and the quire
      // viewer shows the live DOM, so nothing may display them. (Background
      // removal is a raster treatment, so it goes with them.)
      if (!lightweight && !renderPath.toLowerCase().endsWith('.epub')) {
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
          this.surfaceAnalysisWarnings(data.warnings, pdfPathToLoad);

          // Update blocks/categories from extraction
          if (this.activeDocumentId() === docId) {
            this.editorState.updateTextData({
              blocks: data.blocks as TextBlock[],
              categories: data.categories as Record<string, Category>,
              categoryProvenance: statedProvenance(data.categoryProvenance),
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

      // ── A PDF with no book behind it asks to have its pages read ────────────
      //
      // The same act the banner's Generate EPUB button performs, and reached
      // through the same call, so there is one way to start a conversion rather
      // than two that can drift. It is the MAIN window that shows the flow — it
      // owns the queue, and this window is usually its own BrowserWindow with
      // none — and the modal IS the confirmation: an hour of GPU is never a side
      // effect of opening a file. Awaited so a refusal is said, and said as a
      // warning rather than an error: the book did open, and the pages are on
      // screen to browse read-only either way.
      //
      // Only for an open somebody ASKED for — see DocumentOpening. A restored
      // tab that raised this would put a modal in front of a user who had just
      // started the app, once per PDF they had left open.
      if (openPlan.kind === 'offer-conversion' && opening === 'by-user') {
        try {
          await this.electronService.showBookConversion(actualProjectPath);
        } catch (err) {
          this.showAlert({
            title: 'Could not offer to read these pages',
            message: (err instanceof Error ? err.message : String(err))
              + '\n\nThe PDF is open and can be browsed; run Convert to EPUB from the versions page '
              + 'to make a book you can edit.',
            type: 'warning',
          });
        }
      }

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
   */
  setNavTab(tab: DocumentNavTab): void {
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

    // The book's entries START WORK rather than open a panel. They keep no
    // `activePanel` for the same reason Select does not: what they leave behind
    // is a file or a record, and the rail reads that back.
    if (id !== 'analysis' && isEpubPassId(id)) {
      this.startEpubPass(id);
      return;
    }
    // Select owns no panel: choosing it closes whatever panel had taken over the
    // pointer, so the click does what it looks like it does.
    if (id === 'select') {
      this.setNavTab('select');
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
    if (this.documentLayerLive() && this.blocks().some(b => b.id === chapterId)) {
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
    if (this.documentLayerLive()) {
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
    if (this.refuseBulkGestureWhileLoading('Restoring every deleted page')) return;
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
    if (pageArray.length > 1
      && this.refuseBulkGestureWhileLoading('Deleting a run of pages')) return;
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
   * project's primary, so a book with no project has none — a loose file opened
   * from the library, a book. That is a real state and not a missing value: those books are
   * edited through the editor's own block list and never through annotations, so
   * the affordances that need a document say so rather than guessing.
   */
  readonly workingDocumentRef = computed<DocumentRef | null>(() => {
    const projectDir = this.projectPath();
    if (!projectDir) return null;
    // The PDF, never whatever artifact is on screen. Opening this project's book
    // puts an EPUB in the viewer, and main refuses an EPUB here BY NAME (a
    // working copy is cast from the book's PDF original) — so a ref built from
    // the displayed file would tear the block layer down every time the user
    // looked at the book.
    const sourcePath = this.curatedPdfPath();
    return sourcePath ? { projectDir, sourcePath } : { projectDir };
  });

  /**
   * The project PDF this window curates.
   *
   * Tracked rather than read off the viewer because the two are different
   * questions — "which file am I looking at" and "which file are the documents
   * cast from" — and they stopped having the same answer the moment the book
   * became something this window can show. Null is a real state: a project that
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
   * The artifact in the viewer IS the document the block layer belongs to.
   *
   * The working document is a copy of the project's PDF original with an
   * invisible text layer and the block annotations added, and the picker renders
   * that original and paints the annotations over it — so "is the working
   * document on screen" is exactly "is the project's PDF on screen".
   *
   * Measured from the path, deliberately, and synchronously: no round trip to
   * main can leave a window painting one book's blocks over another's while it
   * waits.
   *
   * WHAT IT IS FOR (second real session, 2026-08-04). The block layer stays OPEN
   * while the book is on screen, on purpose: `workingDocumentRef` tracks the
   * PROJECT's PDF rather than the file in the viewer, because building it from
   * the displayed file tore the layer down every time the user looked at the
   * book (commit acd6eaa2). But an open layer was also a MIRRORED one, so
   * showing the book painted the working PDF's blocks, deletions and categories
   * over the EPUB's own analysis — Owen: "it shouldnt be overlaying
   * changes/blocks from the pdf on top of the epub. this is a separate entity
   * now". The layer stays open; the mirroring, and every write that rides it,
   * stops at the artifact boundary.
   */
  private readonly viewerShowsWorkingDocument = computed(() => {
    const pdf = this.curatedPdfPath();
    // Null is a real state, not a missing value: a project that arrived as an
    // EPUB has no PDF to cast a working document from, and main refuses one by
    // name. Such a book has no block layer for anything to show.
    if (pdf === null) return false;
    // Exact, and NOT `samePath`, deliberately: that helper is separator- and
    // case-insensitive and says so of itself — "every caller here uses the
    // answer to pick a view rather than to authorize a write". This gate
    // authorizes writes into somebody's document. Both sides are the same
    // string by construction (`curatedPdfPath` is set FROM `effectivePath`), so
    // exactness costs nothing and a loosened comparison would be the one that
    // let a near-match through.
    return this.effectivePath() === pdf;
  });

  /**
   * A block layer has been read AND the artifact on screen is the one it
   * describes. The single condition every paint and every document write asks.
   */
  private readonly documentLayerLive = computed(() =>
    this.blockLayerRead() && this.viewerShowsWorkingDocument());

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
    // Suspended, not torn down, for any artifact that is not the working PDF —
    // see `viewerShowsWorkingDocument`. Reading the gate first and returning
    // means nothing is painted while the book is on screen, and the effect
    // re-runs (and repaints the document's blocks) the moment the PDF is back.
    if (!this.documentLayerLive()) return;
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
    // The BOOK's record, first and outside the working-document gate. The two
    // artifacts are exclusive — the working PDF's annotations and the book's
    // strike record are never both live — and each helper answers for its own,
    // so neither gate can swallow the other's write.
    this.landNarrationBlockStrikes(blockIds, deleted);
    // The artifact boundary, on the WRITE side: nothing done to the book may
    // reach the working document. `curationLocked` refuses those gestures at the
    // front door too, and this is the same statement said where the write is.
    if (!this.documentLayerLive()) return;
    for (const id of blockIds) {
      if (this.editorState.getBlock(id)?.is_image) continue;
      this.documentBlocks.setDeleted(id, deleted);
    }
  }

  /** A page struck out of the book, landed in the record and in the document. */
  private landPageDeletions(pages: readonly number[], deleted: boolean): void {
    this.landNarrationPageStrikes(pages, deleted);
    if (!this.documentLayerLive()) return;
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
    if (!this.documentLayerLive()) return;

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
    // Same artifact boundary as the block mirror, and for the same reason: the
    // book on screen has its own chapters (read out of its navigation), and the
    // working PDF's chapter blocks overwriting them is the overlay wearing a
    // different hat.
    if (!this.documentLayerLive()) return;
    const derived: Chapter[] = this.documentBlocks.chapterBlocks()
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
    return isChapterOpening(block);
  }

  /**
   * Read the working document and put its blocks on the pages.
   *
   * Three outcomes, and they are three different facts:
   *
   *  - **No ref.** The document is not a project's (a loose file), so there are
   *    no documents and nothing failed. The editor's own block list stands.
   *  - **A ref, and no block layer to read yet.** Every project is in this state
   *    until a working copy has been minted and curated. It is still reachable —
   *    that is what `workingDocumentOpen` says — and main's own sentence goes to
   *    the console, because opening a book is not the moment to interrupt
   *    somebody about a file they have not asked for.
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
      console.info('[document] no block layer for this book yet:', err);
      return;
    }
    this.workingDocumentOpen.set(true);
    this.blockLayerRead.set(true);
    this.selectedBlockIds.set([]);
    this.saveCurrentDocumentState();
  }

  // ── Reset, the one thing the working document's append-only shape powers ──

  /**
   * Put the working copy back to how it stood at a recorded boundary — or, with
   * `none`, to the copy as it was minted.
   *
   * One truncate of an append-only file: no GPU, no re-run, and the result is
   * not an approximation of that document but that document. Confirmed first,
   * because everything appended after the boundary — every hand correction — is
   * what is being cut off.
   */
  async resetToStage(target: ResetTarget): Promise<void> {
    const label = DOCUMENT_STAGE_LABELS[target];
    const choice = await this.electronService.showConfirmDialog({
      title: `Reset to ${label}?`,
      message: `The working copy goes back to exactly how it stood ${target === 'none'
        ? 'when it was made'
        : `when ${label} finished`}.`,
      detail: 'Everything done to it since then — labels, deletions, merges, chapter titles — is '
        + 'discarded. The archive original is untouched either way.',
      confirmLabel: `Reset to ${label}`,
      cancelLabel: 'Leave it alone',
      type: 'warning',
    });
    if (!choice.confirmed) return;
    await this.documentBlocks.resetTo(target);
    // A reset to the minted copy leaves a document with no block layer at all —
    // only pages waiting to be analysed again.
    if (target === 'none') this.blockLayerRead.set(false);
  }

  // ── Curation, written into the document ───────────────────────────────────

  /**
   * Retitle the chapter a block opens — in whichever file that title lives in.
   *
   * The artifact boundary decides, exactly as it does for every other write:
   *
   *  - **The working PDF.** The block's annotation text IS the title, so this is
   *    one edit to one field and there is no chapter record beside the block to
   *    keep in step.
   *  - **The book.** The block's text is mupdf's rendering of the printed page
   *    and cannot be edited — the print is the print. The title is the book's
   *    own table-of-contents entry, so the edit goes into the book
   *    (electron/book-chapters.ts, which writes it into every list the book
   *    carries) and the list re-reads it from there.
   */
  /**
   * The Chapter tab's × — this heading is not a chapter opening.
   *
   * A RELABEL, not a removal, and it goes down `onSetBlockCategory`: the same
   * call the Label tab's palette makes, so it is the same write to the same one
   * category field for each artifact (the annotation for a working PDF, a
   * correction in `manifest.editor` for a book), refused by the same
   * `curationLocked`, and joined to the same undo. The row then leaves the list
   * because the list is derived from that field — there is nothing here to
   * remove it from.
   *
   * `body` rather than nothing at all: the user is saying what this block is
   * NOT, and a printed heading is still words on the page that the audiobook
   * has to read. Deleting it is a separate gesture, already on the page.
   */
  demoteChapterBlock(event: { blockId: string }): void {
    this.onSetBlockCategory({ blockIds: [event.blockId], categoryId: BODY_CATEGORY });
  }

  retitleChapterBlock(event: { blockId: string; title: string }): void {
    if (this.documentLayerLive()) {
      this.documentBlocks.retitle(event.blockId, event.title);
      return;
    }
    void this.retitleBookChapter(event.blockId, event.title);
  }

  /**
   * Rename, in the book itself, the chapter this block opens.
   *
   * The block is addressed by its SOURCE ELEMENT (`bf_element`,
   * `<zip entry>#<index>`), whose first half is the chapter document — the same
   * identity a narration strike carries. That is exact where a page number would
   * be a guess: two chapters can open on one PDF page, and a book's laid-out
   * pages are mupdf's, not the paper's.
   *
   * Nothing is stored on this side. The book is the only place the title lives,
   * so the round trip that follows re-reads it from the book — which is also
   * what makes a rename survive closing the window: there is no second record to
   * have failed to save.
   */
  private async retitleBookChapter(blockId: string, title: string): Promise<void> {
    const dir = this.projectPath();
    if (!dir) {
      this.showAlert({
        title: 'This book is not in a project',
        message: 'A chapter title is written into the project\'s book EPUB, and this document does '
          + 'not belong to a project. Import it from Studio first.',
        type: 'warning',
      });
      return;
    }

    const block = this.blocks().find(b => b.id === blockId);
    if (!block) {
      this.showAlert({
        title: 'That chapter is no longer on screen',
        message: `Block ${blockId} is not in this document any more, so there is no chapter to `
          + 'rename. Re-open the book and try again.',
        type: 'warning',
      });
      return;
    }

    const element = block.bf_element;
    if (element === undefined) {
      this.showAlert({
        title: 'This heading could not be traced back to the book',
        message: 'The chapter title lives in the book\'s table of contents, and this block was not '
          + 'matched to the markup it was laid out from — so there is no chapter document to '
          + 'rename. The warnings shown when this book opened name every block in that state.',
        type: 'warning',
      });
      return;
    }

    const answer = await this.electronService.renameBookChapter(
      dir, parseNarrationElementKey(element).file, title);
    if (!answer.success || !answer.result) {
      // Main's own sentence, verbatim: it names the file, the project or the
      // table of contents that was missing, and this is the only place it is
      // said.
      this.showAlert({
        title: 'That chapter was not renamed',
        message: answer.error === undefined
          ? 'The rename came back without a result and without a reason, which is a fault in '
            + 'BookForge rather than anything about this book. Nothing was written.'
          : answer.error,
        type: 'error',
      });
      return;
    }

    // Re-read the book: the nav is the store, so this is both "show the new
    // title" and "prove it landed". It also re-reads the narration state, whose
    // record main re-stamped onto the book's new bytes.
    await this.refreshBookEpub();

    // ── The opening followed the name, so the PAGE has to be laid out again ──
    //
    // Owen, 2026-08-09: "if the user changes the text of the chapter name, it
    // updates the chapter opener to reflect that accurately." Main did that in
    // the book (`nameChapterOpenings`), which means the markup this window laid
    // out no longer exists — the heading on screen is the old one. Only a real
    // re-open ends with the window and the file agreeing, so it is a real
    // re-open, and then the window goes back to the page the user was on,
    // because being thrown to page 1 for renaming a chapter is its own kind of
    // wrong. A long name simply wraps and pushes the chapter down; the viewer
    // lays out the real text and needs nothing from here to do it.
    if (answer.openingsNamed !== undefined && answer.openingsNamed > 0) {
      const docId = this.activeDocumentId();
      const doc = docId === null ? undefined : this.openDocuments().find(d => d.id === docId);
      if (doc !== undefined) {
        const target = doc.projectPath ?? doc.libraryPath;
        const page = block.page;
        queueMicrotask(async () => {
          this.closeDocument(docId!);
          await this.openTarget(target, 'restoring');
          this.scrollBackAfterReopen(page);
        });
      }
    }

    if (answer.result.narrationCopy === 'already-stale') {
      // The one case the rename could not keep in step, said out loud. A stale
      // narration copy is the file the audiobook would actually be built from,
      // so silence here would mean a chapter announced under its old name with
      // nothing on screen explaining why.
      this.showAlert({
        title: 'The narration copy still says the old title',
        message: 'This project has an exported narration copy that was cut from a different '
          + 'version of the book, so the rename was not applied to it. Export the narration copy '
          + 'again before making the audiobook, or it will announce the old chapter title.',
        type: 'warning',
      });
    }
  }

  /**
   * Put the window back on `page` once a re-opened book is laid out.
   *
   * A re-open is a full close-and-open — the only refresh that ends with the
   * window and the file agreeing — and it starts at page 1. The viewer cannot
   * be asked for the old page the instant `openTarget` resolves: its bands are
   * rendered by the change detection that resolution schedules, and
   * `scrollToPage` finds no band element until they are in the DOM (it does
   * nothing, silently, by design). There is no "laid out" event to wait on, so
   * the ask is made on animation frames until the book reports the page exists,
   * and then one frame later so the band is rendered. The budget is what keeps
   * this from being a spinner: a second at 60fps, after which the book is
   * simply open at the top — the same place it would have been anyway.
   */
  private scrollBackAfterReopen(page: number, framesLeft = 60): void {
    if (page <= 0) return;
    requestAnimationFrame(() => {
      if (this.epubViewerReady() === null || page >= this.totalPages()) {
        if (framesLeft > 0) this.scrollBackAfterReopen(page, framesLeft - 1);
        return;
      }
      requestAnimationFrame(() => this.scrollToPage(page));
    });
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
  /**
   * Why merging is off, or null when it can run.
   *
   * Merging rewrites the WORKING DOCUMENT's block layer — a PDF annotation
   * layer — and there is no such thing behind an EPUB. That was already true
   * before the quire cutover and `mergeSelectedBlocks` already declined to do
   * it; what it did not do was SAY so, and a control that accepts a click and
   * changes nothing is indistinguishable from a broken one. So the reason is a
   * value now: the merge controls read it to disable themselves, and the
   * gesture itself says it out loud if it is reached anyway.
   */
  readonly mergeSelectionRefusal = computed<string | null>(() => {
    if (this.curationLocked()) {
      return 'The document on screen is a finished artifact, not the working copy, so its blocks '
        + 'are not edited here.';
    }
    if (this.isCurrentDocumentEpub()) {
      // On a book there is nothing here to do, and that is the FEATURE. A
      // chapter opening is rewritten to the chapter's stored name the moment
      // the project opens, book-wide and unasked (electron/narration-export.ts,
      // `nameChapterOpenings`) — Owen, 2026-08-09: "from the moment the book
      // opens, the chapter openers contain the chapter's text. period. the user
      // will delete surrounding blocks if they're unnecessary." So the fold
      // gesture that used to do it one chapter at a time has no work left, and
      // what IS left — whether the subhead under the opening should be narrated
      // — is a deletion, which the page already offers. Joining two body
      // elements into one was never an edit this app makes to a book: the
      // book's own markup says what its elements are.
      return 'A chapter opening is named automatically when the book opens. Delete the blocks '
        + 'around it that should not be narrated.';
    }
    if (!this.documentLayerLive()) {
      return 'This document has no working block layer open, so there is nothing to merge in. '
        + 'Reload the book and try again.';
    }
    return null;
  });

  mergeSelectedBlocks(): void {
    const refusal = this.mergeSelectionRefusal();
    if (refusal !== null) {
      this.showAlert({ title: 'Blocks cannot be merged here', message: refusal, type: 'warning' });
      return;
    }

    // No EPUB branch: `mergeSelectionRefusal` returns a sentence for every
    // book, so this line is only ever reached with a working PDF's block layer
    // on screen.
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

  /**
   * Close one of the open documents, by id.
   *
   * The tab STRIP is gone with the station bar — the picker is one screen — but
   * a window still holds several documents (a project's PDF, its book), and
   * Cmd+W still closes the one on screen.
   */
  closeDocument(docId: string): void {
    const docs = this.openDocuments();
    const doc = docs.find(d => d.id === docId);
    if (!doc) return;

    // Auto-save if there are unsaved changes — but only when closing the
    // ACTIVE document. saveProject() serializes the active document's editor
    // state, so saving for a background one would write the wrong data.
    if (doc.hasUnsavedChanges) {
      if (docId !== this.activeDocumentId()) {
        // Not on screen, and it CANNOT be saved (see above); closing would
        // silently drop the changes. Make the user decide.
        this.showAlert({
          title: 'Unsaved Changes',
          message: `"${doc.name}" has unsaved changes that cannot be saved while it is in the background. Switch to it to save, or discard the changes and close it.`,
          type: 'warning',
          confirmText: 'Discard Changes',
          cancelText: 'Cancel',
          onConfirm: () => this.removeClosedDocument(docId)
        });
        return;
      }
      if (this.projectService.projectPath()) {
        // Save in background before closing
        this.saveProject().catch(err => console.error('Auto-save on close failed:', err));
      }
    }

    this.removeClosedDocument(docId);
  }

  /** Actually drop a document (after any unsaved-changes handling). */
  private removeClosedDocument(docId: string): void {
    const docs = this.openDocuments();
    const docIndex = docs.findIndex(d => d.id === docId);
    if (docIndex === -1) return;

    // Clean up background text extraction subscription
    this.textReadyUnsubs.get(docId)?.();
    this.textReadyUnsubs.delete(docId);

    // Remove from list
    const newDocs = docs.filter(d => d.id !== docId);
    this.openDocuments.set(newDocs);

    // If closing the document on screen, switch to another or show the empty
    // workspace.
    if (docId === this.activeDocumentId()) {
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

    // Otherwise close the document on screen.
    this.closeDocument(activeId);
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
            categoryProvenance: this.editorState.categoryProvenance(),
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
      categoryProvenance: doc.categoryProvenance,
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
          await this.loadProjectFromPath(path, 'restoring');
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

import { Component, inject, signal, computed, HostListener, ViewChild, effect, DestroyRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction, BlockEdit } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
import { ExportService } from './services/export.service';
import { PageRenderService } from './services/page-render.service';
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
import { LibraryViewComponent } from './components/library-view/library-view.component';
import { TabBarComponent, DocumentTab } from './components/tab-bar/tab-bar.component';
import { OcrSettingsModalComponent, OcrSettings, OcrPageResult } from './components/ocr-settings-modal/ocr-settings-modal.component';
import { InlineTextEditorComponent, TextEditResult } from './components/inline-text-editor/inline-text-editor.component';
import { SettingsModalComponent } from './components/settings-modal/settings-modal.component';
import { ExportSettingsModalComponent, ExportSettings, ExportResult, ExportFormat } from './components/export-settings-modal/export-settings-modal.component';

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
  selectedBlockIds: string[];
  pageOrder: number[]; // Custom page order for organize mode
  pageImages: Map<number, string>;
  hasUnsavedChanges: boolean;
  projectPath: string | null;
  undoStack: HistoryAction[];
  redoStack: HistoryAction[];
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
type EditorMode = 'select' | 'edit' | 'crop' | 'organize' | 'split' | 'ocr';

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
    LibraryViewComponent,
    TabBarComponent,
    OcrSettingsModalComponent,
    InlineTextEditorComponent,
    SettingsModalComponent,
    ExportSettingsModalComponent,
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
      (dropdownItemClicked)="onDropdownItemClicked($event)"
    >
    </desktop-toolbar>

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
                title="Re-render all pages"
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
              (blockClick)="onBlockClick($event)"
              (blockDoubleClick)="onBlockDoubleClick($event)"
              (blockHover)="onBlockHover($event)"
              (selectLikeThis)="selectLikeThis($event)"
              (deleteLikeThis)="deleteLikeThis($event)"
              (deleteBlock)="deleteBlock($event)"
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
      <app-library-view
        (openFile)="showFilePicker.set(true)"
        (fileSelected)="loadPdf($event)"
        (projectSelected)="loadProjectFromPath($event)"
        (projectsSelected)="onLibraryProjectsSelected($event)"
        (clearCache)="onClearCache($event)"
      />
    }

    <!-- File Picker Modal -->
    @if (showFilePicker()) {
      <app-file-picker
        (fileSelected)="loadPdf($event)"
        (close)="showFilePicker.set(false)"
      />
    }

    <!-- Loading Overlay -->
    @if (loading()) {
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <p>{{ loadingText() }}</p>
        @if (renderProgress().total > 0) {
          <div class="progress-container">
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="renderProgressPercent()"></div>
            </div>
            <span class="progress-text">{{ renderProgress().current }} / {{ renderProgress().total }} pages</span>
          </div>
        }
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
        (close)="showOcrSettings.set(false)"
        (ocrCompleted)="onOcrCompleted($event)"
      />
    }

    <!-- Settings Modal -->
    @if (showSettings()) {
      <app-settings-modal
        (close)="showSettings.set(false)"
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

  `],
})
export class PdfPickerComponent {
  private readonly pdfService = inject(PdfService);
  private readonly electronService = inject(ElectronService);
  private readonly exportService = inject(ExportService);
  private readonly pageRenderService = inject(PageRenderService);
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

  @ViewChild(PdfViewerComponent) pdfViewer!: PdfViewerComponent;

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
      // Don't process other shortcuts when inline editor is open
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
      // Don't process other shortcuts when text editor is open
      return;
    }

    // Delete/Backspace to delete selected blocks or custom category highlights
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // First, try to delete selected blocks
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

    // Ctrl/Cmd + O to switch to library tab
    if ((event.metaKey || event.ctrlKey) && event.key === 'o') {
      event.preventDefault();
      this.switchToLibraryTab();
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
        case 'r': // R for rearrange/organize
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('organize');
          }
          break;
        case 'p': // P for page split
          if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
            event.preventDefault();
            this.setMode('split');
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
  readonly showSettings = signal(false);
  readonly showExportSettings = signal(false);
  readonly loading = signal(false);
  readonly loadingText = signal('Loading...');

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
  // Calculate font size based on screen/PDF scale ratio
  readonly inlineEditorFontSize = computed(() => {
    const block = this.inlineEditorBlock();
    if (!block) return 14;
    // Scale factor from PDF to screen coordinates
    const screenHeight = this.inlineEditorHeight();
    const pdfHeight = block.height;
    if (pdfHeight <= 0) return 14;
    const scale = screenHeight / pdfHeight;
    return Math.max(10, Math.min(24, block.font_size * scale));
  });

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
    { id: 'edit', icon: '✏️', label: 'Edit', tooltip: 'Double-click to edit text (E)' },
    { id: 'crop', icon: '✂️', label: 'Crop', tooltip: 'Draw rectangle to crop (C)' },
    { id: 'organize', icon: '📑', label: 'Organize', tooltip: 'Reorder pages (R)' },
    { id: 'split', icon: '📖', label: 'Split', tooltip: 'Split scanned pages (P)' },
    { id: 'ocr', icon: '👁️', label: 'OCR', tooltip: 'OCR scanned pages (O)' }
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

  // Page image cache - maps page number to data URL
  // Delegate to PageRenderService
  get pageImages() { return this.pageRenderService.pageImages; }

  // Multi-document support
  readonly openDocuments = signal<OpenDocument[]>([]);
  readonly activeDocumentId = signal<string | null>(null);

  // Special library tab ID
  private readonly LIBRARY_TAB_ID = '__library__';

  // Computed: active tab ID for tab bar (returns LIBRARY_TAB_ID when no document active)
  readonly activeTabId = computed(() => this.activeDocumentId() || this.LIBRARY_TAB_ID);

  // Computed: tabs for tab bar (Library tab + open documents)
  readonly documentTabs = computed<DocumentTab[]>(() => {
    const libraryTab: DocumentTab = {
      id: this.LIBRARY_TAB_ID,
      name: 'Library',
      path: '',
      hasUnsavedChanges: false,
      icon: '📚',
      closable: false
    };

    const docTabs = this.openDocuments().map(doc => ({
      id: doc.id,
      name: doc.name,
      path: doc.path,
      hasUnsavedChanges: doc.hasUnsavedChanges,
      closable: true
    }));

    return [libraryTab, ...docTabs];
  });

  // Toolbar items (computed based on state)
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const pdfIsOpen = this.pdfLoaded();

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
          type: 'dropdown',
          icon: '📤',
          label: 'Export',
          tooltip: 'Export cleaned text',
          items: [
            { id: 'export-txt', label: 'Export as TXT' },
            { id: 'export-epub', label: 'Export as EPUB' },
            { id: 'export-pdf', label: 'Export as PDF (keep images)' }
          ]
        },
        { id: 'divider1', type: 'divider' },
        { id: 'undo', type: 'button', icon: '↩', tooltip: 'Undo (Ctrl+Z)', disabled: !this.canUndo() },
        { id: 'redo', type: 'button', icon: '↪', tooltip: 'Redo (Ctrl+Shift+Z)', disabled: !this.canRedo() },
        { id: 'spacer', type: 'spacer' },
        { id: 'divider2', type: 'divider' },
        {
          id: 'layout',
          type: 'toggle',
          icon: this.layout() === 'grid' ? '☰' : '⊞',
          label: this.layout() === 'grid' ? 'List' : 'Grid',
          tooltip: 'Toggle layout',
          active: this.layout() === 'grid'
        },
        { id: 'zoom-out', type: 'button', icon: '−', tooltip: 'Zoom out' },
        { id: 'zoom-level', type: 'button', label: `${this.zoom()}%`, disabled: true },
        { id: 'zoom-in', type: 'button', icon: '+', tooltip: 'Zoom in' },
        { id: 'zoom-reset', type: 'button', label: 'Reset', tooltip: 'Reset zoom' },
        { id: 'divider3', type: 'divider' },
        {
          id: 'ui-size',
          type: 'dropdown',
          icon: '⚙',
          label: this.getUiSizeLabel(),
          tooltip: 'UI Size',
          items: [
            { id: 'ui-small', label: 'Small' },
            { id: 'ui-medium', label: 'Medium' },
            { id: 'ui-large', label: 'Large' }
          ]
        },
        { id: 'settings', type: 'button', icon: '⚙️', tooltip: 'Settings' }
      ];
    }

    // When no PDF is open, show minimal toolbar
    return [
      ...baseItems,
      { id: 'spacer', type: 'spacer' },
      {
        id: 'ui-size',
        type: 'dropdown',
        icon: '⚙',
        label: this.getUiSizeLabel(),
        tooltip: 'UI Size',
        items: [
          { id: 'ui-small', label: 'Small' },
          { id: 'ui-medium', label: 'Medium' },
          { id: 'ui-large', label: 'Large' }
        ]
      },
      { id: 'settings', type: 'button', icon: '⚙️', tooltip: 'Settings' }
    ];
  });

  private getUiSizeLabel(): string {
    const size = this.themeService.uiSize();
    return size.charAt(0).toUpperCase() + size.slice(1);
  }

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
        this.exportText();
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
      case 'settings':
        this.showSettings.set(true);
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
    } else if (event.parent.id === 'export') {
      switch (event.item.id) {
        case 'export-txt':
          this.exportText();
          break;
        case 'export-epub':
          this.exportEpub();
          break;
        case 'export-pdf':
          this.exportPdf();
          break;
      }
    }
  }

  /**
   * Toggle remove backgrounds mode
   * When enabled, renders pages as white with text overlays
   */
  async toggleRemoveBackgrounds(): Promise<void> {
    // Toggle via editor state service (adds to undo/redo history)
    const newValue = this.editorState.toggleRemoveBackgrounds();

    await this.applyRemoveBackgrounds(newValue);
  }

  /**
   * Apply the remove backgrounds state (render or restore pages)
   */
  private async applyRemoveBackgrounds(enabled: boolean): Promise<void> {
    if (enabled) {
      // Re-render all pages with background removal
      this.loading.set(true);
      const total = this.totalPages();

      try {
        for (let i = 0; i < total; i++) {
          this.loadingText.set(`Removing backgrounds... (${i + 1}/${total})`);
          await this.pageRenderService.renderBlankPage(i);
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

  switchToLibraryTab(): void {
    // Save current document state and switch to library tab
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

  async loadPdf(path: string): Promise<void> {
    console.log('[loadPdf] Starting for path:', path);
    this.showFilePicker.set(false);

    // Check if this PDF is already open (by original path or library path)
    const existingDoc = this.openDocuments().find(d => d.path === path || d.libraryPath === path);
    console.log('[loadPdf] existingDoc check:', existingDoc ? `found ${existingDoc.id}, blocks: ${existingDoc.blocks.length}` : 'not found');
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
      console.log('[loadPdf] Importing file to library:', path);
      const importResult = await this.electronService.libraryImportFile(path);
      console.log('[loadPdf] Import result:', importResult);
      if (!importResult.success || !importResult.libraryPath) {
        throw new Error(importResult.error || 'Failed to import file to library');
      }

      const libraryPath = importResult.libraryPath;
      const fileHash = importResult.hash || '';
      console.log('[loadPdf] libraryPath:', libraryPath, 'fileHash:', fileHash);

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
        selectedBlockIds: [],
        pageOrder: [],
        pageImages: new Map(),
        hasUnsavedChanges: false,
        projectPath: null,
        undoStack: [],
        redoStack: []
      };

      // Add to open documents
      this.openDocuments.update(docs => [...docs, newDoc]);
      this.activeDocumentId.set(docId);

      // Set current state via service
      console.log('Loading document with blocks:', result.blocks.length, 'blocks, categories:', Object.keys(result.categories).length);
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
      console.log('After loadDocument, editorState.blocks:', this.editorState.blocks().length);
      this.pageRenderService.clear();
      this.projectService.reset();
      this.blankedPages.set(new Set());  // Clear blanked pages for new document

      this.saveRecentFile(path, result.pdf_name);

      // Load page images - use effectivePath() to get the actual file location
      this.loadingText.set('Rendering pages...');
      this.pageRenderService.initialize(this.effectivePath(), result.page_count);
      await this.pageRenderService.loadAllPageImages(result.page_count);

      this.pdfLoaded.set(true);

      // Reset zoom tracking for new document and auto-zoom for grid
      this.userAdjustedZoom = false;
      this.autoZoomForGrid();

      // Reset grid pagination for efficient initial render
      this.pdfViewer?.resetGridPagination();

      // Auto-create project file for this document
      await this.autoCreateProject(path, result.pdf_name);
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
    const isMultiSelect = shiftKey || metaKey || ctrlKey;

    if (isMultiSelect) {
      // Multi-select: toggle this block in selection
      const selected = [...this.selectedBlockIds()];
      const idx = selected.indexOf(block.id);
      if (idx >= 0) {
        selected.splice(idx, 1);
      } else {
        selected.push(block.id);
      }
      this.selectedBlockIds.set(selected);
    } else {
      // Single click: select just this block
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
    // Add some padding and minimum dimensions
    const minWidth = 200;
    const minHeight = 60;

    this.inlineEditorBlock.set(block);
    this.inlineEditorX.set(x);
    this.inlineEditorY.set(y);
    this.inlineEditorWidth.set(Math.max(width, minWidth));
    this.inlineEditorHeight.set(Math.max(height, minHeight));
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
            // Text was changed - save as a correction
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

          this.editorState.setBlockSize(block.id, newPdfWidth, newPdfHeight);
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

  // Handle block position changes from drag/drop in edit mode (called during drag)
  onBlockMoved(event: { blockId: string; offsetX: number; offsetY: number }): void {
    const { blockId, offsetX, offsetY } = event;
    // Update position for visual feedback during drag (no re-render yet)
    if (Math.abs(offsetX) > 0.5 || Math.abs(offsetY) > 0.5) {
      this.editorState.setBlockPosition(blockId, offsetX, offsetY);
    } else {
      this.editorState.clearBlockPosition(blockId);
    }
  }

  // Handle block drag completion - re-render page with redactions
  onBlockDragEnd(event: { blockId: string; pageNum: number }): void {
    // Re-render the page with redactions now that drag is complete
    this.rerenderPageWithEdits(event.pageNum);
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

      // Block has an edit - add original position as redact region
      const hasTextEdit = edit.text !== undefined;
      const hasPositionEdit = edit.offsetX !== undefined || edit.offsetY !== undefined;
      const hasSizeEdit = edit.width !== undefined || edit.height !== undefined;

      if (hasTextEdit || hasPositionEdit || hasSizeEdit) {
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
    // If all images on this page are deleted, render a blank page
    // This matches the "Remove Backgrounds" behavior
    const allImagesDeleted = this.areAllImagesDeletedOnPage(pageNum);

    if (allImagesDeleted) {
      this.pageRenderService.renderBlankPage(pageNum);
      // Add to blankedPages so pdf-viewer shows text overlays
      this.blankedPages.update(pages => {
        const newPages = new Set(pages);
        newPages.add(pageNum);
        return newPages;
      });
      return;
    }

    // Page is not fully blanked - remove from blankedPages if it was there
    this.blankedPages.update(pages => {
      if (pages.has(pageNum)) {
        const newPages = new Set(pages);
        newPages.delete(pageNum);
        return newPages;
      }
      return pages;
    });

    const regions = this.getRedactRegionsForPage(pageNum);
    if (regions.length > 0) {
      this.pageRenderService.rerenderPageWithRedactions(pageNum, regions);
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
    this.pageOrder.set(newOrder);
    this.hasUnsavedChanges.set(true);
  }

  deleteSelectedBlocks(): void {
    const selected = this.selectedBlockIds();
    if (selected.length === 0) return;

    const deleted = this.deletedBlockIds();

    // Check if ALL selected blocks are already deleted
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
      // Re-render affected pages when deletion state changes
      const affectedPages = new Set<number>();
      for (const blockId of action.blockIds) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    }
  }

  async redo(): Promise<void> {
    const action = this.editorState.redo();
    if (!action) return;

    // Handle visual changes based on action type
    if (action.type === 'toggleBackgrounds') {
      await this.applyRemoveBackgrounds(action.backgroundsAfter ?? false);
    } else if (action.type === 'delete' || action.type === 'restore') {
      // Re-render affected pages when deletion state changes
      const affectedPages = new Set<number>();
      for (const blockId of action.blockIds) {
        const block = this.editorState.getBlock(blockId);
        if (block) affectedPages.add(block.page);
      }
      for (const pageNum of affectedPages) {
        this.rerenderPageWithEdits(pageNum);
      }
    }
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

    // Regular categories: add/remove blocks from selection
    const deleted = this.deletedBlockIds();
    const allBlocks = this.blocks();
    const categoryBlocks = allBlocks.filter(b => b.category_id === categoryId);
    const nonDeletedBlocks = categoryBlocks.filter(b => !deleted.has(b.id));
    const ocrBlocks = nonDeletedBlocks.filter(b => b.is_ocr);

    console.log(`[selectCategory] categoryId: ${categoryId}`);
    console.log(`[selectCategory] total: ${allBlocks.length}, inCategory: ${categoryBlocks.length}, notDeleted: ${nonDeletedBlocks.length}, isOCR: ${ocrBlocks.length}`);
    if (ocrBlocks.length > 0) {
      console.log(`[selectCategory] First OCR block:`, ocrBlocks[0]);
    }

    const blockIds = nonDeletedBlocks.map(b => b.id);
    console.log(`[selectCategory] Selecting ${blockIds.length} block IDs`);

    const existing = new Set(this.selectedBlockIds());
    const allSelected = blockIds.length > 0 && blockIds.every(id => existing.has(id));

    if (additive) {
      // Cmd/Ctrl+click: remove this category's blocks from selection
      blockIds.forEach(id => existing.delete(id));
      this.selectedBlockIds.set([...existing]);
    } else if (allSelected) {
      // Regular click on already-selected category: deselect all of this category
      blockIds.forEach(id => existing.delete(id));
      this.selectedBlockIds.set([...existing]);
    } else {
      // Regular click: add this category's blocks to selection
      blockIds.forEach(id => existing.add(id));
      this.selectedBlockIds.set([...existing]);
      console.log(`[selectCategory] After set, selectedBlockIds count: ${this.selectedBlockIds().length}`);
      // Check if first OCR block is in selection
      if (ocrBlocks.length > 0) {
        const firstOcrId = ocrBlocks[0].id;
        console.log(`[selectCategory] First OCR id: ${firstOcrId}, in selection: ${this.selectedBlockIds().includes(firstOcrId)}`);
      }
    }
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
      this.textCorrections()
    );

    this.showAlert({
      title: result.success ? 'Export Complete' : 'Nothing to Export',
      message: result.message,
      type: result.success ? 'success' : 'warning'
    });
  }

  async exportEpub(): Promise<void> {
    const result = await this.exportService.exportEpub(
      this.blocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.textCorrections()
    );

    this.showAlert({
      title: result.success ? 'Export Complete' : 'Nothing to Export',
      message: result.message,
      type: result.success ? 'success' : 'warning'
    });
  }

  /**
   * Show export settings modal
   */
  exportPdf(): void {
    this.showExportSettings.set(true);
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
          await this.exportAsEpub();
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
      this.editorState.textCorrections()
    );

    if (result.success) {
      this.showAlert({
        title: 'Export Complete',
        message: result.message,
        type: 'success'
      });
    } else {
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
  private async exportAsEpub(): Promise<void> {
    this.loadingText.set('Generating EPUB...');

    const result = await this.exportService.exportEpub(
      this.blocks(),
      this.deletedBlockIds(),
      this.pdfName(),
      this.editorState.textCorrections()
    );

    if (result.success) {
      this.showAlert({
        title: 'Export Complete',
        message: result.message,
        type: 'success'
      });
    } else {
      this.showAlert({
        title: 'Export Failed',
        message: result.message,
        type: 'error'
      });
    }
  }

  /**
   * Export as PDF format (with optional background removal)
   */
  private async exportAsPdf(settings: ExportSettings): Promise<void> {
    if (settings.removeBackgrounds) {
      // Export with background removal
      this.loadingText.set('Preparing export...');

      // Collect deleted regions to apply as redactions before rendering
      const deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }> = [];

      // Add deleted blocks
      const deletedBlockIds = this.deletedBlockIds();
      for (const block of this.blocks()) {
        if (deletedBlockIds.has(block.id)) {
          deletedRegions.push({
            page: block.page,
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
            isImage: block.is_image
          });
        }
      }

      // Add deleted custom category highlights
      const deletedHighlightIds = this.deletedHighlightIds();
      if (deletedHighlightIds.size > 0) {
        for (const [categoryId, pageMap] of this.categoryHighlights()) {
          for (const [pageStr, rects] of Object.entries(pageMap)) {
            const page = parseInt(pageStr);
            for (const rect of rects) {
              const highlightId = this.getHighlightId(categoryId, page, rect.x, rect.y);
              if (deletedHighlightIds.has(highlightId)) {
                deletedRegions.push({
                  page,
                  x: rect.x,
                  y: rect.y,
                  width: rect.w,
                  height: rect.h
                });
              }
            }
          }
        }
      }

      // Collect OCR blocks to embed as real text (survives image deletion)
      // Only include OCR blocks on pages where images were deleted
      const pagesWithDeletedImages = new Set<number>();
      for (const region of deletedRegions) {
        if (region.isImage) {
          pagesWithDeletedImages.add(region.page);
        }
      }

      const ocrBlocks: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }> = [];
      if (pagesWithDeletedImages.size > 0) {
        for (const block of this.blocks()) {
          // Include OCR blocks that are not deleted and on pages with deleted images
          if (block.is_ocr && !deletedBlockIds.has(block.id) && pagesWithDeletedImages.has(block.page)) {
            ocrBlocks.push({
              page: block.page,
              x: block.x,
              y: block.y,
              width: block.width,
              height: block.height,
              text: block.text,
              font_size: block.font_size
            });
          }
        }
      }

      // Subscribe to export progress
      const unsubscribe = this.electronService.onExportProgress((progress) => {
        this.loadingText.set(`Processing page ${progress.current + 1} of ${progress.total}...`);
      });

      let pdfBase64: string;
      try {
        // Convert quality setting to scale factor
        const scale = this.getScaleFromQuality(settings.quality);
        // Pass deleted regions and OCR blocks to be embedded in the PDF
        pdfBase64 = await this.electronService.exportPdfNoBackgrounds(
          scale,
          deletedRegions.length > 0 ? deletedRegions : undefined,
          ocrBlocks.length > 0 ? ocrBlocks : undefined
        );
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

      this.showAlert({
        title: 'Export Complete',
        message: `PDF exported: ${a.download}`,
        type: 'success'
      });
    } else {
      // Standard export with redactions
      this.loadingText.set('Generating PDF...');

      const result = await this.exportService.exportPdf(
        this.blocks(),
        this.deletedBlockIds(),
        this.deletedHighlightIds(),
        this.categoryHighlights(),
        this.libraryPath(),
        this.pdfName(),
        this.getHighlightId.bind(this),
        this.textCorrections()
      );

      if (result.success) {
        this.showAlert({
          title: 'Export Complete',
          message: result.message,
          type: 'success'
        });
      } else {
        this.showAlert({
          title: 'Nothing Changed',
          message: result.message,
          type: 'info'
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
        // Use existing project
        console.log(`Found existing project: ${existing.path}`);
        this.projectPath.set(existing.path);
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
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString()
      };

      const projectName = this.pdfName().replace(/\.[^.]+$/, '');
      const result = await this.electronService.projectsSave(projectData, projectName);

      if (result.success && result.filePath) {
        this.projectPath.set(result.filePath);
        this.hasUnsavedChanges.set(false);
        console.log('Auto-created project:', result.filePath);
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
    const projectData: BookForgeProject = {
      version: 1,
      source_path: this.pdfPath(),
      source_name: this.pdfName(),
      library_path: this.libraryPath(),
      file_hash: this.fileHash(),
      deleted_block_ids: [...this.deletedBlockIds()],
      page_order: order.length > 0 ? order : undefined,
      custom_categories: customCategories.length > 0 ? customCategories : undefined,
      undo_stack: history.undoStack.length > 0 ? history.undoStack : undefined,
      redo_stack: history.redoStack.length > 0 ? history.redoStack : undefined,
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
    console.log(`Restoring ${customCategories.length} custom categories from project`);

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

      console.log(`  Restored category "${category.name}" with highlights on ${Object.keys(data.highlights).length} pages`);
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
        console.log('[loadProject] Imported old project to library:', libraryPath, 'hash:', fileHash);
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

      this.pageRenderService.clear();
      this.projectService.projectPath.set(result.filePath || null);

      // Load page images - use effectivePath() to get the actual file location
      this.loadingText.set('Rendering pages...');
      this.pageRenderService.initialize(this.effectivePath(), pdfResult.page_count);
      await this.pageRenderService.loadAllPageImages(pdfResult.page_count);
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

  async loadProjectFromPath(filePath: string): Promise<void> {
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
        console.log('[loadProjectFromPath] Imported old project to library:', libraryPath, 'hash:', fileHash);
      } else {
        // Fall back to source path if import fails
        libraryPath = project.source_path;
        console.warn('[loadProjectFromPath] Library import failed, using source path:', project.source_path);
      }
    }

    const pdfPathToLoad = libraryPath;

    try {
      console.log('[loadProjectFromPath] Analyzing PDF:', pdfPathToLoad);
      const pdfResult = await this.pdfService.analyzePdf(pdfPathToLoad);
      console.log('[loadProjectFromPath] Analysis result blocks:', pdfResult.blocks.length, 'categories:', Object.keys(pdfResult.categories).length);

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
        selectedBlockIds: [],
        pageOrder: pageOrder,
        pageImages: new Map(),
        hasUnsavedChanges: false,
        projectPath: actualProjectPath,
        undoStack: project.undo_stack || [],
        redoStack: project.redo_stack || []
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

      // Restore OCR blocks - these replace PDF-analyzed blocks on their pages
      if (project.ocr_blocks && project.ocr_blocks.length > 0) {
        // Get the pages that have OCR blocks
        const ocrPages = [...new Set(project.ocr_blocks.map(b => b.page))];
        // Replace PDF blocks with OCR blocks on those pages
        this.editorState.replaceTextBlocksOnPages(ocrPages, project.ocr_blocks);
        console.log(`[loadProject] Restored ${project.ocr_blocks.length} OCR blocks on ${ocrPages.length} page(s)`);
      }

      // Restore remove backgrounds state
      if (project.remove_backgrounds) {
        this.editorState.removeBackgrounds.set(true);
      }

      this.pageRenderService.clear();
      this.projectService.projectPath.set(actualProjectPath);

      // Load page images - use effectivePath() to get the actual file location
      this.loadingText.set('Rendering pages...');
      this.pageRenderService.initialize(this.effectivePath(), pdfResult.page_count);
      await this.pageRenderService.loadAllPageImages(pdfResult.page_count);

      // Apply background removal if it was enabled in the project
      if (project.remove_backgrounds) {
        await this.applyRemoveBackgrounds(true);
      }

      this.pdfLoaded.set(true);
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
    console.log(`Created category "${categoryName}" with ${total} matches across ${pageCount} pages`);
    console.log(`  Memory saved: ~${(total * 160 / 1024).toFixed(0)}KB by using lightweight storage`);

    this.hasUnsavedChanges.set(true);
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

      // Apply page filter (client-side)
      matches = this.applyPageFilter(matches, pageFilterType, pageRangeStart, pageRangeEnd, specificPages);

      // Apply category filter (client-side) - need to look up block categories
      // Empty filter = no categories selected = filter out everything
      matches = this.applyCategoryFilter(matches, categoryFilter);

      // Store first 5000 matches for preview (performance limit)
      this.regexMatches.set(matches.slice(0, 5000));
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
      console.log(`Updated category "${name}" (name/color only)`);
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

    // Use existing ID if editing, otherwise generate new
    const catId = editingId || ('custom_regex_' + Date.now().toString(36));

    // Create/update the category
    const newCategory: Category = {
      id: catId,
      name: name,
      description: `Regex: ${pattern} (${total} matches)`,
      color: color,
      block_count: total,
      char_count: matches.reduce((sum, m) => sum + m.text.length, 0),
      font_size: minSize || 10,
      region: 'body',
      sample_text: matches[0]?.text || '',
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
      newHighlights.set(catId, matchesByPage);
      return newHighlights;
    });

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);

    // Close modal and clear editing state
    this.regexPanelExpanded.set(false);
    this.editingCategoryId.set(null);

    console.log(`${editingId ? 'Updated' : 'Created'} regex category "${name}" with ${total} span matches`);
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

    console.log(`Deleted custom category: ${categoryId}`);
  }

  // Mark all highlights from a custom category as deleted (shows X, keeps in list)
  clearCustomCategoryHighlights(categoryId: string): void {
    const highlights = this.categoryHighlights().get(categoryId);
    if (!highlights) return;

    // Mark all highlights as deleted
    const newDeletedIds = new Set(this.deletedHighlightIds());
    let count = 0;

    for (const [pageStr, rects] of Object.entries(highlights)) {
      const page = parseInt(pageStr);
      for (const rect of rects) {
        const id = this.getHighlightId(categoryId, page, rect.x, rect.y);
        newDeletedIds.add(id);
        count++;
      }
    }

    this.deletedHighlightIds.set(newDeletedIds);

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);

    console.log(`Marked ${count} highlights as deleted from custom category: ${categoryId}`);
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

    console.log(`Editing custom category: ${categoryId} (${cat.name})`);
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
      this.showOcrSettings.set(true);
      // Don't change currentMode - OCR is a modal, not a persistent mode
      return;
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
        console.log(`Page ${pageNum + 1}: Detected ${result.angle.toFixed(2)}° skew (confidence: ${result.confidence})`);

        // TODO: Apply the rotation to the page
        // This would require either:
        // 1. Modifying the PDF itself (complex, requires PDF manipulation)
        // 2. Applying CSS transform to the displayed page (visual only)
        // 3. Storing rotation info to be applied during export
        // For now, we just detect and report the angle
      } else {
        this.lastDeskewAngle.set(result?.angle ?? 0);
        console.log(`Page ${pageNum + 1}: No significant skew detected`);
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

  // OCR methods
  getPageImageForOcr(pageNum: number): string | null {
    const allImages = this.pageImages();
    const image = allImages.get(pageNum);
    if (!image) {
      console.warn(`getPageImageForOcr(${pageNum}): No image found. Map size: ${allImages.size}, keys: ${Array.from(allImages.keys()).slice(0, 5).join(',')}...`);
    }
    return image && image !== 'loading' && image !== 'failed' ? image : null;
  }

  onOcrCompleted(results: OcrPageResult[]): void {
    console.log('OCR completed:', results.length, 'pages processed');

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
    let blockIdCounter = Date.now();
    const pagesWithOcrResults: number[] = [];  // Only pages that actually have OCR results

    for (const result of results) {
      if (!result.textLines || result.textLines.length === 0) {
        console.log(`[OCR] Page ${result.page}: No textLines, text length: ${result.text?.length || 0}`);
        continue;  // Skip pages with no OCR results - don't remove their existing blocks
      }

      // Only track pages that actually have OCR results
      pagesWithOcrResults.push(result.page);
      console.log(`[OCR] Page ${result.page}: ${result.textLines.length} textLines`);

      const pageWidth = pageDims[result.page]?.width || 600;
      const pageHeight = pageDims[result.page]?.height || 800;

      // Log first line of first page for debugging
      if (result.textLines.length > 0 && result.page === pagesWithOcrResults[0]) {
        const firstLine = result.textLines[0];
        console.log(`[OCR DEBUG] Page ${result.page} dimensions: ${pageWidth} x ${pageHeight}`);
        console.log(`[OCR DEBUG] First line raw bbox: [${firstLine.bbox.join(', ')}]`);
        console.log(`[OCR DEBUG] First line scaled (÷${renderScale}): [${(firstLine.bbox[0]/renderScale).toFixed(1)}, ${(firstLine.bbox[1]/renderScale).toFixed(1)}, ${(firstLine.bbox[2]/renderScale).toFixed(1)}, ${(firstLine.bbox[3]/renderScale).toFixed(1)}]`);
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

        // Estimate font size from line height (rough approximation)
        const estimatedFontSize = Math.round(pdfHeight * 0.8);

        const block: TextBlock = {
          id: `ocr_${blockIdCounter++}`,
          page: result.page,
          x: x1 / renderScale,
          y: pdfY,
          width: (x2 - x1) / renderScale,
          height: pdfHeight,
          text: line.text,
          font_size: estimatedFontSize > 0 ? estimatedFontSize : 12,
          font_name: 'OCR',
          char_count: line.text.length,
          region,
          category_id: categoryId,
          is_ocr: true  // Mark as OCR-generated (independent from images)
        };

        newBlocks.push(block);
      }
    }

    // Only replace blocks on pages that have OCR results
    // Pages with no OCR results keep their existing blocks
    if (pagesWithOcrResults.length > 0) {
      this.editorState.replaceTextBlocksOnPages(pagesWithOcrResults, newBlocks);
    }

    // Update category stats
    this.editorState.updateCategoryStats();

    // Update the open document's blocks
    this.saveCurrentDocumentState();

    // Log results for debugging
    if (newBlocks.length > 0) {
      console.log(`[OCR] Created ${newBlocks.length} text blocks on ${pagesWithOcrResults.length} page(s)`);
    } else {
      console.log(`[OCR] Processed ${results.length} page(s) but no text was detected`);
    }
  }

  // Tab management methods
  onTabSelected(tab: DocumentTab): void {
    // Handle library tab
    if (tab.id === this.LIBRARY_TAB_ID) {
      this.saveCurrentDocumentState();
      this.activeDocumentId.set(null);
      this.pdfLoaded.set(false);
      return;
    }

    if (tab.id === this.activeDocumentId()) return;

    // Save current document state
    this.saveCurrentDocumentState();

    // Restore selected document state
    this.restoreDocumentState(tab.id);
  }

  onTabClosed(tab: DocumentTab): void {
    // Library tab cannot be closed
    if (tab.id === this.LIBRARY_TAB_ID) return;

    const docs = this.openDocuments();
    const docIndex = docs.findIndex(d => d.id === tab.id);
    if (docIndex === -1) return;

    const doc = docs[docIndex];

    // Warn about unsaved changes
    if (doc.hasUnsavedChanges) {
      if (!confirm(`"${doc.name}" has unsaved changes. Close anyway?`)) {
        return;
      }
    }

    // Remove from list
    const newDocs = docs.filter(d => d.id !== tab.id);
    this.openDocuments.set(newDocs);

    // If closing active tab, switch to another or library
    if (tab.id === this.activeDocumentId()) {
      if (newDocs.length > 0) {
        // Switch to previous tab or first available
        const newIndex = Math.max(0, docIndex - 1);
        this.restoreDocumentState(newDocs[newIndex].id);
      } else {
        // No more documents - switch to library tab
        this.activeDocumentId.set(null);
        this.pdfLoaded.set(false);
      }
    }
  }

  closeCurrentTabOrHideWindow(): void {
    const activeId = this.activeDocumentId();

    // If on library tab (no active document), hide the window
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

    console.log('[restoreDocumentState] Restoring doc:', docId, 'blocks:', doc.blocks.length, 'categories:', Object.keys(doc.categories).length);

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
    console.log('[restoreDocumentState] After loadDocument, editorState.blocks:', this.editorState.blocks().length);

    // Restore additional state
    this.editorState.selectedBlockIds.set(doc.selectedBlockIds);
    this.editorState.hasUnsavedChanges.set(doc.hasUnsavedChanges);
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
}

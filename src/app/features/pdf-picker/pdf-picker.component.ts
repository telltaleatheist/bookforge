import { Component, inject, signal, computed, HostListener, ViewChild, effect, DestroyRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PdfService, TextBlock, Category, PageDimension } from './services/pdf.service';
import { ElectronService } from '../../core/services/electron.service';
import { PdfEditorStateService, HistoryAction } from './services/editor-state.service';
import { ProjectService } from './services/project.service';
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

interface BookForgeProject {
  version: number;
  source_path: string;    // Original path
  source_name: string;
  library_path?: string;  // Path to copy in library
  file_hash?: string;     // SHA256 hash for duplicate detection
  deleted_block_ids: string[];
  page_order?: number[];  // Custom page order for organize mode
  custom_categories?: CustomCategoryData[];  // User-created categories with regex/sample matches
  undo_stack?: HistoryAction[];  // Persisted undo history
  redo_stack?: HistoryAction[];  // Persisted redo history
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
        <!-- PDF Viewer (Primary) with Mode Bar -->
        <div pane-primary class="viewer-pane-container">
          <!-- Mode Bar -->
          <div class="mode-bar">
            @for (mode of modes; track mode.id) {
              <button
                class="mode-btn"
                [class.active]="currentMode() === mode.id"
                [title]="mode.tooltip"
                (click)="setMode(mode.id)"
              >
                <span class="mode-icon">{{ mode.icon }}</span>
                <span class="mode-label">{{ mode.label }}</span>
              </button>
            }
          </div>

          <!-- Viewer + Timeline wrapper (stacked vertically) -->
          <div class="viewer-timeline-wrapper">
            <!-- Viewer -->
            <div class="viewer-pane">
              <app-pdf-viewer
              [blocks]="blocks()"
              [categories]="categoriesWithPreview()"
              [categoryHighlights]="combinedHighlights()"
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
              (blockClick)="onBlockClick($event)"
              (blockDoubleClick)="onBlockDoubleClick($event)"
              (blockHover)="onBlockHover($event)"
              (selectLikeThis)="selectLikeThis($event)"
              (deleteLikeThis)="deleteLikeThis($event)"
              (deleteBlock)="deleteBlock($event)"
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

    .mode-bar {
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-subtle);
      padding: var(--ui-spacing-sm);
      gap: var(--ui-spacing-xs);
      flex-shrink: 0;
    }

    .mode-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border: 1px solid transparent;
      border-radius: $radius-md;
      background: transparent;
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      min-width: 56px;

      .mode-icon {
        font-size: var(--ui-icon-size);
        margin-bottom: 2px;
      }

      .mode-label {
        font-size: var(--ui-font-xs);
        color: var(--text-secondary);
      }

      &:hover {
        background: var(--hover-bg);
        border-color: var(--border-default);
      }

      &.active {
        background: var(--accent-subtle);
        border-color: var(--accent);

        .mode-label {
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
  get fileHash() { return this.editorState.fileHash; }
  get pdfLoaded() { return this.editorState.pdfLoaded; }
  get deletedBlockIds() { return this.editorState.deletedBlockIds; }
  get selectedBlockIds() { return this.editorState.selectedBlockIds; }
  get pageOrder() { return this.editorState.pageOrder; }
  get hasUnsavedChanges() { return this.editorState.hasUnsavedChanges; }
  get canUndo() { return this.editorState.canUndo; }
  get canRedo() { return this.editorState.canRedo; }

  // Delegate project state to projectService
  get projectPath() { return this.projectService.projectPath; }

  readonly zoom = signal(100);
  readonly layout = signal<'vertical' | 'grid'>('grid');
  // Split size = window width minus sidebar width (keeps sidebar fixed)
  readonly splitSize = signal(Math.max(400, window.innerWidth - this.SIDEBAR_WIDTH));
  private userResizedSplit = false; // Track if user manually resized

  // Keep sidebar fixed width on window resize (unless user manually resized)
  @HostListener('window:resize')
  onWindowResize(): void {
    if (!this.userResizedSplit) {
      this.splitSize.set(Math.max(400, window.innerWidth - this.SIDEBAR_WIDTH));
    }
  }

  // Keyboard shortcuts
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
      // Don't process other shortcuts when text editor is open
      return;
    }

    // Delete/Backspace to delete selected blocks or focused custom category
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // First, try to delete selected blocks
      if (this.selectedBlockIds().length > 0) {
        event.preventDefault();
        this.deleteSelectedBlocks();
        return;
      }
      // If no blocks selected, try to delete focused custom category
      const focusedCat = this.focusedCategoryId();
      if (focusedCat && focusedCat.startsWith('custom_')) {
        event.preventDefault();
        this.deleteCustomCategory(focusedCat);
        this.focusedCategoryId.set(null);
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

  readonly showFilePicker = signal(false);
  readonly loading = signal(false);
  readonly loadingText = signal('Loading...');

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

  // Text editor modal state
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
  readonly pageImages = signal<Map<number, string>>(new Map());

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
        }
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
      }
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
        this.layout.update(l => l === 'vertical' ? 'grid' : 'vertical');
        break;
      case 'zoom-in':
        // 50% jumps - use scroll wheel or type for precision
        this.zoom.update(z => Math.min(Math.round(z * 1.5), 2000));
        break;
      case 'zoom-out':
        // 50% jumps - use scroll wheel or type for precision
        this.zoom.update(z => Math.max(Math.round(z / 1.5), 10));
        break;
      case 'zoom-reset':
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

  onZoomChange(direction: 'in' | 'out'): void {
    // Reuse toolbar zoom logic
    if (direction === 'in') {
      this.onToolbarAction({ id: 'zoom-in', type: 'button' });
    } else {
      this.onToolbarAction({ id: 'zoom-out', type: 'button' });
    }
  }

  getPageImageUrl(pageNum: number): string {
    const cached = this.pageImages().get(pageNum);
    if (cached && cached !== 'loading' && cached !== 'failed') {
      return cached;
    }
    // Queue this page for loading
    this.queuePageLoad(pageNum);
    // Return 'loading' so template can show placeholder
    return cached === 'loading' ? 'loading' : '';
  }

  // Page loading with throttled queue
  private pageLoadQueue: number[] = [];
  private isProcessingQueue = false;
  private readonly MAX_CONCURRENT_RENDERS = 2; // Max simultaneous renders
  private activeRenders = 0;

  // Scale for rendering - higher values = sharper but more memory
  private getRenderScale(pageCount: number): number {
    if (pageCount > 1000) return 2.0;
    if (pageCount > 500) return 2.5;
    return 3.0;  // 3x scale for crisp text
  }

  private async loadPageImage(pageNum: number, scale: number): Promise<void> {
    // Check if already loaded
    const current = this.pageImages().get(pageNum);
    if (current && current !== 'failed' && current !== 'loading') return;

    // Mark as loading
    this.pageImages.update(map => {
      const newMap = new Map(map);
      newMap.set(pageNum, 'loading');
      return newMap;
    });

    try {
      const pdfPath = this.pdfPath();
      if (!pdfPath) return;

      const dataUrl = await this.pdfService.renderPage(pageNum, scale, pdfPath);
      if (dataUrl) {
        this.pageImages.update(map => {
          const newMap = new Map(map);
          newMap.set(pageNum, dataUrl);
          return newMap;
        });
      } else {
        // Mark as failed for retry
        this.pageImages.update(map => {
          const newMap = new Map(map);
          newMap.set(pageNum, 'failed');
          return newMap;
        });
      }
    } catch {
      this.pageImages.update(map => {
        const newMap = new Map(map);
        newMap.set(pageNum, 'failed');
        return newMap;
      });
    }
  }

  private queuePageLoad(pageNum: number): void {
    const current = this.pageImages().get(pageNum);
    if (current && current !== 'failed') return;

    if (!this.pageLoadQueue.includes(pageNum)) {
      this.pageLoadQueue.push(pageNum);
    }
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    // Process queue with concurrency limit
    while (this.pageLoadQueue.length > 0 && this.activeRenders < this.MAX_CONCURRENT_RENDERS) {
      const pageNum = this.pageLoadQueue.shift()!;
      this.activeRenders++;

      const scale = this.getRenderScale(this.totalPages());
      this.loadPageImage(pageNum, scale).finally(() => {
        this.activeRenders--;
        // Continue processing queue
        this.processQueue();
      });
    }
  }

  private async loadAllPageImages(pageCount: number): Promise<void> {
    const scale = this.getRenderScale(pageCount);

    // Load first 5 pages immediately (sequentially for fast display)
    const priorityPages = Math.min(pageCount, 5);
    for (let i = 0; i < priorityPages; i++) {
      await this.loadPageImage(i, scale);
    }

    // Queue all remaining pages
    for (let i = priorityPages; i < pageCount; i++) {
      this.pageLoadQueue.push(i);
    }

    // Start processing queue with concurrency
    this.processQueue();
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

  private closePdf(): void {
    // Reset all state to show library view
    this.pdfLoaded.set(false);
    this.blocks.set([]);
    // Reset editor state via service
    this.editorState.reset();
    this.pageImages.set(new Map());
    this.projectService.reset();

    // Clear crop mode
    this.currentMode.set('select');
    this.currentCropRect.set(null);
  }

  async loadPdf(path: string): Promise<void> {
    this.showFilePicker.set(false);

    // Check if this PDF is already open (by original path or library path)
    const existingDoc = this.openDocuments().find(d => d.path === path || d.libraryPath === path);
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
      this.pageImages.set(new Map());
      this.projectService.reset();

      this.saveRecentFile(path, result.pdf_name);

      // Load page images
      this.loadingText.set('Rendering pages...');
      await this.loadAllPageImages(result.page_count);

      this.pdfLoaded.set(true);

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

  onBlockDoubleClick(event: { block: TextBlock; metaKey: boolean; ctrlKey: boolean }): void {
    const { block, metaKey, ctrlKey } = event;
    const mode = this.currentMode();
    const additive = metaKey || ctrlKey;

    if (mode === 'select') {
      // In select mode, double-click selects all similar items
      // With Cmd/Ctrl held, add to existing selection
      this.selectLikeThis(block, additive);
    } else if (mode === 'edit') {
      // In edit mode, double-click opens text editor
      this.openTextEditor(block);
    }
    // In crop/organize modes, double-click does nothing
  }

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

    // Update the block's text
    this.blocks.update(blocks =>
      blocks.map(b =>
        b.id === block.id
          ? { ...b, text: newText, char_count: newText.length }
          : b
      )
    );

    // Mark as having unsaved changes
    this.hasUnsavedChanges.set(true);

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
      this.editorState.restoreBlocks(selected);
      this.editorState.clearSelection();
    } else {
      // Delete the non-deleted selected blocks
      this.editorState.deleteSelectedBlocks();
    }
  }

  deleteLikeThis(block: TextBlock): void {
    const categoryId = block.category_id;
    const deleted = this.deletedBlockIds();
    const toDelete = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id))
      .map(b => b.id);

    if (toDelete.length === 0) return;

    this.editorState.deleteBlocks(toDelete);
    this.editorState.clearSelection();
  }

  deleteBlock(blockId: string): void {
    if (this.deletedBlockIds().has(blockId)) return;
    this.editorState.deleteBlocks([blockId]);
  }

  // Delegate undo/redo to service
  undo(): void {
    this.editorState.undo();
  }

  redo(): void {
    this.editorState.redo();
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
    const blockIds = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id))
      .map(b => b.id);

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
    const deleted = this.deletedBlockIds();

    const exportBlocks = this.blocks()
      .filter(b => !deleted.has(b.id) && !b.is_image) // Skip images too
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      this.showAlert({
        title: 'Nothing to Export',
        message: 'No text to export. All blocks have been deleted.',
        type: 'warning'
      });
      return;
    }

    const lines: string[] = [];
    let currentPage = -1;

    for (const block of exportBlocks) {
      if (block.page !== currentPage) {
        if (currentPage >= 0) lines.push('');
        currentPage = block.page;
      }
      // Clean footnote references from the text
      const cleanedText = this.stripFootnoteRefs(block.text);
      if (cleanedText.trim()) {
        lines.push(cleanedText);
      }
    }

    const text = lines.join('\n');
    const baseName = this.pdfName().replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `${baseName}_cleaned_${timestamp}.txt`;

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    this.showAlert({
      title: 'Export Complete',
      message: `Exported ${text.length.toLocaleString()} characters from ${exportBlocks.length} blocks.`,
      type: 'success'
    });
  }

  async exportEpub(): Promise<void> {
    const deleted = this.deletedBlockIds();

    // Get non-deleted text blocks (no images for EPUB - per user request)
    const exportBlocks = this.blocks()
      .filter(b => !deleted.has(b.id) && !b.is_image)
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      this.showAlert({
        title: 'Nothing to Export',
        message: 'No text to export. All blocks have been deleted.',
        type: 'warning'
      });
      return;
    }

    // Build EPUB content
    const bookTitle = this.pdfName().replace(/\.pdf$/i, '');
    const chapters: string[] = [];
    let currentChapter: string[] = [];
    let lastPage = -1;

    for (const block of exportBlocks) {
      // Start new chapter every few pages (roughly)
      if (block.page !== lastPage && block.page % 10 === 0 && currentChapter.length > 0) {
        chapters.push(currentChapter.join('\n'));
        currentChapter = [];
      }
      lastPage = block.page;

      const cleanedText = this.stripFootnoteRefs(block.text);
      if (cleanedText.trim()) {
        // Wrap in paragraph tags
        currentChapter.push(`<p>${this.escapeHtml(cleanedText)}</p>`);
      }
    }

    // Push last chapter
    if (currentChapter.length > 0) {
      chapters.push(currentChapter.join('\n'));
    }

    // Generate simple EPUB structure
    const epub = this.generateEpubBlob(bookTitle, chapters);

    const baseName = bookTitle.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `${baseName}_${timestamp}.epub`;

    const url = URL.createObjectURL(epub);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    this.showAlert({
      title: 'Export Complete',
      message: `Exported EPUB with ${chapters.length} chapters, ${exportBlocks.length} blocks.`,
      type: 'success'
    });
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private generateEpubBlob(title: string, chapters: string[]): Blob {
    // Generate a minimal valid EPUB file
    // EPUB is a ZIP file with specific structure

    const uuid = 'urn:uuid:' + this.generateUuid();
    const date = new Date().toISOString().split('T')[0];

    // Container XML
    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    // OPF content
    const chapterManifest = chapters.map((_, i) =>
      `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const chapterSpine = chapters.map((_, i) =>
      `    <itemref idref="chapter${i + 1}"/>`
    ).join('\n');

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${this.escapeHtml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapterManifest}
  </manifest>
  <spine>
${chapterSpine}
  </spine>
</package>`;

    // Navigation document
    const navItems = chapters.map((_, i) =>
      `        <li><a href="chapter${i + 1}.xhtml">Chapter ${i + 1}</a></li>`
    ).join('\n');

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

    // Chapter XHTMLs
    const chapterXhtmls = chapters.map((content, i) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Chapter ${i + 1}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
  <h1>Chapter ${i + 1}</h1>
${content}
</body>
</html>`);

    // Build ZIP using JSZip-like structure
    // Since we don't have JSZip, we'll create a simple uncompressed ZIP manually
    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/nav.xhtml', content: navXhtml },
      ...chapterXhtmls.map((content, i) => ({
        name: `OEBPS/chapter${i + 1}.xhtml`,
        content
      }))
    ];

    // Create ZIP blob manually
    return this.createZipBlob(files);
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private createZipBlob(files: { name: string; content: string }[]): Blob {
    // Create a simple uncompressed ZIP file
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const centralDirectory: Uint8Array[] = [];
    let offset = 0;

    for (const file of files) {
      const fileData = encoder.encode(file.content);
      const fileName = encoder.encode(file.name);

      // Local file header
      const localHeader = new Uint8Array(30 + fileName.length);
      const view = new DataView(localHeader.buffer);

      view.setUint32(0, 0x04034b50, true);  // Local file header signature
      view.setUint16(4, 20, true);           // Version needed to extract
      view.setUint16(6, 0, true);            // General purpose bit flag
      view.setUint16(8, 0, true);            // Compression method (store)
      view.setUint16(10, 0, true);           // File last mod time
      view.setUint16(12, 0, true);           // File last mod date
      view.setUint32(14, this.crc32(fileData), true); // CRC-32
      view.setUint32(18, fileData.length, true);      // Compressed size
      view.setUint32(22, fileData.length, true);      // Uncompressed size
      view.setUint16(26, fileName.length, true);      // File name length
      view.setUint16(28, 0, true);           // Extra field length

      localHeader.set(fileName, 30);

      // Central directory entry
      const centralEntry = new Uint8Array(46 + fileName.length);
      const centralView = new DataView(centralEntry.buffer);

      centralView.setUint32(0, 0x02014b50, true);  // Central directory signature
      centralView.setUint16(4, 20, true);          // Version made by
      centralView.setUint16(6, 20, true);          // Version needed
      centralView.setUint16(8, 0, true);           // General purpose bit flag
      centralView.setUint16(10, 0, true);          // Compression method
      centralView.setUint16(12, 0, true);          // File last mod time
      centralView.setUint16(14, 0, true);          // File last mod date
      centralView.setUint32(16, this.crc32(fileData), true); // CRC-32
      centralView.setUint32(20, fileData.length, true);      // Compressed size
      centralView.setUint32(24, fileData.length, true);      // Uncompressed size
      centralView.setUint16(28, fileName.length, true);      // File name length
      centralView.setUint16(30, 0, true);          // Extra field length
      centralView.setUint16(32, 0, true);          // File comment length
      centralView.setUint16(34, 0, true);          // Disk number start
      centralView.setUint16(36, 0, true);          // Internal file attributes
      centralView.setUint32(38, 0, true);          // External file attributes
      centralView.setUint32(42, offset, true);     // Relative offset of local header

      centralEntry.set(fileName, 46);

      parts.push(localHeader);
      parts.push(fileData);
      centralDirectory.push(centralEntry);

      offset += localHeader.length + fileData.length;
    }

    // End of central directory record
    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const entry of centralDirectory) {
      parts.push(entry);
      centralDirSize += entry.length;
    }

    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);

    endView.setUint32(0, 0x06054b50, true);  // End of central dir signature
    endView.setUint16(4, 0, true);           // Disk number
    endView.setUint16(6, 0, true);           // Disk number with central dir
    endView.setUint16(8, files.length, true);  // Entries on this disk
    endView.setUint16(10, files.length, true); // Total entries
    endView.setUint32(12, centralDirSize, true); // Size of central directory
    endView.setUint32(16, centralDirOffset, true); // Offset of central directory
    endView.setUint16(20, 0, true);          // ZIP file comment length

    parts.push(endRecord);

    // Combine all parts
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }

    return new Blob([result], { type: 'application/epub+zip' });
  }

  private crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    const table = this.getCrc32Table();
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  private crc32Table: number[] | null = null;

  private getCrc32Table(): number[] {
    if (this.crc32Table) return this.crc32Table;

    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    this.crc32Table = table;
    return table;
  }

  async exportPdf(): Promise<void> {
    // Export PDF via Python - removes deleted blocks' regions from pages
    const deleted = this.deletedBlockIds();
    const deletedBlocksList = this.blocks()
      .filter(b => deleted.has(b.id))
      .map(b => ({
        page: b.page,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height
      }));

    if (deletedBlocksList.length === 0) {
      this.showAlert({
        title: 'Nothing Changed',
        message: 'No blocks have been deleted. The exported PDF would be identical to the original.',
        type: 'info'
      });
      return;
    }

    this.loading.set(true);
    this.loadingText.set('Generating PDF...');

    try {
      const pdfBase64 = await this.pdfService.exportCleanPdf(this.libraryPath(), deletedBlocksList);

      if (!pdfBase64) {
        throw new Error('Failed to generate PDF');
      }

      // pdfBase64 contains base64-encoded PDF
      const binaryString = atob(pdfBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const baseName = this.pdfName().replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `${baseName}_cleaned_${timestamp}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      this.showAlert({
        title: 'Export Complete',
        message: `Exported PDF with ${deletedBlocksList.length} regions removed.`,
        type: 'success'
      });
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

  // Strip footnote reference numbers from text
  private stripFootnoteRefs(text: string): string {
    // Unicode superscript numbers: ⁰¹²³⁴⁵⁶⁷⁸⁹
    const superscriptPattern = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g;

    // Regular numbers that look like footnote refs:
    // - Numbers at end of words (word123 -> word)
    // - Numbers after punctuation with no space (text.1 -> text.)
    const inlineRefPattern = /(?<=\w)(\d{1,3})(?=[\s\.,;:!?\)]|$)/g;

    // Bracketed references: [1], [12], (1), (12)
    const bracketedPattern = /[\[\(]\d{1,3}[\]\)]/g;

    let cleaned = text;
    cleaned = cleaned.replace(superscriptPattern, '');
    cleaned = cleaned.replace(bracketedPattern, '');
    cleaned = cleaned.replace(inlineRefPattern, '');

    // Clean up any double spaces left behind
    cleaned = cleaned.replace(/  +/g, ' ');

    return cleaned.trim();
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
        pageOrder: project.page_order || []
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

      this.pageImages.set(new Map());
      this.projectService.projectPath.set(result.filePath || null);

      // Load page images
      this.loadingText.set('Rendering pages...');
      await this.loadAllPageImages(pdfResult.page_count);
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
        pageOrder: pageOrder
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

      this.pageImages.set(new Map());
      this.projectService.projectPath.set(actualProjectPath);

      // Load page images
      this.loadingText.set('Rendering pages...');
      await this.loadAllPageImages(pdfResult.page_count);

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
    const image = this.pageImages().get(pageNum);
    return image && image !== 'loading' && image !== 'failed' ? image : null;
  }

  onOcrCompleted(results: OcrPageResult[]): void {
    console.log('OCR completed:', results.length, 'pages processed');
    // TODO: Could integrate OCR results into the document
    // For now, the modal handles export/copy
    this.showAlert({
      title: 'OCR Complete',
      message: `Processed ${results.length} pages. Use Copy/Export in the modal to save results.`,
      type: 'success'
    });
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
            pageImages: this.pageImages(),
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
    this.editorState.setHistory({
      undoStack: doc.undoStack,
      redoStack: doc.redoStack
    });

    this.pageImages.set(doc.pageImages);
    this.projectService.projectPath.set(doc.projectPath);
  }

  private clearDocumentState(): void {
    this.activeDocumentId.set(null);
    this.editorState.reset();
    this.pageImages.set(new Map());
    this.projectService.reset();
  }

  private generateDocumentId(): string {
    return 'doc_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }
}

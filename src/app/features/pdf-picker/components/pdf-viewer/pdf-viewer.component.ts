import { Component, input, output, ViewChild, ElementRef, effect, signal, computed, HostListener, ChangeDetectionStrategy, AfterViewInit, OnDestroy, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { TextBlock, Category, PageDimension } from '../../services/pdf.service';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { Chapter } from '../../../../core/services/electron.service';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pageNum: number;
}

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  imports: [CommonModule, ScrollingModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!pdfLoaded()) {
      <div class="placeholder">
        <div class="drop-zone" (click)="openFilePicker()">
          <span class="drop-icon">📄</span>
          <p>Drop PDF here or click to open</p>
        </div>
      </div>
    } @else {
      <!-- Use CDK virtual scrolling for vertical layout, regular scroll for grid/edit/organize -->
      @if (layout() !== 'grid' && editorMode() !== 'select' && editorMode() !== 'edit') {
        <cdk-virtual-scroll-viewport
          #cdkViewport
          class="pdf-viewport"
          [itemSize]="getAveragePageHeight()"
          (wheel)="onWheel($event)"
        >
          <div class="pdf-container">
            <div
              *cdkVirtualFor="let pageNum of pageNumbers(); trackBy: trackByPageNum"
              class="page-wrapper"
              [class.page-deleted]="isPageMarkedDeleted(pageNum)"
              [class.page-selected]="isPageSelected(pageNum)"
              [attr.data-page]="pageNum"
              [style.width.px]="getPageWidth(pageNum)"
              (click)="onPageClick($event, pageNum)"
              (contextmenu)="onPageContextMenu($event, pageNum)"
            >
              <div class="page-content">
                @let imgUrl = getImageUrl(pageNum);
                @if (imgUrl && imgUrl !== 'loading') {
                  <!-- Always render image for proper sizing, use CSS filter to white-out when images deleted -->
                  <img
                    #pageImage
                    class="pdf-image"
                    [class.hidden-for-export]="shouldHidePageImage(pageNum)"
                    [src]="imgUrl"
                    [attr.data-page]="pageNum"
                    (load)="onImageLoad($event, pageNum)"
                  />
                } @else {
                  <div class="page-loading" [style.aspect-ratio]="getPageAspectRatio(pageNum)">
                    <div class="spinner"></div>
                  </div>
                }
                <svg
                  class="block-overlay"
                  [class.crop-mode]="cropMode()"
                  [class.sample-mode]="sampleMode()"
                  [class.marquee-mode]="isMarqueeSelecting()"
                  [class.edit-mode]="editorMode() === 'edit'"
                  [attr.viewBox]="getViewBox(pageNum)"
                  preserveAspectRatio="none"
                  (mousedown)="onOverlayMouseDown($event, pageNum)"
                  (mousemove)="onOverlayMouseMove($event, pageNum)"
                  (mouseup)="onOverlayMouseUp($event, pageNum)"
                  (mouseleave)="onOverlayMouseLeave()"
                >
                  @if (!cropMode() && !sampleMode()) {
                    @for (block of getPageBlocks(pageNum); track trackBlock(block)) {
                      <!-- Text overlay for blanked pages and corrected blocks - rendered FIRST so selection rect appears on top -->
                      @if (shouldShowTextOverlay(block)) {
                        <foreignObject
                          class="text-overlay"
                          [class.deleted]="isDeleted(block.id)"
                          [attr.x]="getBlockX(block)"
                          [attr.y]="getBlockY(block)"
                          [attr.width]="getBlockWidth(block)"
                          [attr.height]="getExpandedHeight(block)"
                        >
                          <div
                            xmlns="http://www.w3.org/1999/xhtml"
                            class="text-overlay-content"
                            [class.deleted]="isDeleted(block.id)"
                            [class.text-layer-mode]="showTextLayer()"
                            [style.font-size.px]="getOverlayFontSize(block)"
                            [style.width.px]="getBlockWidth(block)"
                          >{{ getDisplayText(block) }}</div>
                        </foreignObject>
                      }
                      <!-- Selection/interaction rect - rendered AFTER text overlay so it appears on top -->
                      @if (!shouldHideDeletedBlock(block)) {
                        <rect
                          class="block-rect"
                          [attr.x]="getBlockX(block)"
                          [attr.y]="getBlockY(block)"
                          [attr.width]="getBlockWidth(block)"
                          [attr.height]="getBlockHeight(block)"
                          [attr.fill]="isSelected(block.id) ? getBlockFill(block) : (isCurrentSearchResult(block.id) ? 'rgba(255, 193, 7, 0.4)' : (isSearchHighlighted(block.id) ? 'rgba(255, 193, 7, 0.2)' : 'transparent'))"
                          [attr.stroke]="isSelected(block.id) ? getBlockStroke(block) : (isCurrentSearchResult(block.id) ? '#ffc107' : (isSearchHighlighted(block.id) ? '#ffc107' : (hasCorrectedText(block.id) ? '#4caf50' : (hasOffset(block.id) ? '#2196f3' : 'transparent'))))"
                          [class.selected]="isSelected(block.id)"
                          [class.deleted]="isDeleted(block.id)"
                          [class.corrected]="hasCorrectedText(block.id)"
                          [class.moved]="hasOffset(block.id)"
                          [class.search-highlight]="isSearchHighlighted(block.id)"
                          [class.search-current]="isCurrentSearchResult(block.id)"
                          [class.dragging]="isDraggingBlock() && draggingBlock?.id === block.id"
                          [style.cursor]="editorMode() === 'edit' ? 'move' : 'pointer'"
                          (mousedown)="onBlockMouseDown($event, block)"
                          (click)="onBlockClick($event, block)"
                          (dblclick)="onBlockDoubleClick($event, block)"
                          (contextmenu)="onContextMenu($event, block)"
                          (mouseenter)="onBlockEnter($event, block)"
                          (mouseleave)="onBlockLeave()"
                        />
                        @if (isDeleted(block.id)) {
                          <line
                            [attr.x1]="getBlockX(block)"
                            [attr.y1]="getBlockY(block)"
                            [attr.x2]="getBlockX(block) + getBlockWidth(block)"
                            [attr.y2]="getBlockY(block) + getBlockHeight(block)"
                            stroke="#ff4444"
                            stroke-width="2"
                            class="delete-mark"
                          />
                          <line
                            [attr.x1]="getBlockX(block) + getBlockWidth(block)"
                            [attr.y1]="getBlockY(block)"
                            [attr.x2]="getBlockX(block)"
                            [attr.y2]="getBlockY(block) + getBlockHeight(block)"
                            stroke="#ff4444"
                            stroke-width="2"
                            class="delete-mark"
                          />
                        }
                      }
                    }

                    <!-- Marquee selection rectangle -->
                    @if (isMarqueeSelecting() && currentMarqueeRect() && currentMarqueeRect()!.pageNum === pageNum) {
                      <rect
                        class="marquee-rect"
                        [attr.x]="currentMarqueeRect()!.x"
                        [attr.y]="currentMarqueeRect()!.y"
                        [attr.width]="currentMarqueeRect()!.width"
                        [attr.height]="currentMarqueeRect()!.height"
                        fill="var(--accent-subtle, rgba(6, 182, 212, 0.12))"
                        stroke="var(--accent, #06b6d4)"
                        stroke-width="2"
                      />
                    }
                  }

                  <!-- Category highlights (lightweight match rects for custom categories + regex preview) -->
                  <!-- Shown in normal mode and regex search mode, hidden in crop/sample mode -->
                  <!-- Clicking on a highlight toggles its deleted state -->
                  @if (!cropMode() && !sampleMode()) {
                    @for (highlight of getHighlightsForPage(pageNum); track $index) {
                      <g class="highlight-group" (click)="onHighlightRectClick($event, highlight, pageNum)" style="cursor: pointer;">
                        <rect
                          class="highlight-rect"
                          [class.deleted]="highlight.deleted"
                          [attr.x]="highlight.rect.x"
                          [attr.y]="highlight.rect.y"
                          [attr.width]="highlight.rect.w"
                          [attr.height]="highlight.rect.h"
                          [attr.fill]="highlight.deleted ? 'rgba(255, 68, 68, 0.15)' : highlight.color + '70'"
                          [attr.stroke]="highlight.deleted ? '#ff4444' : highlight.color"
                          stroke-width="1"
                        >
                          <title>{{ highlight.rect.text }} (click to toggle deletion)</title>
                        </rect>
                        @if (highlight.deleted) {
                          <line
                            [attr.x1]="highlight.rect.x"
                            [attr.y1]="highlight.rect.y"
                            [attr.x2]="highlight.rect.x + highlight.rect.w"
                            [attr.y2]="highlight.rect.y + highlight.rect.h"
                            stroke="#ff4444"
                            stroke-width="1"
                            class="highlight-delete-mark"
                          />
                          <line
                            [attr.x1]="highlight.rect.x + highlight.rect.w"
                            [attr.y1]="highlight.rect.y"
                            [attr.x2]="highlight.rect.x"
                            [attr.y2]="highlight.rect.y + highlight.rect.h"
                            stroke="#ff4444"
                            stroke-width="1"
                            class="highlight-delete-mark"
                          />
                        }
                      </g>
                    }
                  }

                  <!-- Chapter markers -->
                  @if (chapters().length > 0 || chaptersMode()) {
                    @for (chapter of getChaptersForPage(pageNum); track chapter.id) {
                      <g
                        class="chapter-marker"
                        [class.draggable]="chaptersMode()"
                        [class.selected]="selectedChapterId() === chapter.id"
                        [style.cursor]="chaptersMode() ? 'grab' : 'default'"
                        (mousedown)="onChapterMarkerMouseDown($event, chapter, pageNum)"
                        (click)="onChapterMarkerClick($event, chapter)"
                      >
                        <!-- Invisible hit area for easier dragging -->
                        <rect
                          class="chapter-hit-area"
                          x="0"
                          [attr.y]="(chapter.y || 20) - 10"
                          [attr.width]="getPageDimensions(pageNum)?.width || 600"
                          height="20"
                          fill="transparent"
                        />
                        <!-- Chapter line -->
                        <line
                          class="chapter-line"
                          x1="0"
                          [attr.y1]="chapter.y || 20"
                          [attr.x2]="getPageDimensions(pageNum)?.width || 600"
                          [attr.y2]="chapter.y || 20"
                          [attr.stroke]="selectedChapterId() === chapter.id ? '#1565c0' : '#4caf50'"
                          [attr.stroke-width]="selectedChapterId() === chapter.id ? 3 : 2"
                          stroke-dasharray="8,4"
                        />
                        @if (editingChapterId() !== chapter.id) {
                          <!-- Chapter label background (double-click to edit) -->
                          <rect
                            class="chapter-label-bg"
                            x="4"
                            [attr.y]="(chapter.y || 20) - 14"
                            [attr.width]="getChapterLabelWidth(chapter.title)"
                            height="16"
                            rx="3"
                            [attr.fill]="selectedChapterId() === chapter.id ? '#1565c0' : '#4caf50'"
                            (dblclick)="onChapterLabelDblClick($event, chapter)"
                          />
                          <!-- Chapter label text -->
                          <text
                            class="chapter-label-text"
                            x="8"
                            [attr.y]="(chapter.y || 20) - 2"
                            fill="white"
                            font-size="10"
                            font-weight="500"
                          >
                            {{ chapter.level > 1 ? '  ' : '' }}{{ chapter.title.length > 30 ? chapter.title.substring(0, 27) + '...' : chapter.title }}
                          </text>
                          <!-- Remove button -->
                          @if (chaptersMode()) {
                            <g
                              class="chapter-remove-btn"
                              [attr.transform]="'translate(' + (getChapterLabelWidth(chapter.title) + 8) + ',' + ((chapter.y || 20) - 14) + ')'"
                              (click)="onChapterRemoveClick($event, chapter)"
                            >
                              <circle cx="8" cy="8" r="7" fill="rgba(0,0,0,0.5)" />
                              <text x="8" y="11" fill="white" font-size="11" font-weight="600" text-anchor="middle">&times;</text>
                            </g>
                          }
                        } @else {
                          <!-- Inline edit input -->
                          <foreignObject
                            x="4"
                            [attr.y]="(chapter.y || 20) - 15"
                            width="200"
                            height="18"
                          >
                            <input
                              xmlns="http://www.w3.org/1999/xhtml"
                              type="text"
                              class="chapter-inline-input"
                              [value]="editingChapterTitle()"
                              (input)="onChapterEditInput($event)"
                              (keydown.enter)="saveChapterEdit(chapter.id)"
                              (keydown.escape)="cancelChapterEdit()"
                              (blur)="onChapterEditBlur(chapter.id)"
                              (click)="$event.stopPropagation()"
                              (mousedown)="$event.stopPropagation()"
                            />
                          </foreignObject>
                        }
                      </g>
                    }
                  }

                  <!-- Crop rectangle overlay -->
                  @if (cropMode() && currentCropRect() && currentCropRect()!.pageNum === pageNum) {
                    <!-- Dark overlay with cutout using path with evenodd fill -->
                    <path
                      [attr.d]="getCropMaskPath(pageNum)"
                      fill="rgba(0, 0, 0, 0.7)"
                      fill-rule="evenodd"
                      class="crop-mask"
                    />

                    <!-- Crop border -->
                    <rect
                      [attr.x]="currentCropRect()!.x"
                      [attr.y]="currentCropRect()!.y"
                      [attr.width]="currentCropRect()!.width"
                      [attr.height]="currentCropRect()!.height"
                      fill="transparent"
                      class="crop-border"
                      (mousedown)="onCropDragStart($event, 'move')"
                    />

                    <!-- Resize handles -->
                    @for (handle of cropHandles(); track handle.id) {
                      <rect
                        class="crop-handle"
                        [class]="'crop-handle-' + handle.cursor"
                        [attr.x]="handle.x"
                        [attr.y]="handle.y"
                        [attr.width]="handle.width"
                        [attr.height]="handle.height"
                        (mousedown)="onCropDragStart($event, handle.id)"
                      />
                    }
                  }

                  <!-- Split line overlay -->
                  @if (splitMode() && splitEnabled() && !isPageSkipped(pageNum)) {
                    <!-- Left half shade -->
                    <rect
                      class="split-shade split-shade-left"
                      x="0"
                      y="0"
                      [attr.width]="getSplitLineX(pageNum)"
                      [attr.height]="getPageDimensions(pageNum)?.height || 0"
                      fill="rgba(59, 130, 246, 0.08)"
                    />
                    <!-- Right half shade -->
                    <rect
                      class="split-shade split-shade-right"
                      [attr.x]="getSplitLineX(pageNum)"
                      y="0"
                      [attr.width]="(getPageDimensions(pageNum)?.width || 0) - getSplitLineX(pageNum)"
                      [attr.height]="getPageDimensions(pageNum)?.height || 0"
                      fill="rgba(245, 158, 11, 0.08)"
                    />
                    <!-- Split line -->
                    <line
                      class="split-line"
                      [attr.x1]="getSplitLineX(pageNum)"
                      [attr.y1]="0"
                      [attr.x2]="getSplitLineX(pageNum)"
                      [attr.y2]="getPageDimensions(pageNum)?.height || 0"
                      stroke="#FF9500"
                      stroke-width="3"
                      stroke-dasharray="10,5"
                    />
                    <!-- Draggable handle area (invisible wide strip for easier grabbing) -->
                    <rect
                      class="split-handle"
                      [attr.x]="getSplitLineX(pageNum) - 15"
                      y="0"
                      width="30"
                      [attr.height]="getPageDimensions(pageNum)?.height || 0"
                      fill="transparent"
                      style="cursor: ew-resize"
                      (mousedown)="onSplitDragStart($event, pageNum)"
                    />
                    <!-- Visual handle indicator -->
                    <rect
                      class="split-handle-visual"
                      [attr.x]="getSplitLineX(pageNum) - 8"
                      [attr.y]="((getPageDimensions(pageNum)?.height || 0) / 2) - 30"
                      width="16"
                      height="60"
                      rx="4"
                      fill="#FF9500"
                      style="cursor: ew-resize; pointer-events: none"
                    />
                    <!-- Page number labels -->
                    <text
                      class="split-label"
                      [attr.x]="getSplitLineX(pageNum) / 2"
                      [attr.y]="30"
                      text-anchor="middle"
                      fill="#3b82f6"
                      font-size="14"
                      font-weight="600"
                    >
                      {{ getSplitLeftPageNum(pageNum) }}
                    </text>
                    <text
                      class="split-label"
                      [attr.x]="getSplitLineX(pageNum) + ((getPageDimensions(pageNum)?.width || 0) - getSplitLineX(pageNum)) / 2"
                      [attr.y]="30"
                      text-anchor="middle"
                      fill="#f59e0b"
                      font-size="14"
                      font-weight="600"
                    >
                      {{ getSplitRightPageNum(pageNum) }}
                    </text>
                  }

                  <!-- Sample mode rectangles -->
                  @if (sampleMode()) {
                    <!-- Completed sample rectangles on this page -->
                    @for (rect of getSampleRectsForPage(pageNum); track $index) {
                      <rect
                        class="sample-rect"
                        [attr.x]="rect.x"
                        [attr.y]="rect.y"
                        [attr.width]="rect.width"
                        [attr.height]="rect.height"
                        fill="rgba(233, 30, 99, 0.2)"
                        stroke="#E91E63"
                        stroke-width="2"
                      />
                    }
                    <!-- Currently drawing rectangle -->
                    @if (sampleCurrentRect() && sampleCurrentRect()!.page === pageNum) {
                      <rect
                        class="sample-rect drawing"
                        [attr.x]="sampleCurrentRect()!.x"
                        [attr.y]="sampleCurrentRect()!.y"
                        [attr.width]="sampleCurrentRect()!.width"
                        [attr.height]="sampleCurrentRect()!.height"
                        fill="rgba(233, 30, 99, 0.15)"
                        stroke="#E91E63"
                        stroke-width="2"
                        stroke-dasharray="6,3"
                      />
                    }
                  }
                </svg>
              </div>
              <div class="page-label">
                @if (splitMode() && splitEnabled()) {
                  <label class="split-checkbox" (click)="$event.stopPropagation()">
                    <input
                      type="checkbox"
                      [checked]="!isPageSkipped(pageNum)"
                      (change)="togglePageSplit($event, pageNum)"
                    />
                    <span>Split</span>
                  </label>
                }
                @if (chaptersMode()) {
                  <button
                    class="page-delete-btn"
                    [class.deleted]="isPageMarkedDeleted(pageNum)"
                    (click)="onPageDeleteClick($event, pageNum)"
                    [title]="isPageMarkedDeleted(pageNum) ? 'Restore page' : 'Delete page from export'"
                  >
                    @if (isPageMarkedDeleted(pageNum)) {
                      ↩
                    } @else {
                      🗑
                    }
                  </button>
                }
                Page {{ pageNum + 1 }}
                @if (isPageMarkedDeleted(pageNum)) {
                  <span class="deleted-badge">excluded</span>
                }
              </div>
            </div>
          </div>
        </cdk-virtual-scroll-viewport>
      } @else {
        <!-- Grid/Organize mode - paginated for performance -->
        <div
          #viewport
          class="pdf-viewport"
          [class.marquee-selecting]="pageMarqueeActive()"
          (wheel)="onWheel($event)"
          (mousedown)="onPageMarqueeStart($event)"
          (mousemove)="onPageMarqueeMove($event)"
          (mouseup)="onPageMarqueeEnd()"
          (mouseleave)="onPageMarqueeEnd()"
        >
          <div
            class="pdf-container"
            [class.grid]="layout() === 'grid'"
            [class.organize-mode]="editorMode() === 'select' || editorMode() === 'edit'"
          >
            @for (pageNum of pageNumbers(); track pageNum; let idx = $index) {
              <div
                class="page-wrapper"
                [class.page-deleted]="isPageMarkedDeleted(pageNum)"
                [class.page-selected]="isPageSelected(pageNum)"
                [attr.data-page]="pageNum"
                [attr.data-index]="idx"
                [style.width.px]="getPageWidth(pageNum)"
                [class.dragging]="isDraggingPage() && draggedPageIndex === idx"
                [class.drag-over]="dragOverIndex() === idx"
                [class.drag-over-before]="dragOverIndex() === idx && dropTargetIndex === idx"
                [class.drag-over-after]="dragOverIndex() === idx && dropTargetIndex === idx + 1"
                [draggable]="editorMode() === 'select' || editorMode() === 'edit'"
                (click)="onPageClick($event, pageNum)"
                (contextmenu)="onPageContextMenu($event, pageNum)"
                (dragstart)="onPageDragStart($event, idx, pageNum)"
                (dragend)="onPageDragEnd($event)"
                (dragover)="onPageDragOver($event, idx)"
                (dragleave)="onPageDragLeave($event)"
                (drop)="onPageDrop($event, idx)"
              >
                <div class="page-content">
                  @let imgUrl = getImageUrl(pageNum);
                  @if (imgUrl && imgUrl !== 'loading') {
                    <img
                      class="pdf-image"
                      [class.hidden-for-export]="shouldHidePageImage(pageNum)"
                      [src]="imgUrl"
                      [attr.data-page]="pageNum"
                    />
                  } @else {
                    <div class="page-loading" [style.aspect-ratio]="getPageAspectRatio(pageNum)">
                      <div class="spinner"></div>
                    </div>
                  }
                  <svg
                    class="block-overlay"
                    [class.crop-mode]="cropMode()"
                    [class.sample-mode]="sampleMode()"
                    [class.edit-mode]="editorMode() === 'edit'"
                    [attr.viewBox]="getViewBox(pageNum)"
                    preserveAspectRatio="none"
                    (mousedown)="onOverlayMouseDown($event, pageNum)"
                    (mousemove)="onOverlayMouseMove($event, pageNum)"
                    (mouseup)="onOverlayMouseUp($event, pageNum)"
                    (mouseleave)="onOverlayMouseLeave()"
                  >
                    @if (!cropMode() && !sampleMode()) {
                      @for (block of getPageBlocks(pageNum); track trackBlock(block)) {
                        <!-- Text overlay for blanked pages and corrected blocks - rendered FIRST so selection rect appears on top -->
                        @if (shouldShowTextOverlay(block)) {
                          <foreignObject
                            class="text-overlay"
                            [attr.x]="getBlockX(block)"
                            [attr.y]="getBlockY(block)"
                            [attr.width]="getBlockWidth(block)"
                            [attr.height]="getExpandedHeight(block)"
                          >
                            <div
                              xmlns="http://www.w3.org/1999/xhtml"
                              class="text-overlay-content"
                              [class.deleted]="isDeleted(block.id)"
                              [class.text-layer-mode]="showTextLayer()"
                              [style.font-size.px]="getOverlayFontSize(block)"
                              [style.width.px]="getBlockWidth(block)"
                            >{{ getDisplayText(block) }}</div>
                          </foreignObject>
                        }
                        <!-- Selection/interaction rect - rendered AFTER text overlay so it appears on top -->
                        @if (!shouldHideDeletedBlock(block)) {
                          <rect
                            class="block-rect"
                            [attr.x]="getBlockX(block)"
                            [attr.y]="getBlockY(block)"
                            [attr.width]="getBlockWidth(block)"
                            [attr.height]="getBlockHeight(block)"
                            [attr.fill]="isSelected(block.id) ? getBlockFill(block) : (isCurrentSearchResult(block.id) ? 'rgba(255, 193, 7, 0.4)' : (isSearchHighlighted(block.id) ? 'rgba(255, 193, 7, 0.2)' : 'transparent'))"
                            [attr.stroke]="isSelected(block.id) ? getBlockStroke(block) : (isCurrentSearchResult(block.id) ? '#ffc107' : (isSearchHighlighted(block.id) ? '#ffc107' : (hasCorrectedText(block.id) ? '#4caf50' : (hasOffset(block.id) ? '#2196f3' : 'transparent'))))"
                            [class.selected]="isSelected(block.id)"
                            [class.deleted]="isDeleted(block.id)"
                            [class.corrected]="hasCorrectedText(block.id)"
                            [class.moved]="hasOffset(block.id)"
                            [class.search-highlight]="isSearchHighlighted(block.id)"
                            [class.search-current]="isCurrentSearchResult(block.id)"
                            [style.cursor]="editorMode() === 'edit' ? 'move' : 'pointer'"
                            (mousedown)="onBlockMouseDown($event, block)"
                            (click)="onBlockClick($event, block)"
                            (dblclick)="onBlockDoubleClick($event, block)"
                            (contextmenu)="onContextMenu($event, block)"
                            (mouseenter)="onBlockEnter($event, block)"
                            (mouseleave)="onBlockLeave()"
                          />
                          @if (isDeleted(block.id)) {
                            <line
                              [attr.x1]="getBlockX(block)"
                              [attr.y1]="getBlockY(block)"
                              [attr.x2]="getBlockX(block) + getBlockWidth(block)"
                              [attr.y2]="getBlockY(block) + getBlockHeight(block)"
                              stroke="#ff4444"
                              stroke-width="2"
                              class="delete-mark"
                            />
                            <line
                              [attr.x1]="getBlockX(block) + getBlockWidth(block)"
                              [attr.y1]="getBlockY(block)"
                              [attr.x2]="getBlockX(block)"
                              [attr.y2]="getBlockY(block) + getBlockHeight(block)"
                              stroke="#ff4444"
                              stroke-width="2"
                              class="delete-mark"
                            />
                          }
                        }
                      }
                    }
                    @if (cropMode() && currentCropRect() && currentCropRect()!.pageNum === pageNum) {
                      <rect
                        class="crop-rect"
                        [attr.x]="currentCropRect()!.x"
                        [attr.y]="currentCropRect()!.y"
                        [attr.width]="currentCropRect()!.width"
                        [attr.height]="currentCropRect()!.height"
                      />
                    }
                    @if (sampleMode()) {
                      @for (rect of getSampleRectsForPage(pageNum); track $index) {
                        <rect
                          class="sample-rect"
                          [attr.x]="rect.x"
                          [attr.y]="rect.y"
                          [attr.width]="rect.width"
                          [attr.height]="rect.height"
                        />
                      }
                    }
                    @for (highlight of getHighlightsForPage(pageNum); track highlight.catId + '-' + $index) {
                      <g class="highlight-group" (click)="onHighlightRectClick($event, highlight, pageNum)" style="cursor: pointer;">
                        <rect
                          class="highlight-rect"
                          [class.deleted]="highlight.deleted"
                          [attr.x]="highlight.rect.x"
                          [attr.y]="highlight.rect.y"
                          [attr.width]="highlight.rect.w"
                          [attr.height]="highlight.rect.h"
                          [attr.fill]="highlight.color + '70'"
                          [attr.stroke]="highlight.color"
                        />
                        @if (highlight.deleted) {
                          <line
                            [attr.x1]="highlight.rect.x"
                            [attr.y1]="highlight.rect.y"
                            [attr.x2]="highlight.rect.x + highlight.rect.w"
                            [attr.y2]="highlight.rect.y + highlight.rect.h"
                            [attr.stroke]="highlight.color"
                            stroke-width="1"
                            class="delete-mark"
                          />
                          <line
                            [attr.x1]="highlight.rect.x + highlight.rect.w"
                            [attr.y1]="highlight.rect.y"
                            [attr.x2]="highlight.rect.x"
                            [attr.y2]="highlight.rect.y + highlight.rect.h"
                            [attr.stroke]="highlight.color"
                            stroke-width="1"
                            class="delete-mark"
                          />
                        }
                      </g>
                    }
                    <!-- Chapter markers (grid mode) -->
                    @if (chapters().length > 0 || chaptersMode()) {
                      @for (chapter of getChaptersForPage(pageNum); track chapter.id) {
                        <g
                          class="chapter-marker"
                          [class.draggable]="chaptersMode()"
                          [class.selected]="selectedChapterId() === chapter.id"
                          [style.cursor]="chaptersMode() ? 'grab' : 'default'"
                          (mousedown)="onChapterMarkerMouseDown($event, chapter, pageNum)"
                          (click)="onChapterMarkerClick($event, chapter)"
                        >
                          <!-- Invisible hit area for easier dragging -->
                          <rect
                            class="chapter-hit-area"
                            x="0"
                            [attr.y]="(chapter.y || 20) - 10"
                            [attr.width]="getPageDimensions(pageNum)?.width || 600"
                            height="20"
                            fill="transparent"
                          />
                          <line
                            class="chapter-line"
                            x1="0"
                            [attr.y1]="chapter.y || 20"
                            [attr.x2]="getPageDimensions(pageNum)?.width || 600"
                            [attr.y2]="chapter.y || 20"
                            [attr.stroke]="selectedChapterId() === chapter.id ? '#1565c0' : '#4caf50'"
                            [attr.stroke-width]="selectedChapterId() === chapter.id ? 3 : 2"
                            stroke-dasharray="8,4"
                          />
                          @if (editingChapterId() !== chapter.id) {
                            <rect
                              class="chapter-label-bg"
                              x="4"
                              [attr.y]="(chapter.y || 20) - 14"
                              [attr.width]="getChapterLabelWidth(chapter.title)"
                              height="16"
                              rx="3"
                              [attr.fill]="selectedChapterId() === chapter.id ? '#1565c0' : '#4caf50'"
                              (dblclick)="onChapterLabelDblClick($event, chapter)"
                            />
                            <text
                              class="chapter-label-text"
                              x="8"
                              [attr.y]="(chapter.y || 20) - 2"
                              fill="white"
                              font-size="10"
                              font-weight="500"
                            >
                              {{ chapter.level > 1 ? '  ' : '' }}{{ chapter.title.length > 30 ? chapter.title.substring(0, 27) + '...' : chapter.title }}
                            </text>
                            @if (chaptersMode()) {
                              <g
                                class="chapter-remove-btn"
                                [attr.transform]="'translate(' + (getChapterLabelWidth(chapter.title) + 8) + ',' + ((chapter.y || 20) - 14) + ')'"
                                (click)="onChapterRemoveClick($event, chapter)"
                              >
                                <circle cx="8" cy="8" r="7" fill="rgba(0,0,0,0.5)" />
                                <text x="8" y="11" fill="white" font-size="11" font-weight="600" text-anchor="middle">&times;</text>
                              </g>
                            }
                          } @else {
                            <foreignObject
                              x="4"
                              [attr.y]="(chapter.y || 20) - 15"
                              width="200"
                              height="18"
                            >
                              <input
                                xmlns="http://www.w3.org/1999/xhtml"
                                type="text"
                                class="chapter-inline-input"
                                [value]="editingChapterTitle()"
                                (input)="onChapterEditInput($event)"
                                (keydown.enter)="saveChapterEdit(chapter.id)"
                                (keydown.escape)="cancelChapterEdit()"
                                (blur)="onChapterEditBlur(chapter.id)"
                                (click)="$event.stopPropagation()"
                                (mousedown)="$event.stopPropagation()"
                              />
                            </foreignObject>
                          }
                        </g>
                      }
                    }
                    @if (isMarqueeSelecting() && currentMarqueeRect() && currentMarqueeRect()!.pageNum === pageNum) {
                      <rect
                        class="marquee-rect"
                        [attr.x]="currentMarqueeRect()!.x"
                        [attr.y]="currentMarqueeRect()!.y"
                        [attr.width]="currentMarqueeRect()!.width"
                        [attr.height]="currentMarqueeRect()!.height"
                        fill="var(--accent-subtle, rgba(6, 182, 212, 0.12))"
                        stroke="var(--accent, #06b6d4)"
                        stroke-width="2"
                      />
                    }
                  </svg>
                </div>
                <div class="page-label">
                  @if (chaptersMode()) {
                    <button
                      class="page-delete-btn"
                      [class.deleted]="isPageMarkedDeleted(pageNum)"
                      (click)="onPageDeleteClick($event, pageNum)"
                      [title]="isPageMarkedDeleted(pageNum) ? 'Restore page' : 'Delete page from export'"
                    >
                      @if (isPageMarkedDeleted(pageNum)) {
                        ↩
                      } @else {
                        🗑
                      }
                    </button>
                  }
                  Page {{ pageNum + 1 }}
                  @if (isPageMarkedDeleted(pageNum)) {
                    <span class="deleted-badge">excluded</span>
                  }
                </div>
              </div>
            }
          </div>

          <!-- Page marquee selection box -->
          @if (pageMarqueeActive()) {
            <div
              class="page-marquee-box"
              [style.left.px]="pageMarqueeRect().left"
              [style.top.px]="pageMarqueeRect().top"
              [style.width.px]="pageMarqueeRect().width"
              [style.height.px]="pageMarqueeRect().height"
            ></div>
          }
        </div>
      }
    }

    <!-- Tooltip -->
    @if (hoveredBlock()) {
      <div
        class="block-tooltip"
        [style.left.px]="tooltipX()"
        [style.top.px]="tooltipY()"
        (mouseenter)="keepTooltip()"
        (mouseleave)="hideTooltip()"
      >
        <div class="tooltip-header">
          <span
            class="tooltip-category"
            [style.background]="categories()[hoveredBlock()!.category_id]?.color"
          >
            {{ categories()[hoveredBlock()!.category_id]?.name }}
          </span>
          <span class="tooltip-size">{{ hoveredBlock()!.font_size }}pt</span>
        </div>
        <div class="tooltip-text">
          {{ hoveredBlock()!.text.substring(0, 200) }}{{ hoveredBlock()!.text.length > 200 ? '...' : '' }}
        </div>
        <div class="tooltip-actions">
          <desktop-button variant="ghost" size="xs" (click)="onDeleteBlock()">Delete</desktop-button>
          <desktop-button variant="secondary" size="xs" (click)="onSelectLikeThis()">Select like this</desktop-button>
          <desktop-button variant="danger" size="xs" (click)="onDeleteLikeThis()">Delete all like this</desktop-button>
          @if (hasCorrectedText(hoveredBlock()!.id)) {
            <desktop-button variant="ghost" size="xs" (click)="onRevertBlock()">Revert to original</desktop-button>
          }
        </div>
      </div>
    }

    <!-- Page Context Menu -->
    @if (pageMenuVisible()) {
      <div
        class="page-context-menu"
        [style.left.px]="pageMenuX()"
        [style.top.px]="pageMenuY()"
      >
        @if (organizeMode() || chaptersMode()) {
          @if (selectedPages().size > 0) {
            <div class="menu-item danger" (click)="onDeleteSelectedPages()">
              Delete {{ selectedPages().size }} selected page{{ selectedPages().size !== 1 ? 's' : '' }}
            </div>
            <div class="menu-item" (click)="onClearPageSelection()">Clear selection</div>
            <div class="menu-divider"></div>
          }
          @if (!isPageSelected(pageMenuPageNum())) {
            <div class="menu-item" (click)="onSelectPage(pageMenuPageNum())">Select page {{ pageMenuPageNum() + 1 }}</div>
          } @else {
            <div class="menu-item" (click)="onDeselectPage(pageMenuPageNum())">Deselect page {{ pageMenuPageNum() + 1 }}</div>
          }
          @if (!isPageMarkedDeleted(pageMenuPageNum())) {
            <div class="menu-item danger" (click)="onDeleteSinglePage(pageMenuPageNum())">Delete page {{ pageMenuPageNum() + 1 }}</div>
          } @else {
            <div class="menu-item" (click)="onRestoreSinglePage(pageMenuPageNum())">Restore page {{ pageMenuPageNum() + 1 }}</div>
          }
        } @else {
          <div class="menu-item" (click)="onSelectAllOnPage()">Select all on page {{ pageMenuPageNum() + 1 }}</div>
          <div class="menu-item" (click)="onDeselectAllOnPage()">Deselect all on page {{ pageMenuPageNum() + 1 }}</div>
        }
      </div>
    }
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      flex: 1;
      min-height: 0; // Required for flex children to shrink properly
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      overflow: hidden;
    }

    .placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-sunken);
    }

    .drop-zone {
      width: 300px;
      height: 200px;
      border: 2px dashed var(--border-default);
      border-radius: $radius-lg;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all $duration-fast $ease-out;
    }

    .drop-zone:hover {
      border-color: var(--accent);
      background: var(--accent-subtle);
    }

    .drop-icon {
      font-size: calc(var(--ui-icon-size) * 1.5);
      margin-bottom: var(--ui-spacing-sm);
      opacity: 0.5;
    }

    .drop-zone p {
      color: var(--text-secondary);
      margin: 0;
      font-size: var(--ui-font-base);
    }

    // CDK virtual scroll viewport - needs explicit height to function
    cdk-virtual-scroll-viewport {
      flex: 1;
      height: 0; // Required for flex: 1 to work properly with CDK virtual scroll
      min-height: 0;
      background: var(--bg-sunken);
      user-select: none;
      -webkit-user-select: none;
    }

    .pdf-viewport {
      flex: 1;
      overflow: auto;
      padding: var(--ui-spacing-lg);
      background: var(--bg-sunken);
      user-select: none;
      -webkit-user-select: none;
    }

    .pdf-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--ui-spacing-lg);
      padding: var(--ui-spacing-md);
    }

    .pdf-container.grid {
      flex-direction: row !important;
      flex-wrap: wrap !important;
      justify-content: flex-start !important;
      align-items: flex-start !important;
      align-content: flex-start !important;
      gap: var(--ui-spacing-lg) !important;
      padding: var(--ui-spacing-xl) !important;
      min-height: calc(100% + var(--ui-spacing-xl)); // Ensure space below pages
    }

    // Remove old manual virtual scroll styles - now using CDK
    .pdf-container.virtual-scroll {
      position: relative;
      left: 50%;
      transform: translateX(-50%);
    }

    .page-wrapper {
      position: relative;
      box-shadow: var(--shadow-lg);
      background: white;
      flex-shrink: 0;
      transition: width 0.15s ease-out, transform 0.15s ease-out, opacity 0.15s ease-out;
    }

    /* Organize mode drag/drop styles */
    .organize-mode .page-wrapper {
      cursor: grab;

      &:active {
        cursor: grabbing;
      }
    }

    .page-wrapper.dragging {
      opacity: 0.5;
      transform: scale(0.95);
      cursor: grabbing;
    }

    .page-wrapper.drag-over-before::before,
    .page-wrapper.drag-over-after::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      width: 4px;
      background: var(--accent, #FF9500);
      border-radius: 2px;
      animation: dropIndicatorPulse 0.5s ease-in-out infinite;
    }

    .page-wrapper.drag-over-before::before {
      left: -8px;
    }

    .page-wrapper.drag-over-after::after {
      right: -8px;
    }

    @keyframes dropIndicatorPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .page-content {
      position: relative;
      line-height: 0;
      width: 100%;
    }

    .page-loading {
      width: 100%;
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .page-blank {
      width: 100%;
      background: white;
      position: relative;
      z-index: 0;  /* Ensure it stays behind .block-overlay (z-index: 10) */
    }

    /* Make image appear white when images are deleted - keeps dimensions for SVG sizing */
    .pdf-image.hidden-for-export {
      filter: brightness(0) invert(1);  /* Makes any image appear white */
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-subtle);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .page-label {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xs) 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      background: var(--bg-elevated);

      .split-checkbox {
        display: flex;
        align-items: center;
        gap: var(--ui-spacing-xs);
        cursor: pointer;
        color: var(--accent);
        font-weight: 500;

        input[type="checkbox"] {
          width: 14px;
          height: 14px;
          cursor: pointer;
          accent-color: var(--accent);
        }
      }

      .page-delete-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
        font-size: 14px;
        transition: background-color 0.15s ease, transform 0.1s ease;

        &:hover {
          background: rgba(255, 68, 68, 0.1);
          transform: scale(1.1);
        }

        &.deleted {
          color: #4caf50;

          &:hover {
            background: rgba(76, 175, 80, 0.1);
          }
        }
      }

      .deleted-badge {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        color: #ff4444;
        background: rgba(255, 68, 68, 0.1);
        padding: 2px 6px;
        border-radius: 3px;
        letter-spacing: 0.5px;
      }
    }

    /* Page marked as deleted */
    .page-wrapper.page-deleted {
      .page-content {
        opacity: 0.4;
        filter: grayscale(0.5);
      }

      .page-label {
        background: rgba(255, 68, 68, 0.1);
        color: #ff4444;
      }
    }

    /* Page selected (for organize/chapters mode) */
    .page-wrapper.page-selected {
      .page-content {
        outline: 3px solid var(--accent, #FF9500);
        outline-offset: -3px;
      }

      .page-label {
        background: var(--accent, #FF9500);
        color: white;
      }
    }

    /* Selected + deleted combo */
    .page-wrapper.page-selected.page-deleted {
      .page-content {
        outline-color: #ff4444;
      }

      .page-label {
        background: #ff4444;
      }
    }

    /* Page marquee selection */
    .pdf-viewport.marquee-selecting {
      user-select: none;
      cursor: crosshair;
    }

    .page-marquee-box {
      position: absolute;
      background: var(--accent-subtle, rgba(6, 182, 212, 0.12));
      border: 2px solid var(--accent, #06b6d4);
      pointer-events: none;
      z-index: 50;
    }

    .pdf-image {
      display: block;
      width: 100%;
      height: auto;
      position: relative;
      z-index: 0;  /* Ensure image stays behind .block-overlay (z-index: 10) */
    }

    .block-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: all;
      cursor: crosshair;
      z-index: 10;  /* Ensure SVG is above image */

      &.crop-mode {
        cursor: crosshair;
      }

      &.marquee-mode {
        cursor: crosshair;
      }

      &.edit-mode {
        cursor: text;
      }

      &.organize-mode {
        cursor: grab;
      }

      &.sample-mode {
        cursor: crosshair;
      }
    }

    .sample-rect {
      pointer-events: none;

      &.drawing {
        animation: samplePulse 0.5s ease-in-out infinite;
      }
    }

    @keyframes samplePulse {
      0%, 100% { stroke-opacity: 1; }
      50% { stroke-opacity: 0.6; }
    }

    .marquee-rect {
      pointer-events: none;
      animation: marqueePulse 0.5s ease-in-out infinite;
    }

    @keyframes marqueePulse {
      0%, 100% { stroke-opacity: 1; }
      50% { stroke-opacity: 0.5; }
    }

    .crop-mask {
      pointer-events: none;
    }

    .crop-border {
      stroke: var(--accent, #FF9500);
      stroke-width: 3;
      stroke-dasharray: 8,4;
      cursor: move;
      pointer-events: all;
      animation: cropPulse 1.5s ease-in-out infinite;
    }

    .crop-handle {
      fill: var(--accent, #FF9500);
      stroke: white;
      stroke-width: 1.5;
      pointer-events: all;
      transition: transform 0.1s ease-out;

      &:hover {
        transform: scale(1.2);
      }
    }

    .crop-handle-nwse { cursor: nwse-resize; }
    .crop-handle-nesw { cursor: nesw-resize; }
    .crop-handle-ns { cursor: ns-resize; }
    .crop-handle-ew { cursor: ew-resize; }

    @keyframes cropPulse {
      0%, 100% { stroke-opacity: 1; }
      50% { stroke-opacity: 0.7; }
    }

    // Split mode styles
    .split-shade {
      pointer-events: none;
      transition: opacity 0.2s ease;
    }

    .split-line {
      pointer-events: none;
      transition: stroke-opacity 0.2s ease;
    }

    .split-handle {
      pointer-events: all;
      cursor: ew-resize;
    }

    .split-handle-visual {
      pointer-events: none;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
    }

    .split-label {
      pointer-events: none;
      font-family: $font-body;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    }

    .block-overlay .block-rect {
      pointer-events: all;
      cursor: pointer;
      stroke-width: 0.5;
      transition: stroke-width $duration-fast $ease-out, filter $duration-fast $ease-out, opacity $duration-fast $ease-out;
    }

    .block-overlay.edit-mode .block-rect {
      cursor: text;
    }

    .block-overlay .block-rect:hover {
      stroke-width: 1.5 !important;
      filter: brightness(1.2);
    }

    .block-overlay .block-rect.selected {
      stroke: white !important;
      stroke-width: 2 !important;
      stroke-dasharray: 4,2;
    }

    .block-overlay .block-rect.disabled {
      opacity: 0.15;
    }

    .block-overlay .block-rect.deleted {
      fill: rgba(255, 68, 68, 0.15) !important;
      stroke: transparent !important;
      opacity: 0.5;
    }

    .block-overlay .block-rect.search-highlight {
      stroke-width: 2 !important;
    }

    .block-overlay .block-rect.search-current {
      stroke-width: 3 !important;
      animation: search-pulse 1s ease-in-out infinite;
    }

    @keyframes search-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .block-overlay .block-rect.corrected {
      stroke: #4caf50 !important;
      stroke-width: 2;
      stroke-dasharray: 6, 2;
      fill: rgba(76, 175, 80, 0.1);
    }

    .block-overlay .block-rect.dimmed {
      opacity: 0.08 !important;
      stroke-width: 0.25 !important;
    }

    // Category highlight rects (lightweight pattern matches)
    // Click to toggle deleted state
    .block-overlay .highlight-group {
      pointer-events: all;
      cursor: pointer;
    }

    .block-overlay .highlight-rect {
      pointer-events: all;
      stroke-width: 1;
      opacity: 0.8;
    }

    .block-overlay .highlight-rect.deleted {
      fill: rgba(255, 68, 68, 0.15) !important;
      stroke: #ff4444 !important;
      stroke-dasharray: 4, 2;
      opacity: 0.5;
    }

    .highlight-delete-mark {
      pointer-events: none;  // Let clicks pass through to parent group
      opacity: 0.8;
    }

    .delete-mark {
      pointer-events: none;  // Let clicks pass through to parent group
      opacity: 0.8;
    }

    /* Chapter markers */
    .chapter-marker {
      pointer-events: none;  // By default, let clicks pass through

      &.draggable {
        pointer-events: all;  // In chapters mode, make interactive
        cursor: grab;

        &:hover {
          .chapter-line {
            stroke-width: 3;
            stroke: #2e7d32;
          }
          .chapter-label-bg {
            fill: #2e7d32;
          }
          .chapter-remove-btn {
            opacity: 1;
          }
        }

        &:active {
          cursor: grabbing;
        }

        .chapter-label-bg,
        .chapter-label-text {
          pointer-events: all;  // Enable dblclick for inline editing
        }
      }

      &.selected {
        .chapter-remove-btn {
          opacity: 1;
        }
      }
    }

    .chapter-hit-area {
      pointer-events: all;  // Make the invisible hit area clickable
    }

    .chapter-line {
      pointer-events: none;
      transition: stroke-width 0.15s ease, stroke 0.15s ease;
    }

    .chapter-label-bg {
      pointer-events: none;
      transition: fill 0.15s ease;
    }

    .chapter-label-text {
      pointer-events: none;
      user-select: none;
    }

    .chapter-remove-btn {
      pointer-events: all;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;

      &:hover circle {
        fill: #d32f2f;
      }
    }

    .chapter-inline-input {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      font-size: 10px;
      font-weight: 500;
      padding: 1px 4px;
      border: 1px solid #1565c0;
      border-radius: 3px;
      outline: none;
      background: white;
      color: #333;
    }

    /* Text overlay for corrected/moved blocks */
    .text-overlay {
      pointer-events: none;
      overflow: visible;
    }

    .text-overlay-content {
      padding: 0;
      /* Use a neutral serif font stack typical of books */
      font-family: 'Times New Roman', Times, 'Noto Serif', Georgia, serif;
      line-height: 1.15;
      color: #000000;
      background-color: transparent;
      border: none;
      white-space: pre-wrap;
      word-wrap: break-word;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      margin: 0;
      /* Slightly tighten letter spacing to match typical book typography */
      letter-spacing: -0.01em;
    }

    /* Only show background for corrected/moved blocks where we need to cover original text */
    .text-overlay-content.corrected {
      background: #ffffff;
      border: 1px dashed #4caf50;
    }

    .text-overlay-content.moved {
      background: #ffffff;
      border: 1px dashed #2196f3;
    }

    .text-overlay-content.corrected.moved {
      background: #ffffff;
      border: 1px dashed #00bcd4;
    }

    /* Deleted text - faded ghost text so user can still read what's being removed */
    .text-overlay-content.deleted {
      opacity: 0.35;
      color: #666666;
    }

    /* Text layer mode - show all extracted text with semi-transparent background for readability */
    .text-overlay-content.text-layer-mode {
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(0, 0, 0, 0.1);
      padding: 2px;
    }

    /* Tooltip */
    .block-tooltip {
      position: fixed;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      padding: var(--ui-spacing-md);
      max-width: 300px;
      box-shadow: var(--shadow-lg);
      z-index: $z-tooltip;
      animation: menuPopIn $duration-fast $ease-out forwards;
      transform-origin: top left;
    }

    .tooltip-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--ui-spacing-sm);
    }

    .tooltip-category {
      font-size: var(--ui-font-xs);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      border-radius: $radius-full;
      color: white;
      transition: transform $duration-fast $ease-out;
    }

    .tooltip-size {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .tooltip-text {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      margin-bottom: var(--ui-spacing-sm);
      max-height: 100px;
      overflow: hidden;
    }

    .tooltip-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
      justify-content: flex-end;
    }

    /* Page Context Menu */
    .page-context-menu {
      position: fixed;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      padding: var(--ui-spacing-xs);
      min-width: 180px;
      box-shadow: var(--shadow-lg);
      z-index: $z-dropdown;
      animation: menuPopIn $duration-fast $ease-out forwards;
      transform-origin: top left;
    }

    .menu-item {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      border-radius: $radius-sm;
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover {
        background: var(--hover-bg);
        transform: translateX(2px);
      }

      &.danger {
        color: #ff4444;

        &:hover {
          background: rgba(255, 68, 68, 0.1);
        }
      }
    }

    .menu-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: var(--ui-spacing-xs) 0;
    }

    @keyframes menuPopIn {
      from {
        opacity: 0;
        transform: scale(0.95) translateY(-4px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }
  `],
})
export class PdfViewerComponent implements AfterViewInit, OnDestroy {
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.closeAllContextMenus();
    // Also deselect chapter marker
    if (this.chaptersMode() && this.selectedChapterId()) {
      this.selectedChapterId.set(null);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Delete selected chapter marker
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.chaptersMode() && this.selectedChapterId()) {
      event.preventDefault();
      this.chapterDelete.emit(this.selectedChapterId()!);
      this.selectedChapterId.set(null);
    }
  }

  blocks = input.required<TextBlock[]>();
  categories = input.required<Record<string, Category>>();
  pageDimensions = input.required<PageDimension[]>();
  totalPages = input.required<number>();
  zoom = input.required<number>();
  layout = input.required<'vertical' | 'grid'>();
  selectedBlockIds = input.required<string[]>();
  deletedBlockIds = input.required<Set<string>>();
  pdfLoaded = input.required<boolean>();
  pageImageUrlFn = input.required<(pageNum: number) => string>({ alias: 'getPageImageUrl' });
  pageImages = input<Map<number, string>>(new Map()); // Signal-tracked page images for reactivity
  cropMode = input<boolean>(false);
  cropCurrentPage = input<number>(0);
  editorMode = input<string>('select'); // 'select' | 'edit' | 'crop' | 'split'
  pageOrder = input<number[]>([]); // Custom page order for organize mode

  // Split mode inputs
  splitMode = input<boolean>(false);
  splitEnabled = input<boolean>(false);  // Whether splitting is enabled in config
  splitPositionFn = input<((pageNum: number) => number) | null>(null);  // Function to get split position for a page
  skippedPages = input<Set<number>>(new Set());  // Pages to NOT split

  // Sample mode inputs (for custom category creation)
  sampleMode = input<boolean>(false);
  sampleRects = input<Array<{ page: number; x: number; y: number; width: number; height: number }>>([]);
  sampleCurrentRect = input<{ page: number; x: number; y: number; width: number; height: number } | null>(null);

  // Regex search mode - hides block overlays and shows only regex matches
  regexSearchMode = input<boolean>(false);

  // Remove backgrounds mode - show all text as overlays on white background
  removeBackgrounds = input<boolean>(false);

  // Show text layer mode - display all extracted text overlays for OCR verification
  showTextLayer = input<boolean>(false);

  // Explicitly blanked pages - pages that have been rendered as blank (due to image deletion)
  // This is controlled by the parent and used to show text overlays
  blankedPages = input<Set<number>>(new Set());

  // Custom category highlights - lightweight match rects grouped by category and page
  categoryHighlights = input<Map<string, Record<number, Array<{ page: number; x: number; y: number; w: number; h: number; text: string }>>>>(new Map());

  // Deleted highlight IDs - highlights that should show X strikethrough
  deletedHighlightIds = input<Set<string>>(new Set());

  // Block IDs that have text corrections (for visual indicator)
  correctedBlockIds = input<Set<string>>(new Set());

  // Block position offsets (for drag/drop) - maps blockId to {offsetX, offsetY}
  blockOffsets = input<Map<string, { offsetX: number; offsetY: number }>>(new Map());

  // Text corrections - maps blockId to corrected text (for rendering overlays)
  textCorrections = input<Map<string, string>>(new Map());

  // Block size overrides - maps blockId to {width, height} (for resized blocks)
  blockSizes = input<Map<string, { width: number; height: number }>>(new Map());

  // Chapters mode inputs
  chapters = input<Chapter[]>([]);
  chaptersMode = input<boolean>(false);
  deletedPages = input<Set<number>>(new Set());  // Pages marked for exclusion from export

  // Page selection (for organize/chapters mode)
  selectedPages = input<Set<number>>(new Set());
  organizeMode = input<boolean>(false);

  blockClick = output<{ block: TextBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>();
  blockDoubleClick = output<{
    block: TextBlock;
    metaKey: boolean;
    ctrlKey: boolean;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
  }>();
  blockHover = output<TextBlock | null>();
  selectLikeThis = output<TextBlock>();
  deleteLikeThis = output<TextBlock>();
  deleteBlock = output<string>();
  highlightClick = output<{ catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>();  // Click on category highlight
  revertBlock = output<string>();  // Revert text correction
  zoomChange = output<number>();  // Emits zoom delta (e.g., +5 for zoom in, -5 for zoom out)
  selectAllOnPage = output<number>();
  deselectAllOnPage = output<number>();
  cropComplete = output<CropRect>();
  pageReorder = output<number[]>(); // Emitted when pages are reordered
  splitPositionChange = output<{ pageNum: number; position: number }>(); // Emitted when split line is dragged
  splitPageToggle = output<{ pageNum: number; enabled: boolean }>(); // Emitted when page split checkbox toggled

  // Sample mode outputs
  sampleMouseDown = output<{ event: MouseEvent; page: number; pageX: number; pageY: number }>();
  sampleMouseMove = output<{ pageX: number; pageY: number }>();
  sampleMouseUp = output<void>();

  // Block drag output (for edit mode)
  blockMoved = output<{ blockId: string; offsetX: number; offsetY: number }>();
  blockDragEnd = output<{ blockId: string; pageNum: number }>();

  // Chapter click output (for chapters mode)
  chapterClick = output<{ block: TextBlock; level: number }>();

  // Chapter placement output (for clicking on empty space in chapters mode)
  chapterPlacement = output<{ pageNum: number; y: number; level: number }>();

  // Chapter drag output (for dragging chapter markers)
  chapterDrag = output<{ chapterId: string; pageNum: number; y: number; snapToBlock?: TextBlock }>();

  // Chapter delete output (for deleting selected chapter marker)
  chapterDelete = output<string>();

  // Chapter select output (for syncing selection to chapters panel)
  chapterSelect = output<string>();

  // Chapter rename output (for inline title editing on markers)
  chapterRename = output<{ chapterId: string; newTitle: string }>();

  // Page delete output (for chapters mode)
  pageDeleteToggle = output<number>();

  // Page selection outputs (for organize/chapters mode)
  pageSelect = output<{ pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>();
  deleteSelectedPages = output<Set<number>>();

  // Search highlight state
  readonly searchHighlightIds = signal<Set<string>>(new Set());
  readonly currentSearchResultId = signal<string | null>(null);

  // Virtual scrolling state
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(800);
  private readonly PAGE_BUFFER = 2; // Render this many pages above/below viewport
  private readonly PAGE_GAP = 16; // Gap between pages in pixels
  private scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollTime = 0;

  // Cycling selection state - for clicking through overlapping blocks
  private lastClickPosition: { x: number; y: number; pageNum: number } | null = null;
  private lastClickTime = 0;
  private overlappingBlocksAtClick: TextBlock[] = [];
  private cycleIndex = 0;
  // Cycling window: clicks faster than 250ms are double-clicks, slower than 800ms are new selections
  // Only cycle for clicks between 250-800ms
  private readonly DOUBLE_CLICK_THRESHOLD = 250; // ms - clicks faster than this are double-clicks
  private readonly CYCLE_CLICK_MAX = 800; // ms - clicks slower than this are new selections
  private readonly CLICK_POSITION_TOLERANCE = 20; // SVG units - clicks within this distance are considered same position

  // Grid pagination - limit initial render for performance
  readonly gridPageLimit = signal(24); // Show 24 pages initially (6x4 grid)
  private readonly GRID_PAGE_INCREMENT = 24;

  // Computed: pages to show in grid mode (paginated)
  readonly visibleGridPages = computed(() => {
    const allPages = this.pageNumbers();
    const limit = this.gridPageLimit();
    return allPages.slice(0, limit);
  });

  // Check if there are more pages to load in grid
  readonly hasMoreGridPages = computed(() => {
    return this.gridPageLimit() < this.pageNumbers().length;
  });

  // Load more pages in grid mode
  loadMoreGridPages(): void {
    const current = this.gridPageLimit();
    const total = this.pageNumbers().length;
    this.gridPageLimit.set(Math.min(current + this.GRID_PAGE_INCREMENT, total));
  }

  // Reset grid pagination (call when switching to grid mode or loading new doc)
  resetGridPagination(): void {
    this.gridPageLimit.set(24);
  }

  // Computed: which pages are visible based on scroll position
  readonly visiblePageRange = computed(() => {
    const allPages = this.pageNumbers();
    if (allPages.length === 0) return { start: 0, end: 0, pages: [] as number[] };

    // In grid mode or edit/select mode, show all pages (they're small)
    if (this.layout() === 'grid' || this.editorMode() === 'select' || this.editorMode() === 'edit') {
      return { start: 0, end: allPages.length, pages: allPages };
    }

    const dims = this.pageDimensions();
    const zoom = this.zoom() / 100;
    const scroll = this.scrollTop();
    const viewport = this.viewportHeight();

    // Calculate cumulative heights to find visible range
    let cumHeight = 0;
    let startIdx = 0;
    let endIdx = allPages.length;
    let foundStart = false;

    for (let i = 0; i < allPages.length; i++) {
      const pageNum = allPages[i];
      const pageDim = dims[pageNum];
      const pageHeight = pageDim ? pageDim.height * zoom : 800 * zoom;
      const pageTop = cumHeight;
      const pageBottom = cumHeight + pageHeight;

      // Page is visible if it overlaps with the viewport
      // (page bottom > viewport top) AND (page top < viewport bottom)
      const viewportTop = scroll;
      const viewportBottom = scroll + viewport;

      // If page bottom is still above the viewport, skip it
      if (pageBottom < viewportTop && !foundStart) {
        startIdx = i + 1;
      } else {
        foundStart = true;
      }

      // If page top is below the viewport, we're done
      if (pageTop > viewportBottom) {
        endIdx = i;
        break;
      }

      cumHeight += pageHeight + this.PAGE_GAP;
    }

    // Apply buffer - render extra pages above and below for smooth scrolling
    startIdx = Math.max(0, startIdx - this.PAGE_BUFFER);
    endIdx = Math.min(allPages.length, endIdx + this.PAGE_BUFFER);

    return {
      start: startIdx,
      end: endIdx,
      pages: allPages.slice(startIdx, endIdx)
    };
  });

  // Get offset for a page (for absolute positioning in virtual scroll)
  getPageOffset(pageNum: number): number {
    const allPages = this.pageNumbers();
    const dims = this.pageDimensions();
    const zoom = this.zoom() / 100;
    let offset = 0;

    for (const p of allPages) {
      if (p === pageNum) break;
      const pageDim = dims[p];
      const pageHeight = pageDim ? pageDim.height * zoom : 800 * zoom;
      offset += pageHeight + this.PAGE_GAP;
    }
    return offset;
  }

  // Get total scroll height for all pages
  getTotalScrollHeight(): number {
    const allPages = this.pageNumbers();
    const dims = this.pageDimensions();
    const zoom = this.zoom() / 100;
    let total = 0;

    for (const pageNum of allPages) {
      const pageDim = dims[pageNum];
      const pageHeight = pageDim ? pageDim.height * zoom : 800 * zoom;
      total += pageHeight + this.PAGE_GAP;
    }
    return total;
  }

  // Drag state for organize mode
  draggedPageIndex: number | null = null;
  dropTargetIndex: number | null = null;
  readonly isDraggingPage = signal(false);
  readonly dragOverIndex = signal<number | null>(null);

  // Block drag state (for edit mode)
  draggingBlock: TextBlock | null = null;  // Public for template access
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragStartBlockX: number = 0;
  private dragStartBlockY: number = 0;
  readonly isDraggingBlock = signal(false);

  // Chapter drag state
  private draggingChapter: Chapter | null = null;
  private draggingChapterPageNum: number = 0;
  readonly isDraggingChapter = signal(false);

  // Selected chapter marker (for deletion)
  readonly selectedChapterId = signal<string | null>(null);

  // Inline chapter editing state
  readonly editingChapterId = signal<string | null>(null);
  readonly editingChapterTitle = signal<string>('');
  private chapterEditSaveOnBlur = true;

  // Crop drawing state
  readonly isDrawingCrop = signal(false);
  readonly cropStartPoint = signal<{ x: number; y: number; pageNum: number } | null>(null);
  readonly currentCropRect = signal<CropRect | null>(null);

  // Crop drag/resize state
  readonly isDraggingCrop = signal(false);
  readonly cropDragType = signal<string | null>(null); // 'move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'
  readonly cropDragStart = signal<{ x: number; y: number; rect: CropRect } | null>(null);

  // Handle size (in SVG coordinates)
  private readonly HANDLE_SIZE = 12;

  // Cache blocks grouped by page - computed once when blocks change
  readonly blocksByPage = computed(() => {
    const map = new Map<number, TextBlock[]>();
    for (const block of this.blocks()) {
      const page = block.page;
      if (!map.has(page)) {
        map.set(page, []);
      }
      map.get(page)!.push(block);
    }
    return map;
  });

  // Computed signal: pages where all image blocks are deleted (show white background)
  readonly pagesWithAllImagesDeleted = computed(() => {
    const result = new Set<number>();
    const deleted = this.deletedBlockIds();
    const blocksByPage = this.blocksByPage();

    for (const [pageNum, pageBlocks] of blocksByPage) {
      const imageBlocks = pageBlocks.filter(b => b.is_image);
      if (imageBlocks.length > 0 && imageBlocks.every(b => deleted.has(b.id))) {
        result.add(pageNum);
      }
    }
    return result;
  });

  // Computed signal: block IDs that should show text overlays
  // This is used directly in the template for proper reactivity
  readonly blocksWithTextOverlay = computed(() => {
    const result = new Set<string>();
    const deleted = this.deletedBlockIds();
    // Use explicit blankedPages input, NOT pagesWithAllImagesDeleted
    // because rerenderPageWithEdits preserves native PDF text
    const explicitBlankedPages = this.blankedPages();
    const removeBackgrounds = this.removeBackgrounds();
    const corrections = this.textCorrections();
    const offsets = this.blockOffsets();
    const sizes = this.blockSizes();

    for (const block of this.blocks()) {
      const isDeleted = deleted.has(block.id);
      const pageIsBlanked = explicitBlankedPages.has(block.page);

      if (!isDeleted) {
        // Normal case: show overlay based on various conditions
        if (removeBackgrounds || block.is_ocr || pageIsBlanked ||
            corrections.has(block.id) || offsets.has(block.id) || sizes.has(block.id)) {
          result.add(block.id);
        }
      } else {
        // Block is deleted - show text for deleted image blocks on blanked pages
        if (block.is_image && block.text && pageIsBlanked) {
          result.add(block.id);
        }
      }
    }
    return result;
  });

  /**
   * Get all category highlights for a specific page (for lazy rendering)
   */
  getHighlightsForPage(pageNum: number): Array<{ catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; color: string; deleted: boolean }> {
    const result: Array<{ catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; color: string; deleted: boolean }> = [];
    const highlights = this.categoryHighlights();
    const cats = this.categories();
    const deletedIds = this.deletedHighlightIds();

    for (const [catId, pageMap] of highlights) {
      const cat = cats[catId];
      // Only show highlights for enabled categories
      if (!cat?.enabled) continue;

      const pageRects = pageMap[pageNum];
      if (pageRects && pageRects.length > 0) {
        const color = cat.color || '#ff0000';
        for (const rect of pageRects) {
          // Check if this highlight is deleted
          const highlightId = `${catId}:${pageNum}:${Math.round(rect.x)}:${Math.round(rect.y)}`;
          const deleted = deletedIds.has(highlightId);
          result.push({ catId, rect, color, deleted });
        }
      }
    }

    return result;
  }

  // Computed handles for crop resize
  readonly cropHandles = computed(() => {
    const rect = this.currentCropRect();
    if (!rect) return [];

    const hs = this.HANDLE_SIZE;
    const hh = hs / 2; // half handle

    return [
      // Corners
      { id: 'nw', x: rect.x - hh, y: rect.y - hh, width: hs, height: hs, cursor: 'nwse' },
      { id: 'ne', x: rect.x + rect.width - hh, y: rect.y - hh, width: hs, height: hs, cursor: 'nesw' },
      { id: 'se', x: rect.x + rect.width - hh, y: rect.y + rect.height - hh, width: hs, height: hs, cursor: 'nwse' },
      { id: 'sw', x: rect.x - hh, y: rect.y + rect.height - hh, width: hs, height: hs, cursor: 'nesw' },
      // Edges
      { id: 'n', x: rect.x + rect.width / 2 - hh, y: rect.y - hh, width: hs, height: hs, cursor: 'ns' },
      { id: 's', x: rect.x + rect.width / 2 - hh, y: rect.y + rect.height - hh, width: hs, height: hs, cursor: 'ns' },
      { id: 'e', x: rect.x + rect.width - hh, y: rect.y + rect.height / 2 - hh, width: hs, height: hs, cursor: 'ew' },
      { id: 'w', x: rect.x - hh, y: rect.y + rect.height / 2 - hh, width: hs, height: hs, cursor: 'ew' },
    ];
  });

  // Marquee selection state
  readonly isMarqueeSelecting = signal(false);
  readonly marqueeStartPoint = signal<{ x: number; y: number; pageNum: number } | null>(null);
  readonly currentMarqueeRect = signal<CropRect | null>(null);

  // Auto-scroll during marquee selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly AUTO_SCROLL_SPEED = 8;  // Pixels per frame
  private readonly AUTO_SCROLL_EDGE_THRESHOLD = 50;  // Pixels from edge to trigger scroll
  private boundDocumentMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundDocumentMouseUp: ((e: MouseEvent) => void) | null = null;
  private lastMouseClientY = 0;  // Track mouse Y for auto-scroll direction

  // Output for marquee selection
  marqueeSelect = output<{ blockIds: string[]; additive: boolean }>();

  @ViewChild('viewport') viewport!: ElementRef<HTMLDivElement>;
  @ViewChild('cdkViewport') cdkViewport!: CdkVirtualScrollViewport;

  // Zoom state for preserving scroll position
  private pendingZoomAdjustment: { scrollRatioX: number; scrollRatioY: number; cursorX: number; cursorY: number } | null = null;
  private previousZoom = 100;
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly elementRef = inject(ElementRef);

  constructor() {
    // Effect to adjust scroll position after zoom changes
    effect(() => {
      const currentZoom = this.zoom();
      if (this.pendingZoomAdjustment && this.viewport?.nativeElement) {
        const vp = this.viewport.nativeElement;
        const adj = this.pendingZoomAdjustment;
        const zoomRatio = currentZoom / this.previousZoom;

        // Calculate new scroll position to keep cursor at same content point
        const newScrollLeft = (vp.scrollLeft + adj.cursorX) * zoomRatio - adj.cursorX;
        const newScrollTop = (vp.scrollTop + adj.cursorY) * zoomRatio - adj.cursorY;

        // Apply scroll adjustment after a microtask to let DOM update
        requestAnimationFrame(() => {
          vp.scrollLeft = Math.max(0, newScrollLeft);
          vp.scrollTop = Math.max(0, newScrollTop);
        });

        this.previousZoom = currentZoom;
        this.pendingZoomAdjustment = null;
      }
    });

    // Effect to force change detection when text overlay state changes
    // This is needed because cdkVirtualFor doesn't re-render when internal signals change
    effect(() => {
      // Read these signals to track changes
      this.pagesWithAllImagesDeleted();
      this.blocksWithTextOverlay();
      this.blankedPages();
      this.pageImages();
      this.selectedBlockIds(); // Track selection changes for visual updates

      // Force Angular to re-render the component
      setTimeout(() => {
        this.cdr.detectChanges();
      }, 0);
    });
  }

  ngAfterViewInit(): void {
    // Initialize viewport tracking after view is ready
    setTimeout(() => this.initViewport(), 0);
  }

  ngOnDestroy(): void {
    // Clean up marquee auto-scroll listeners and interval
    this.stopMarqueeAutoScroll();
  }

  // Block context menu state (signals for proper change detection)
  readonly contextMenuBlock = signal<TextBlock | null>(null);
  readonly contextMenuX = signal(0);
  readonly contextMenuY = signal(0);

  // Page context menu state
  readonly pageMenuVisible = signal(false);
  readonly pageMenuX = signal(0);
  readonly pageMenuY = signal(0);
  readonly pageMenuPageNum = signal(0);

  // Page selection state (for range selection with shift-click)
  private lastSelectedPage: number | null = null;

  // Page marquee selection state (for organize/chapters mode)
  readonly pageMarqueeActive = signal(false);
  readonly pageMarqueeStart = signal({ x: 0, y: 0 });
  readonly pageMarqueeEnd = signal({ x: 0, y: 0 });

  // Computed marquee rectangle (handles negative dimensions from drag direction)
  readonly pageMarqueeRect = computed(() => {
    const start = this.pageMarqueeStart();
    const end = this.pageMarqueeEnd();
    return {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  });

  // Aliases for template compatibility
  hoveredBlock(): TextBlock | null { return this.contextMenuBlock(); }
  tooltipX(): number { return this.contextMenuX(); }
  tooltipY(): number { return this.contextMenuY(); }

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    // Check if click is outside context menus
    const target = event.target as HTMLElement;
    if (!target.closest('.block-tooltip') && !target.closest('.page-context-menu')) {
      this.closeAllContextMenus();
    }
  }

  pageNumbers(): number[] {
    // Use custom page order if available
    const order = this.pageOrder();
    if (order && order.length > 0) {
      return order;
    }
    return Array.from({ length: this.totalPages() }, (_, i) => i);
  }

  // Get the display index for a page (position in the current order)
  getPageDisplayIndex(pageNum: number): number {
    const order = this.pageOrder();
    if (order && order.length > 0) {
      return order.indexOf(pageNum);
    }
    return pageNum;
  }

  getImageUrl(pageNum: number): string {
    // For blanked pages, always use the function to get the latest rendered image
    // This ensures we get the blank page image after renderBlankPage is called
    if (this.blankedPages().has(pageNum)) {
      const fn = this.pageImageUrlFn();
      return fn(pageNum);
    }

    // Read from pageImages signal for reactivity (triggers re-render on update)
    const images = this.pageImages();
    const fromSignal = images.get(pageNum);
    if (fromSignal) {
      return fromSignal;
    }
    // Fallback to function call
    const fn = this.pageImageUrlFn();
    return fn(pageNum);
  }

  /**
   * Check if page image should be hidden and replaced with white background.
   * This happens when:
   * 1. The page has been explicitly blanked (via blankedPages input from parent)
   * 2. Remove Backgrounds mode is on (shows only text overlays on white)
   */
  shouldHidePageImage(pageNum: number): boolean {
    // Hide page image if explicitly blanked OR if removeBackgrounds is on
    // When removeBackgrounds is on, we show text overlays on white background
    return this.blankedPages().has(pageNum) || this.removeBackgrounds();
  }

  getPageWidth(pageNum: number): number {
    const dims = this.pageDimensions()[pageNum];
    if (!dims) return 600;

    // In grid mode, use a smaller base size for thumbnails
    if (this.layout() === 'grid') {
      // Grid thumbnails: smaller fixed-ish size scaled by zoom
      const gridBaseWidth = 200; // Base thumbnail width
      return gridBaseWidth * (this.zoom() / 100);
    }

    return dims.width * (this.zoom() / 100);
  }

  // Get average page height for CDK virtual scroll itemSize
  getAveragePageHeight(): number {
    const dims = this.pageDimensions();
    const zoom = this.zoom() / 100;

    if (dims.length === 0) return 800 * zoom;

    // Calculate average height from first few pages
    let totalHeight = 0;
    const samplesToCheck = Math.min(dims.length, 5);
    for (let i = 0; i < samplesToCheck; i++) {
      totalHeight += (dims[i]?.height || 800) * zoom;
    }

    // Add gap for spacing
    return (totalHeight / samplesToCheck) + this.PAGE_GAP;
  }

  // TrackBy function for CDK virtual scrolling
  trackByPageNum(_index: number, pageNum: number): number {
    return pageNum;
  }

  getViewBox(pageNum: number): string {
    const dims = this.pageDimensions()[pageNum];
    if (!dims) return '0 0 600 800';
    return `0 0 ${dims.width} ${dims.height}`;
  }

  getPageAspectRatio(pageNum: number): string {
    const dims = this.pageDimensions()[pageNum];
    if (!dims) return '612 / 792'; // Default letter size ratio
    return `${dims.width} / ${dims.height}`;
  }

  getPageBlocks(pageNum: number): TextBlock[] {
    const blocks = this.blocksByPage().get(pageNum) || [];
    // Debug: log OCR blocks
    const ocrBlocks = blocks.filter(b => b.is_ocr);
    if (ocrBlocks.length > 0 && pageNum < 3) {
      console.log(`[PDFViewer] Page ${pageNum}: ${blocks.length} blocks (${ocrBlocks.length} OCR)`);
      ocrBlocks.forEach(b => {
        console.log(`  OCR block ${b.id}: (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) ${b.width.toFixed(1)}x${b.height.toFixed(1)}, text: "${b.text.substring(0, 50)}..."`);
      });
    }
    return blocks;
  }

  /**
   * Track function for @for loop that includes blanked state.
   * This ensures Angular re-renders blocks when their page becomes blanked.
   */
  trackBlock(block: TextBlock): string {
    // Only use explicit blankedPages, not pagesWithAllImagesDeleted
    const isBlanked = this.blankedPages().has(block.page) || this.removeBackgrounds();
    return `${block.id}_${isBlanked}`;
  }

  /**
   * Get blocks that should show text overlays for a specific page.
   * This method reads blocksWithTextOverlay() to ensure reactivity when deletions change.
   */
  getBlocksWithOverlayForPage(pageNum: number): TextBlock[] {
    const overlayIds = this.blocksWithTextOverlay();
    const pageBlocks = this.getPageBlocks(pageNum);
    return pageBlocks.filter(block => overlayIds.has(block.id));
  }

  getSampleRectsForPage(pageNum: number): Array<{ x: number; y: number; width: number; height: number }> {
    return this.sampleRects().filter(r => r.page === pageNum);
  }

  /**
   * Get chapters that start on a specific page
   */
  getChaptersForPage(pageNum: number): Chapter[] {
    return this.chapters().filter(c => c.page === pageNum);
  }

  /**
   * Get chapter label width (max 200px)
   */
  getChapterLabelWidth(title: string): number {
    return Math.min(200, title.length * 6 + 20);
  }

  /**
   * Check if a page is marked as deleted
   */
  isPageMarkedDeleted(pageNum: number): boolean {
    return this.deletedPages().has(pageNum);
  }

  /**
   * Toggle page deletion and emit event
   */
  onPageDeleteClick(event: MouseEvent, pageNum: number): void {
    event.stopPropagation();
    event.preventDefault();
    this.pageDeleteToggle.emit(pageNum);
  }

  getBlockFill(block: TextBlock): string {
    const cat = this.categories()[block.category_id];
    return (cat?.color || '#FF9500') + '70';
  }

  getBlockStroke(block: TextBlock): string {
    const cat = this.categories()[block.category_id];
    return cat?.color || '#FF9500';
  }

  isSelected(blockId: string): boolean {
    return this.selectedBlockIds().includes(blockId);
  }

  isDeleted(blockId: string): boolean {
    return this.deletedBlockIds().has(blockId);
  }

  /**
   * Check if a deleted block should be hidden from rendering.
   * Full-page background images are hidden (no X marks on them).
   * Smaller deleted blocks show with X marks so user can see what's removed.
   */
  shouldHideDeletedBlock(block: TextBlock): boolean {
    // Only consider hiding if block is actually deleted
    if (!this.isDeleted(block.id)) return false;

    // Hide full-page image blocks (background scans) - don't show giant X across page
    if (block.is_image) {
      const pageDims = this.pageDimensions()[block.page];
      if (pageDims) {
        const pageArea = pageDims.width * pageDims.height;
        const blockArea = block.width * block.height;
        // If image covers more than 70% of page, it's a background - hide it
        if (blockArea > pageArea * 0.7) {
          return true;
        }
      }
    }

    // Show all other deleted blocks (text, smaller images) with X marks
    return false;
  }

  hasCorrectedText(blockId: string): boolean {
    return this.correctedBlockIds().has(blockId);
  }

  hasOffset(blockId: string): boolean {
    return this.blockOffsets().has(blockId);
  }

  getBlockX(block: TextBlock): number {
    const offset = this.blockOffsets().get(block.id);
    return block.x + (offset?.offsetX ?? 0);
  }

  getBlockY(block: TextBlock): number {
    const offset = this.blockOffsets().get(block.id);
    const baseY = block.y + (offset?.offsetY ?? 0);
    // No adjustment - use exact position from text extraction/OCR
    return baseY;
  }

  getBlockWidth(block: TextBlock): number {
    const sizeOverride = this.blockSizes().get(block.id);
    const baseWidth = sizeOverride?.width ?? block.width;

    // For OCR blocks, use exact width - OCR bounding boxes are usually accurate
    // For native PDF text, add minimal buffer to cover text extraction inaccuracies
    if (block.is_ocr) {
      return baseWidth;
    }
    // Reduced buffer (1% + 2px) for native PDF text
    return baseWidth * 1.01 + 2;
  }

  getBlockHeight(block: TextBlock): number {
    const sizeOverride = this.blockSizes().get(block.id);
    const baseHeight = sizeOverride?.height ?? block.height;

    // For OCR blocks, use exact height
    if (block.is_ocr) {
      return baseHeight;
    }
    // Minimal buffer for native PDF text
    return baseHeight + 1;
  }

  getCorrectedText(blockId: string): string | null {
    return this.textCorrections().get(blockId) ?? null;
  }

  hasTextOverlay(block: TextBlock): boolean {
    // Show text overlay if:
    // 1. Block has correction OR has been moved/resized
    // 2. Remove backgrounds mode is enabled (show ALL text as overlays)
    // 3. Block is OCR-generated (text is independent from page image)
    // 4. Page image is hidden (all images deleted) - must show text as overlays
    if (this.removeBackgrounds()) {
      return true;
    }
    if (block.is_ocr) {
      // Debug: log OCR overlay decision
      if (block.page < 3) {
        console.log(`[PDFViewer] OCR block ${block.id} on page ${block.page} - showing text overlay`);
      }
      return true;  // OCR blocks always show text overlay
    }
    if (this.shouldHidePageImage(block.page)) {
      return true;  // All images deleted - show text as overlay on white background
    }
    return this.hasCorrectedText(block.id) || this.hasOffset(block.id) || this.blockSizes().has(block.id);
  }

  /**
   * Determine if text overlay should be shown for a block.
   * This is the main check used in the template.
   */
  shouldShowTextOverlay(block: TextBlock): boolean {
    // Don't show overlay for image blocks without meaningful text
    // Image blocks may have placeholder text like "[Image 525x854]" which we should ignore
    if (block.is_image) {
      const hasOnlyPlaceholder = !block.text || block.text.startsWith('[Image ');
      if (hasOnlyPlaceholder) {
        return false;
      }
    }

    // Show Text Layer mode: show all text blocks as overlays for OCR verification
    // This is useful for scanned PDFs with invisible OCR text layer
    if (this.showTextLayer()) {
      // Skip image blocks without meaningful text content
      if (block.is_image && (!block.text || block.text.trim().length < 5)) {
        return false;
      }
      return true;
    }

    const deleted = this.isDeleted(block.id);

    // Page is blanked ONLY if explicitly in blankedPages input (set by parent)
    // Note: pagesWithAllImagesDeleted is NOT used here because rerenderPageWithEdits
    // now preserves native PDF text (paints white over images only), so we don't need overlays
    const pageIsBlanked = this.blankedPages().has(block.page);

    // When removeBackgrounds is on OR page is explicitly blanked, show overlays for ALL blocks with text
    if (this.removeBackgrounds() || pageIsBlanked) {
      // Always show text (including deleted blocks - they'll appear faded)
      return true;
    }

    // Normal mode (no background removal, page not blanked)
    // OCR blocks always show text overlay (they have no visual in the PDF)
    if (block.is_ocr) {
      return true;
    }

    // Show overlay for blocks with corrections/offsets/resizes
    if (!deleted) {
      if (this.hasCorrectedText(block.id) || this.hasOffset(block.id) || this.blockSizes().has(block.id)) return true;
    }

    // Show faded text for deleted OCR blocks (so user can still read what's being removed)
    // For non-OCR blocks, the native PDF text is already visible, so no overlay needed
    if (deleted && !block.is_image && block.text && block.is_ocr) {
      return true;
    }

    return false;
  }

  getDisplayText(block: TextBlock): string {
    return this.getCorrectedText(block.id) ?? block.text;
  }

  /**
   * Get the font size for a text overlay.
   *
   * For OCR blocks, calculate font size to fit the bounding box height,
   * since OCR font size estimation is often inaccurate.
   *
   * For native PDF text with corrections/overlays, we may need to adjust to fit.
   */
  getOverlayFontSize(block: TextBlock): number {
    const baseFontSize = block.font_size || 12;

    // For OCR blocks, calculate font size from block height to ensure text fits
    // The block height represents the visual space the text should occupy
    if (block.is_ocr) {
      const blockHeight = this.getBlockHeight(block);
      const lineCount = block.line_count || 1;

      // Calculate font size so text fills the height
      // For line-height 1.15, font_size = height / (lineCount * 1.15)
      // Add small buffer to prevent overflow
      const lineHeightRatio = 1.2;  // Slightly more than CSS line-height for safety
      const calculatedSize = blockHeight / (lineCount * lineHeightRatio);

      // Clamp to sensible range
      const fontSize = Math.max(8, Math.min(48, calculatedSize));
      return Math.round(fontSize);
    }

    // For non-OCR blocks with text corrections, we may need to fit text in the box
    const blockHeight = this.getBlockHeight(block);

    // Check if this is a single-line block
    const isSingleLine = blockHeight < baseFontSize * 2;

    // For multi-line blocks, just use the original font size
    if (!isSingleLine) {
      return baseFontSize;
    }

    // For single-line blocks, check if text fits
    const text = this.getDisplayText(block);
    const width = this.getBlockWidth(block);

    // No padding in CSS, so use full width
    const availableWidth = width;

    if (availableWidth <= 0 || !text) {
      return baseFontSize;
    }

    // Estimate text width using a conservative character width ratio
    const avgCharWidthRatio = 0.5;
    const estimatedTextWidth = text.length * baseFontSize * avgCharWidthRatio;

    if (estimatedTextWidth <= availableWidth) {
      return baseFontSize;
    }

    // Calculate font size that would fit the text on one line
    const fittingFontSize = availableWidth / (text.length * avgCharWidthRatio);

    // Don't shrink below 8px or more than 30% of original
    const minFontSize = Math.max(8, baseFontSize * 0.7);

    return Math.max(minFontSize, fittingFontSize);
  }

  /**
   * Calculate the height needed for the text overlay.
   * This accounts for text wrapping based on the calculated font size.
   */
  getExpandedHeight(block: TextBlock): number {
    const baseHeight = this.getBlockHeight(block);
    const displayText = this.getDisplayText(block);
    const width = this.getBlockWidth(block);
    const fontSize = this.getOverlayFontSize(block);

    // For OCR blocks, just use the base height - the bounding box is calibrated
    if (block.is_ocr) {
      return baseHeight;
    }

    // No padding in CSS, use full width
    const availableWidth = width;

    if (availableWidth <= 0 || !displayText) {
      return baseHeight;
    }

    // Calculate how many characters fit per line
    const avgCharWidthRatio = 0.5;
    const charWidth = fontSize * avgCharWidthRatio;
    const charsPerLine = Math.max(1, Math.floor(availableWidth / charWidth));

    // Count explicit newlines and calculate wrapped lines
    const lines = displayText.split('\n');
    let totalLines = 0;
    for (const line of lines) {
      // Each line wraps based on character count
      const wrappedLines = Math.max(1, Math.ceil(line.length / charsPerLine));
      totalLines += wrappedLines;
    }

    // Calculate height: lines * lineHeight (1.15 from CSS)
    const lineHeight = fontSize * 1.15;
    const neededHeight = totalLines * lineHeight;

    // Return the larger of base height or needed height
    return Math.max(baseHeight, neededHeight);
  }

  isCategoryEnabled(categoryId: string): boolean {
    return this.categories()[categoryId]?.enabled ?? true;
  }

  isDimmed(block: TextBlock): boolean {
    // Dim blocks that are not selected when there's an active selection
    const selected = this.selectedBlockIds();
    if (selected.length === 0) return false;
    return !selected.includes(block.id);
  }

  onImageLoad(_event: Event, _pageNum: number): void {
    // Image loaded - SVG overlay will match automatically
  }

  /**
   * Handle click on a category highlight rect - toggles its deleted state
   */
  onHighlightRectClick(
    event: MouseEvent,
    highlight: { catId: string; rect: { x: number; y: number; w: number; h: number; text: string }; color: string; deleted: boolean },
    pageNum: number
  ): void {
    event.preventDefault();
    event.stopPropagation();

    // Emit the highlight click event to toggle deleted state
    this.highlightClick.emit({
      catId: highlight.catId,
      rect: highlight.rect,
      pageNum,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey
    });
  }

  onBlockClick(event: MouseEvent, block: TextBlock): void {
    event.preventDefault();
    event.stopPropagation();

    // In chapters mode, emit chapter click instead
    if (this.chaptersMode()) {
      const level = event.shiftKey ? 2 : 1; // Shift+click for section (level 2)
      this.chapterClick.emit({ block, level });
      return;
    }

    const now = Date.now();
    const timeSinceLastClick = now - this.lastClickTime;

    // Get click position in SVG coordinates
    const clickPos = this.getClickPositionInSVG(event, block.page);

    // Check if this click is at the same position as the last click (for cycling)
    const isSamePosition = this.lastClickPosition &&
      this.lastClickPosition.pageNum === block.page &&
      clickPos &&
      Math.abs(clickPos.x - this.lastClickPosition.x) < this.CLICK_POSITION_TOLERANCE &&
      Math.abs(clickPos.y - this.lastClickPosition.y) < this.CLICK_POSITION_TOLERANCE;

    // Cycling window: between double-click speed and max cycle time
    // Too fast = double-click (let dblclick handler deal with it)
    // Too slow = new selection
    // Just right = cycle through overlapping blocks
    const isTooFastForCycle = timeSinceLastClick < this.DOUBLE_CLICK_THRESHOLD;
    const isWithinCycleWindow = timeSinceLastClick >= this.DOUBLE_CLICK_THRESHOLD &&
                                 timeSinceLastClick < this.CYCLE_CLICK_MAX;
    const shouldCycle = isSamePosition && isWithinCycleWindow && this.overlappingBlocksAtClick.length > 1;

    // Debug logging
    console.log('[Cycling] click:', {
      clickPos,
      lastPos: this.lastClickPosition,
      isSamePosition,
      timeSinceLastClick,
      isTooFastForCycle,
      isWithinCycleWindow,
      overlappingCount: this.overlappingBlocksAtClick.length,
      shouldCycle
    });

    if (shouldCycle) {
      // Cycle to next overlapping block
      this.cycleIndex = (this.cycleIndex + 1) % this.overlappingBlocksAtClick.length;
      const cycledBlock = this.overlappingBlocksAtClick[this.cycleIndex];

      this.lastClickTime = now;

      this.blockClick.emit({
        block: cycledBlock,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey
      });
    } else if (isTooFastForCycle && isSamePosition) {
      // Click is too fast - likely second click of a double-click
      // Don't emit blockClick, just update time so cycling state is preserved
      // The dblclick handler will fire and use the correct block from cycling state
      this.lastClickTime = now;
      console.log('[Cycling] Skipping click emission - potential double-click');
    } else {
      // New click position - find all overlapping blocks
      if (clickPos) {
        this.overlappingBlocksAtClick = this.findBlocksAtPosition(clickPos.x, clickPos.y, block.page);
        console.log('[Cycling] Found overlapping blocks:', this.overlappingBlocksAtClick.map(b => ({
          id: b.id,
          category: b.category_id,
          isImage: b.is_image,
          area: b.width * b.height
        })));
        this.cycleIndex = 0;
        this.lastClickPosition = { x: clickPos.x, y: clickPos.y, pageNum: block.page };
      } else {
        this.overlappingBlocksAtClick = [block];
        this.cycleIndex = 0;
        this.lastClickPosition = null;
      }

      this.lastClickTime = now;

      // Emit the first block in the sorted list (smallest/most specific)
      // This ensures clicking on overlapping blocks starts with the most specific one
      const blockToSelect = this.overlappingBlocksAtClick.length > 0
        ? this.overlappingBlocksAtClick[0]
        : block;

      this.blockClick.emit({
        block: blockToSelect,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey
      });
    }
  }

  /**
   * Get click position in SVG coordinates
   */
  private getClickPositionInSVG(event: MouseEvent, pageNum: number): { x: number; y: number } | null {
    const target = event.target as SVGElement;
    const svg = target.closest('svg');
    if (!svg) return null;

    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const svgP = pt.matrixTransform(ctm.inverse());

    return { x: svgP.x, y: svgP.y };
  }

  /**
   * Find all blocks that contain the given position on the specified page.
   * Returns blocks sorted by area (smallest first) so more specific blocks are selected first.
   */
  private findBlocksAtPosition(x: number, y: number, pageNum: number): TextBlock[] {
    const allBlocks = this.blocks();
    const pageBlocks = allBlocks.filter(b => b.page === pageNum);

    // Find blocks that contain the click point
    const containingBlocks = pageBlocks.filter(block => {
      const bx = this.getBlockX(block);
      const by = this.getBlockY(block);
      const bw = this.getBlockWidth(block);
      const bh = this.getBlockHeight(block);

      return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
    });

    // Sort by area (smallest first) - more specific/smaller blocks should be selected first
    containingBlocks.sort((a, b) => {
      const areaA = this.getBlockWidth(a) * this.getBlockHeight(a);
      const areaB = this.getBlockWidth(b) * this.getBlockHeight(b);
      return areaA - areaB;
    });

    return containingBlocks;
  }

  /**
   * Handle click on a chapter marker for selection
   */
  onChapterMarkerClick(event: MouseEvent, chapter: Chapter): void {
    // Only handle in chapters mode
    if (!this.chaptersMode()) return;

    event.preventDefault();
    event.stopPropagation();

    // Toggle selection
    if (this.selectedChapterId() === chapter.id) {
      this.selectedChapterId.set(null);
    } else {
      this.selectedChapterId.set(chapter.id);
      this.chapterSelect.emit(chapter.id);
    }
  }

  /**
   * Handle click on chapter marker remove button
   */
  onChapterRemoveClick(event: MouseEvent, chapter: Chapter): void {
    event.preventDefault();
    event.stopPropagation();
    this.chapterDelete.emit(chapter.id);
    if (this.selectedChapterId() === chapter.id) {
      this.selectedChapterId.set(null);
    }
  }

  /**
   * Handle double-click on chapter label to start inline editing
   */
  onChapterLabelDblClick(event: MouseEvent, chapter: Chapter): void {
    event.preventDefault();
    event.stopPropagation();
    this.editingChapterId.set(chapter.id);
    this.editingChapterTitle.set(chapter.title);
    this.chapterEditSaveOnBlur = true;

    // Focus the input after Angular renders it
    setTimeout(() => {
      const input = (this.elementRef.nativeElement as HTMLElement).querySelector('.chapter-inline-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  /**
   * Save inline chapter edit
   */
  saveChapterEdit(chapterId: string): void {
    const newTitle = this.editingChapterTitle().trim();
    const chapter = this.chapters().find(c => c.id === chapterId);
    if (newTitle && chapter && newTitle !== chapter.title) {
      this.chapterRename.emit({ chapterId, newTitle });
    }
    this.cancelChapterEdit();
  }

  /**
   * Cancel inline chapter edit
   */
  cancelChapterEdit(): void {
    this.chapterEditSaveOnBlur = false;
    this.editingChapterId.set(null);
    this.editingChapterTitle.set('');
  }

  /**
   * Handle input event on chapter inline edit
   */
  onChapterEditInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.editingChapterTitle.set(input.value);
  }

  /**
   * Handle blur on chapter inline edit (auto-save)
   */
  onChapterEditBlur(chapterId: string): void {
    setTimeout(() => {
      if (this.chapterEditSaveOnBlur && this.editingChapterId() === chapterId) {
        this.saveChapterEdit(chapterId);
      }
    }, 100);
  }

  /**
   * Handle mousedown on a chapter marker for dragging
   */
  onChapterMarkerMouseDown(event: MouseEvent, chapter: Chapter, pageNum: number): void {
    // Only handle in chapters mode
    if (!this.chaptersMode()) return;

    event.preventDefault();
    event.stopPropagation();

    // Select this chapter
    this.selectedChapterId.set(chapter.id);

    this.draggingChapter = chapter;
    this.draggingChapterPageNum = pageNum;

    // Track if we actually moved (for distinguishing click from drag)
    let hasMoved = false;
    const startX = event.clientX;
    const startY = event.clientY;

    // Add document-level listeners for drag
    const onMouseMove = (e: MouseEvent) => {
      // Only start dragging if moved more than 5 pixels
      if (!hasMoved && (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5)) {
        hasMoved = true;
        this.isDraggingChapter.set(true);
      }
      if (hasMoved) {
        this.onChapterMarkerDrag(e);
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (hasMoved) {
        this.onChapterMarkerDragEnd(e);
      }
      this.isDraggingChapter.set(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }


  /**
   * Handle chapter marker drag
   */
  private onChapterMarkerDrag(event: MouseEvent): void {
    if (!this.isDraggingChapter() || !this.draggingChapter) return;

    // Get SVG coordinates from page
    const pageNum = this.draggingChapterPageNum;
    const pageWrapper = document.querySelector(`[data-page="${pageNum}"]`);
    if (!pageWrapper) return;

    const svg = pageWrapper.querySelector('.block-overlay') as SVGSVGElement;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());

    // Find nearest block for preview/snap
    const nearestBlock = this.findNearestBlock(pageNum, svgP.x, svgP.y);
    const snapY = nearestBlock ? nearestBlock.y : svgP.y;

    // Emit drag event for live preview
    this.chapterDrag.emit({
      chapterId: this.draggingChapter.id,
      pageNum,
      y: snapY,
      snapToBlock: nearestBlock || undefined
    });
  }

  /**
   * Handle chapter marker drag end
   */
  private onChapterMarkerDragEnd(event: MouseEvent): void {
    if (!this.isDraggingChapter() || !this.draggingChapter) {
      this.isDraggingChapter.set(false);
      return;
    }

    // Get final position
    const pageNum = this.draggingChapterPageNum;
    const pageWrapper = document.querySelector(`[data-page="${pageNum}"]`);
    if (pageWrapper) {
      const svg = pageWrapper.querySelector('.block-overlay') as SVGSVGElement;
      if (svg) {
        const pt = svg.createSVGPoint();
        pt.x = event.clientX;
        pt.y = event.clientY;
        const ctm = svg.getScreenCTM();
        if (ctm) {
          const svgP = pt.matrixTransform(ctm.inverse());

          // Find nearest block for final snap
          const nearestBlock = this.findNearestBlock(pageNum, svgP.x, svgP.y);
          const snapY = nearestBlock ? nearestBlock.y : svgP.y;

          // Emit final position
          this.chapterDrag.emit({
            chapterId: this.draggingChapter.id,
            pageNum,
            y: snapY,
            snapToBlock: nearestBlock || undefined
          });
        }
      }
    }

    this.draggingChapter = null;
    this.isDraggingChapter.set(false);
  }

  /**
   * Find a highlight at the click position on the given page.
   * Used for click-through selection when clicking an already-selected block.
   */
  private findHighlightAtClick(event: MouseEvent, pageNum: number): { catId: string; rect: { x: number; y: number; w: number; h: number; text: string } } | null {
    // Get the SVG element from the event target
    const target = event.target as SVGElement;
    const svg = target.closest('svg');
    if (!svg) return null;

    // Convert click position to SVG coordinates
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const svgP = pt.matrixTransform(ctm.inverse());

    // Get highlights for this page and check which one contains the click point
    const highlights = this.getHighlightsForPage(pageNum);
    for (const highlight of highlights) {
      const { x, y, w, h } = highlight.rect;
      if (svgP.x >= x && svgP.x <= x + w && svgP.y >= y && svgP.y <= y + h) {
        return { catId: highlight.catId, rect: highlight.rect };
      }
    }

    return null;
  }

  onBlockDoubleClick(event: MouseEvent, block: TextBlock): void {
    event.preventDefault();
    event.stopPropagation();

    // Use the block from cycling state if available, otherwise find the smallest
    // block at this position. This ensures double-click uses the same block
    // that single-click would select.
    let targetBlock = block;
    if (this.overlappingBlocksAtClick.length > 0) {
      // Use the currently cycled block
      targetBlock = this.overlappingBlocksAtClick[this.cycleIndex];
    } else {
      // No cycling state - find overlapping blocks now
      const clickPos = this.getClickPositionInSVG(event, block.page);
      if (clickPos) {
        const overlapping = this.findBlocksAtPosition(clickPos.x, clickPos.y, block.page);
        if (overlapping.length > 0) {
          targetBlock = overlapping[0]; // Smallest block
        }
      }
    }

    // Get screen coordinates of the block for inline editing
    const target = event.target as SVGRectElement;
    const rect = target.getBoundingClientRect();

    this.blockDoubleClick.emit({
      block: targetBlock,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      screenX: rect.left,
      screenY: rect.top,
      screenWidth: rect.width,
      screenHeight: rect.height
    });
  }

  onContextMenu(event: MouseEvent, block: TextBlock): void {
    event.preventDefault();
    event.stopPropagation();
    // Close any existing menu first
    this.closeAllContextMenus();
    // Open block context menu
    this.contextMenuX.set(Math.min(event.clientX, window.innerWidth - 320));
    this.contextMenuY.set(Math.min(event.clientY, window.innerHeight - 200));
    this.contextMenuBlock.set(block);
    this.blockHover.emit(block);
  }

  onBlockEnter(_event: MouseEvent, block: TextBlock): void {
    this.blockHover.emit(block);
  }

  onBlockLeave(): void {
    this.blockHover.emit(null);
  }

  // Keep menu open when mouse enters it
  keepTooltip(): void {
    // No-op now - menu stays open until click outside
  }

  // Called on mouseleave from menu - no longer auto-hides
  hideTooltip(): void {
    // No-op now - menu stays open until click outside
  }

  closeAllContextMenus(): void {
    this.contextMenuBlock.set(null);
    this.pageMenuVisible.set(false);
    this.blockHover.emit(null);
  }

  openFilePicker(): void {
    // Parent will handle this via file picker component
  }

  onDeleteBlock(): void {
    const block = this.contextMenuBlock();
    if (block) {
      this.deleteBlock.emit(block.id);
      this.closeAllContextMenus();
    }
  }

  onSelectLikeThis(): void {
    const block = this.contextMenuBlock();
    if (block) {
      this.selectLikeThis.emit(block);
      this.closeAllContextMenus();
    }
  }

  onDeleteLikeThis(): void {
    const block = this.contextMenuBlock();
    if (block) {
      this.deleteLikeThis.emit(block);
      this.closeAllContextMenus();
    }
  }

  onRevertBlock(): void {
    const block = this.contextMenuBlock();
    if (block) {
      this.revertBlock.emit(block.id);
      this.closeAllContextMenus();
    }
  }

  // Zoom sensitivity - higher = faster zoom per scroll
  private readonly ZOOM_SENSITIVITY = 0.15; // 15% of deltaY converted to zoom change

  onWheel(event: WheelEvent): void {
    // Cmd/Ctrl + scroll for zoom
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();

      if (!this.viewport?.nativeElement) return;

      const vp = this.viewport.nativeElement;
      const rect = vp.getBoundingClientRect();

      // Cursor position relative to viewport
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;

      // Store scroll position info for adjustment after zoom
      this.previousZoom = this.zoom();
      this.pendingZoomAdjustment = {
        scrollRatioX: vp.scrollLeft / (vp.scrollWidth - vp.clientWidth || 1),
        scrollRatioY: vp.scrollTop / (vp.scrollHeight - vp.clientHeight || 1),
        cursorX,
        cursorY
      };

      // Calculate zoom delta based on scroll amount
      // deltaY is typically ~100 per "notch" on a mouse wheel, less for trackpad
      // Negative deltaY = scroll up = zoom in, positive = scroll down = zoom out
      const zoomDelta = -event.deltaY * this.ZOOM_SENSITIVITY;

      // Emit the zoom delta to parent
      this.zoomChange.emit(zoomDelta);
    }
  }

  // Page context menu handlers
  onPageContextMenu(event: MouseEvent, pageNum: number): void {
    event.preventDefault();
    event.stopPropagation();
    // Close any existing menu first
    this.closeAllContextMenus();
    // Open page context menu
    this.pageMenuX.set(Math.min(event.clientX, window.innerWidth - 200));
    this.pageMenuY.set(Math.min(event.clientY, window.innerHeight - 100));
    this.pageMenuPageNum.set(pageNum);
    this.pageMenuVisible.set(true);
  }

  closePageMenu(): void {
    this.pageMenuVisible.set(false);
  }

  // Page drag/drop for edit/select mode
  onPageDragStart(event: DragEvent, index: number, pageNum: number): void {
    if (this.editorMode() !== 'select' && this.editorMode() !== 'edit') {
      event.preventDefault();
      return;
    }
    this.draggedPageIndex = index;
    this.isDraggingPage.set(true);

    // Set drag data
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(pageNum));
    }
  }

  onPageDragEnd(_event: DragEvent): void {
    this.draggedPageIndex = null;
    this.dropTargetIndex = null;
    this.isDraggingPage.set(false);
    this.dragOverIndex.set(null);
  }

  onPageDragOver(event: DragEvent, index: number): void {
    if ((this.editorMode() !== 'select' && this.editorMode() !== 'edit') || this.draggedPageIndex === null) return;

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }

    this.dragOverIndex.set(index);

    // Determine if dropping before or after this element
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    if (event.clientX < midpoint) {
      this.dropTargetIndex = index;
    } else {
      this.dropTargetIndex = index + 1;
    }
  }

  onPageDragLeave(event: DragEvent): void {
    // Only clear if leaving the container, not when entering a child
    const relatedTarget = event.relatedTarget as HTMLElement;
    if (!relatedTarget || !relatedTarget.closest('.page-wrapper')) {
      this.dragOverIndex.set(null);
    }
  }

  onPageDrop(event: DragEvent, _targetIndex: number): void {
    event.preventDefault();

    if (this.draggedPageIndex === null || this.dropTargetIndex === null) return;
    if (this.draggedPageIndex === this.dropTargetIndex || this.draggedPageIndex === this.dropTargetIndex - 1) {
      // No change needed
      this.onPageDragEnd(event);
      return;
    }

    // Get current order
    const currentOrder = this.pageOrder().length > 0
      ? [...this.pageOrder()]
      : Array.from({ length: this.totalPages() }, (_, i) => i);

    // Remove the dragged page
    const [movedPage] = currentOrder.splice(this.draggedPageIndex, 1);

    // Calculate new insert position (adjust if dragging forward)
    let insertAt = this.dropTargetIndex;
    if (this.draggedPageIndex < this.dropTargetIndex) {
      insertAt--;
    }

    // Insert at new position
    currentOrder.splice(insertAt, 0, movedPage);

    // Emit new order
    this.pageReorder.emit(currentOrder);

    this.onPageDragEnd(event);
  }

  onSelectAllOnPage(): void {
    this.selectAllOnPage.emit(this.pageMenuPageNum());
    this.closePageMenu();
  }

  onDeselectAllOnPage(): void {
    this.deselectAllOnPage.emit(this.pageMenuPageNum());
    this.closePageMenu();
  }

  // Page selection helpers
  isPageSelected(pageNum: number): boolean {
    return this.selectedPages().has(pageNum);
  }

  onPageClick(event: MouseEvent, pageNum: number): void {
    // Only handle page selection in organize or chapters mode
    if (!this.organizeMode() && !this.chaptersMode()) {
      return;
    }

    // Don't handle if clicking on buttons or other interactive elements
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('.block-rect')) {
      return;
    }

    // Don't handle page selection if clicking on page content (image/svg overlay)
    // Page selection should only happen when clicking outside the page content area
    if (target.closest('.page-content')) {
      return;
    }

    // Emit page selection event with modifier keys
    this.pageSelect.emit({
      pageNum,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey
    });

    // Track last selected page for shift-click range selection
    if (!event.shiftKey) {
      this.lastSelectedPage = pageNum;
    }
  }

  onSelectPage(pageNum: number): void {
    this.pageSelect.emit({ pageNum, shiftKey: false, metaKey: false, ctrlKey: false });
    this.lastSelectedPage = pageNum;
    this.closePageMenu();
  }

  onDeselectPage(pageNum: number): void {
    // Emit with ctrl/meta to toggle off
    this.pageSelect.emit({ pageNum, shiftKey: false, metaKey: true, ctrlKey: false });
    this.closePageMenu();
  }

  onDeleteSelectedPages(): void {
    const selected = this.selectedPages();
    if (selected.size > 0) {
      this.deleteSelectedPages.emit(new Set(selected));
    }
    this.closePageMenu();
  }

  onClearPageSelection(): void {
    // Emit empty set to clear selection
    this.deleteSelectedPages.emit(new Set()); // Parent will interpret empty set as clear
    this.closePageMenu();
  }

  onDeleteSinglePage(pageNum: number): void {
    this.pageDeleteToggle.emit(pageNum);
    this.closePageMenu();
  }

  onRestoreSinglePage(pageNum: number): void {
    this.pageDeleteToggle.emit(pageNum);
    this.closePageMenu();
  }

  // Page marquee selection handlers (for organize/chapters mode)
  onPageMarqueeStart(event: MouseEvent): void {
    // Only in organize or chapters mode
    if (!this.organizeMode() && !this.chaptersMode()) return;

    // Only start marquee on left click
    if (event.button !== 0) return;

    // Only start on empty space (pdf-container, not on page-wrapper or its children)
    const target = event.target as HTMLElement;
    const isOnPage = target.closest('.page-wrapper');
    if (isOnPage) return;

    // Get position relative to the container
    const container = target.closest('.pdf-container') || target;
    const rect = container.getBoundingClientRect();
    const scrollContainer = container.closest('.pdf-viewport') as HTMLElement;
    const scrollLeft = scrollContainer?.scrollLeft || 0;
    const scrollTop = scrollContainer?.scrollTop || 0;
    const x = event.clientX - rect.left + scrollLeft;
    const y = event.clientY - rect.top + scrollTop;

    this.pageMarqueeStart.set({ x, y });
    this.pageMarqueeEnd.set({ x, y });
    this.pageMarqueeActive.set(true);

    // Clear selection unless holding shift/cmd/ctrl
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
      this.deleteSelectedPages.emit(new Set()); // Empty set = clear selection
    }

    event.preventDefault();
  }

  onPageMarqueeMove(event: MouseEvent): void {
    if (!this.pageMarqueeActive()) return;

    const container = this.elementRef.nativeElement.querySelector('.pdf-container');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const scrollContainer = container.closest('.pdf-viewport') as HTMLElement;
    const scrollLeft = scrollContainer?.scrollLeft || 0;
    const scrollTop = scrollContainer?.scrollTop || 0;
    const x = event.clientX - rect.left + scrollLeft;
    const y = event.clientY - rect.top + scrollTop;

    this.pageMarqueeEnd.set({ x, y });

    // Select pages that intersect with marquee
    this.selectPagesInMarquee();
  }

  onPageMarqueeEnd(): void {
    if (!this.pageMarqueeActive()) return;
    this.pageMarqueeActive.set(false);
  }

  private selectPagesInMarquee(): void {
    const marquee = this.pageMarqueeRect();
    const container = this.elementRef.nativeElement.querySelector('.pdf-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollContainer = container.closest('.pdf-viewport') as HTMLElement;
    const scrollLeft = scrollContainer?.scrollLeft || 0;
    const scrollTop = scrollContainer?.scrollTop || 0;

    const pageWrappers = container.querySelectorAll('.page-wrapper');
    const selectedPageNums = new Set<number>();

    pageWrappers.forEach((wrapper: Element) => {
      const pageNum = parseInt(wrapper.getAttribute('data-page') || '-1', 10);
      if (pageNum < 0) return;

      const wrapperRect = wrapper.getBoundingClientRect();
      // Convert wrapper rect to container-relative coordinates (accounting for scroll)
      const wrapperLeft = wrapperRect.left - containerRect.left + scrollLeft;
      const wrapperTop = wrapperRect.top - containerRect.top + scrollTop;
      const wrapperRight = wrapperLeft + wrapperRect.width;
      const wrapperBottom = wrapperTop + wrapperRect.height;

      // Check if wrapper intersects with marquee
      const intersects =
        wrapperLeft < marquee.left + marquee.width &&
        wrapperRight > marquee.left &&
        wrapperTop < marquee.top + marquee.height &&
        wrapperBottom > marquee.top;

      if (intersects) {
        selectedPageNums.add(pageNum);
      }
    });

    // Emit selection - parent will update selectedPages
    // We emit each page as a "meta" click to add to selection
    for (const pageNum of selectedPageNums) {
      if (!this.selectedPages().has(pageNum)) {
        this.pageSelect.emit({ pageNum, shiftKey: false, metaKey: true, ctrlKey: false });
      }
    }
  }

  // Handle scroll events for virtual scrolling (throttled for performance)
  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    const now = Date.now();

    // Throttle scroll updates to max 60fps (16ms) to avoid excessive recalculations
    if (now - this.lastScrollTime < 16) {
      // Schedule an update for later if not already scheduled
      if (!this.scrollThrottleTimer) {
        this.scrollThrottleTimer = setTimeout(() => {
          this.scrollThrottleTimer = null;
          this.updateScrollState(target);
        }, 16);
      }
      return;
    }

    this.lastScrollTime = now;
    this.updateScrollState(target);
  }

  private updateScrollState(target: HTMLElement): void {
    this.scrollTop.set(target.scrollTop);

    // Also update viewport height if it changed
    if (target.clientHeight !== this.viewportHeight()) {
      this.viewportHeight.set(target.clientHeight);
    }
  }

  // Initialize viewport tracking
  initViewport(): void {
    if (this.viewport?.nativeElement) {
      const vp = this.viewport.nativeElement;
      this.viewportHeight.set(vp.clientHeight);
      this.scrollTop.set(vp.scrollTop);
    }
  }

  // Public method to scroll to a specific page
  scrollToPage(pageNum: number): void {
    if (!this.viewport?.nativeElement) return;

    // For virtual scroll mode, calculate the offset and scroll there
    if (this.layout() !== 'grid' && this.editorMode() !== 'select' && this.editorMode() !== 'edit') {
      const offset = this.getPageOffset(pageNum);
      this.viewport.nativeElement.scrollTop = offset;
      return;
    }

    const vp = this.viewport.nativeElement;
    const pageWrapper = vp.querySelector(`.page-wrapper[data-page="${pageNum}"]`);

    if (pageWrapper) {
      pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Search highlight methods
  clearSearchHighlights(): void {
    this.searchHighlightIds.set(new Set());
    this.currentSearchResultId.set(null);
  }

  highlightSearchResults(blockIds: string[], currentBlockId?: string): void {
    this.searchHighlightIds.set(new Set(blockIds));
    if (currentBlockId) {
      this.currentSearchResultId.set(currentBlockId);
    }
  }

  highlightCurrentSearchResult(blockId: string): void {
    this.currentSearchResultId.set(blockId);
  }

  isSearchHighlighted(blockId: string): boolean {
    return this.searchHighlightIds().has(blockId);
  }

  isCurrentSearchResult(blockId: string): boolean {
    return this.currentSearchResultId() === blockId;
  }

  // Unified overlay mouse handlers (for crop, marquee selection, and sample mode)
  onOverlayMouseDown(event: MouseEvent, pageNum: number): void {
    // Check if clicking on a block (block rects have their own handlers)
    const target = event.target as Element;
    if (target.classList.contains('block-rect')) {
      return; // Let block handler take over
    }

    // In chapters mode, clicking on empty space places a chapter marker
    if (this.chaptersMode()) {
      event.preventDefault();
      event.stopPropagation();

      const coords = this.getSvgCoordinates(event, pageNum);
      if (!coords) return;

      // Find the nearest block to snap to
      const nearestBlock = this.findNearestBlock(pageNum, coords.x, coords.y);
      const level = event.shiftKey ? 2 : 1;

      if (nearestBlock) {
        // Snap to the nearest block
        this.chapterClick.emit({ block: nearestBlock, level });
      } else {
        // No blocks on page - emit with a synthetic block at click position
        this.chapterPlacement.emit({ pageNum, y: coords.y, level });
      }
      return;
    }

    event.preventDefault();

    const coords = this.getSvgCoordinates(event, pageNum);
    if (!coords) return;

    if (this.sampleMode()) {
      // Sample mode - emit event for parent to handle
      this.sampleMouseDown.emit({ event, page: pageNum, pageX: coords.x, pageY: coords.y });
    } else if (this.cropMode()) {
      // Crop mode
      this.isDrawingCrop.set(true);
      this.cropStartPoint.set({ x: coords.x, y: coords.y, pageNum });
      this.currentCropRect.set({
        x: coords.x,
        y: coords.y,
        width: 0,
        height: 0,
        pageNum
      });
    } else {
      // Marquee selection mode
      this.isMarqueeSelecting.set(true);
      this.marqueeStartPoint.set({ x: coords.x, y: coords.y, pageNum });
      this.currentMarqueeRect.set({
        x: coords.x,
        y: coords.y,
        width: 0,
        height: 0,
        pageNum
      });

      // Add document-level listeners for auto-scroll when mouse goes outside viewport
      this.startMarqueeAutoScroll(event.clientY);
    }
  }

  onOverlayMouseMove(event: MouseEvent, pageNum: number): void {
    if (this.sampleMode()) {
      // Sample mode - emit event for parent to handle
      const coords = this.getSvgCoordinates(event, pageNum);
      if (coords) {
        this.sampleMouseMove.emit({ pageX: coords.x, pageY: coords.y });
      }
    } else if (this.cropMode()) {
      // Crop drag/resize takes priority
      if (this.isDraggingCrop()) {
        this.handleCropDrag(event, pageNum);
        return;
      }

      // Crop drawing mode
      if (!this.isDrawingCrop()) return;

      const start = this.cropStartPoint();
      if (!start || start.pageNum !== pageNum) return;

      const coords = this.getSvgCoordinates(event, pageNum);
      if (!coords) return;

      const x = Math.min(start.x, coords.x);
      const y = Math.min(start.y, coords.y);
      const width = Math.abs(coords.x - start.x);
      const height = Math.abs(coords.y - start.y);

      this.currentCropRect.set({ x, y, width, height, pageNum });
    } else {
      // Marquee selection mode
      if (!this.isMarqueeSelecting()) return;

      // Track mouse position for auto-scroll
      this.lastMouseClientY = event.clientY;

      const start = this.marqueeStartPoint();
      if (!start || start.pageNum !== pageNum) return;

      const coords = this.getSvgCoordinates(event, pageNum);
      if (!coords) return;

      const x = Math.min(start.x, coords.x);
      const y = Math.min(start.y, coords.y);
      const width = Math.abs(coords.x - start.x);
      const height = Math.abs(coords.y - start.y);

      this.currentMarqueeRect.set({ x, y, width, height, pageNum });
    }
  }

  onOverlayMouseUp(event: MouseEvent, _pageNum: number): void {
    if (this.sampleMode()) {
      // Sample mode - emit event for parent to handle
      this.sampleMouseUp.emit();
    } else if (this.cropMode()) {
      // End crop drag/resize
      if (this.isDraggingCrop()) {
        this.endCropDrag();
        return;
      }

      // End crop drawing
      if (!this.isDrawingCrop()) return;

      const cropRect = this.currentCropRect();
      if (cropRect && cropRect.width > 10 && cropRect.height > 10) {
        this.cropComplete.emit(cropRect);
      }

      this.isDrawingCrop.set(false);
    } else {
      // Marquee selection mode
      if (!this.isMarqueeSelecting()) return;

      // Stop auto-scroll
      this.stopMarqueeAutoScroll();

      const marqueeRect = this.currentMarqueeRect();
      if (marqueeRect && marqueeRect.width > 5 && marqueeRect.height > 5) {
        // Find all blocks that intersect with the marquee
        const selectedIds = this.findBlocksInRect(marqueeRect);
        if (selectedIds.length > 0) {
          const additive = event.shiftKey || event.metaKey || event.ctrlKey;
          this.marqueeSelect.emit({ blockIds: selectedIds, additive });
        }
      }

      this.isMarqueeSelecting.set(false);
      this.currentMarqueeRect.set(null);
    }
  }

  onOverlayMouseLeave(): void {
    // Don't cancel if actively drawing - user might come back
  }

  // Auto-scroll methods for marquee selection
  private startMarqueeAutoScroll(initialClientY: number): void {
    this.lastMouseClientY = initialClientY;

    // Create bound event handlers so we can remove them later
    this.boundDocumentMouseMove = (e: MouseEvent) => this.onDocumentMouseMoveForMarquee(e);
    this.boundDocumentMouseUp = (e: MouseEvent) => this.onDocumentMouseUpForMarquee(e);

    document.addEventListener('mousemove', this.boundDocumentMouseMove);
    document.addEventListener('mouseup', this.boundDocumentMouseUp);

    // Start the auto-scroll interval
    this.autoScrollInterval = setInterval(() => this.performAutoScroll(), 16); // ~60fps
  }

  private stopMarqueeAutoScroll(): void {
    // Remove document listeners
    if (this.boundDocumentMouseMove) {
      document.removeEventListener('mousemove', this.boundDocumentMouseMove);
      this.boundDocumentMouseMove = null;
    }
    if (this.boundDocumentMouseUp) {
      document.removeEventListener('mouseup', this.boundDocumentMouseUp);
      this.boundDocumentMouseUp = null;
    }

    // Stop auto-scroll interval
    if (this.autoScrollInterval) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
  }

  private onDocumentMouseMoveForMarquee(event: MouseEvent): void {
    this.lastMouseClientY = event.clientY;

    // Also update the marquee rect if we have a valid start point
    // This handles the case where mouse is outside any page SVG
    if (!this.isMarqueeSelecting()) return;

    const start = this.marqueeStartPoint();
    if (!start) return;

    // Find the page wrapper for the marquee's page to get coordinates
    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;

    const pageWrapper = scrollContainer.querySelector(`.page-wrapper[data-page="${start.pageNum}"]`);
    if (!pageWrapper) return;

    const svg = pageWrapper.querySelector('svg.block-overlay');
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const dims = this.pageDimensions()[start.pageNum];
    if (!dims) return;

    // Convert screen coordinates to SVG viewBox coordinates
    const scaleX = dims.width / rect.width;
    const scaleY = dims.height / rect.height;

    // Calculate coords even if outside the SVG bounds
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    // Clamp to page bounds (0 to page dimensions)
    const clampedX = Math.max(0, Math.min(dims.width, x));
    const clampedY = Math.max(0, Math.min(dims.height, y));

    const marqueeX = Math.min(start.x, clampedX);
    const marqueeY = Math.min(start.y, clampedY);
    const width = Math.abs(clampedX - start.x);
    const height = Math.abs(clampedY - start.y);

    this.currentMarqueeRect.set({ x: marqueeX, y: marqueeY, width, height, pageNum: start.pageNum });
  }

  private onDocumentMouseUpForMarquee(event: MouseEvent): void {
    // Stop auto-scroll
    this.stopMarqueeAutoScroll();

    // Complete the marquee selection if we have a valid rect
    if (!this.isMarqueeSelecting()) return;

    const marqueeRect = this.currentMarqueeRect();
    if (marqueeRect && marqueeRect.width > 5 && marqueeRect.height > 5) {
      const selectedIds = this.findBlocksInRect(marqueeRect);
      if (selectedIds.length > 0) {
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        this.marqueeSelect.emit({ blockIds: selectedIds, additive });
      }
    }

    this.isMarqueeSelecting.set(false);
    this.currentMarqueeRect.set(null);
  }

  private performAutoScroll(): void {
    if (!this.isMarqueeSelecting()) return;

    const scrollContainer = this.getScrollContainer();
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const mouseY = this.lastMouseClientY;

    // Check if mouse is near top or bottom edge
    const distanceFromTop = mouseY - containerRect.top;
    const distanceFromBottom = containerRect.bottom - mouseY;

    let scrollDelta = 0;

    if (distanceFromTop < this.AUTO_SCROLL_EDGE_THRESHOLD && distanceFromTop < distanceFromBottom) {
      // Near top edge - scroll up
      // Scroll faster the closer to the edge
      const intensity = 1 - (distanceFromTop / this.AUTO_SCROLL_EDGE_THRESHOLD);
      scrollDelta = -this.AUTO_SCROLL_SPEED * intensity;
    } else if (distanceFromBottom < this.AUTO_SCROLL_EDGE_THRESHOLD && distanceFromBottom < distanceFromTop) {
      // Near bottom edge - scroll down
      const intensity = 1 - (distanceFromBottom / this.AUTO_SCROLL_EDGE_THRESHOLD);
      scrollDelta = this.AUTO_SCROLL_SPEED * intensity;
    }

    if (scrollDelta !== 0) {
      scrollContainer.scrollTop += scrollDelta;

      // After scrolling, update the marquee rect to reflect new visible area
      // This is already handled by onDocumentMouseMoveForMarquee on the next mouse event
    }
  }

  private getScrollContainer(): HTMLElement | null {
    // Try to get the viewport element (regular scroll container)
    if (this.viewport?.nativeElement) {
      return this.viewport.nativeElement;
    }
    // Try CDK virtual scroll viewport
    if (this.cdkViewport?.elementRef?.nativeElement) {
      return this.cdkViewport.elementRef.nativeElement;
    }
    // Fallback: find .pdf-viewport in the component
    return this.elementRef.nativeElement.querySelector('.pdf-viewport');
  }

  // Find all blocks that intersect with a rectangle
  private findBlocksInRect(rect: CropRect): string[] {
    const pageBlocks = this.getPageBlocks(rect.pageNum);
    const deleted = this.deletedBlockIds();

    return pageBlocks
      .filter(block => {
        if (deleted.has(block.id)) return false;

        // Check if block intersects with rect
        const blockRight = block.x + block.width;
        const blockBottom = block.y + block.height;
        const rectRight = rect.x + rect.width;
        const rectBottom = rect.y + rect.height;

        // Two rectangles intersect if they overlap on both axes
        const xOverlap = block.x < rectRight && blockRight > rect.x;
        const yOverlap = block.y < rectBottom && blockBottom > rect.y;

        return xOverlap && yOverlap;
      })
      .map(block => block.id);
  }

  /**
   * Find the nearest text block to a click position.
   * Returns the block whose top edge is closest to the click Y position,
   * or null if there are no blocks on the page.
   */
  private findNearestBlock(pageNum: number, clickX: number, clickY: number): TextBlock | null {
    const pageBlocks = this.getPageBlocks(pageNum);
    const deleted = this.deletedBlockIds();

    // Filter out deleted blocks and image blocks
    const textBlocks = pageBlocks.filter(b => !deleted.has(b.id) && !b.is_image);

    if (textBlocks.length === 0) return null;

    // Find block with closest Y position to click
    // Prefer blocks that contain the click point, then blocks closest vertically
    let bestBlock: TextBlock | null = null;
    let bestDistance = Infinity;

    for (const block of textBlocks) {
      // Check if click is inside this block
      const isInside = clickX >= block.x && clickX <= block.x + block.width &&
                       clickY >= block.y && clickY <= block.y + block.height;

      if (isInside) {
        // Click is inside this block - this is the best match
        return block;
      }

      // Calculate vertical distance from click to block top
      const distToTop = Math.abs(clickY - block.y);
      // Also consider distance to block bottom for clicks below the block
      const distToBottom = Math.abs(clickY - (block.y + block.height));
      const verticalDist = Math.min(distToTop, distToBottom);

      if (verticalDist < bestDistance) {
        bestDistance = verticalDist;
        bestBlock = block;
      }
    }

    return bestBlock;
  }

  private getSvgCoordinates(event: MouseEvent, pageNum: number): { x: number; y: number } | null {
    const svg = (event.target as Element).closest('svg');
    if (!svg) return null;

    const rect = svg.getBoundingClientRect();
    const dims = this.pageDimensions()[pageNum];
    if (!dims) return null;

    // Convert screen coordinates to SVG viewBox coordinates
    const scaleX = dims.width / rect.width;
    const scaleY = dims.height / rect.height;

    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    return { x, y };
  }

  // Clear crop rectangle (called from parent)
  clearCrop(): void {
    this.currentCropRect.set(null);
    this.cropStartPoint.set(null);
    this.isDrawingCrop.set(false);
    this.isDraggingCrop.set(false);
    this.cropDragType.set(null);
    this.cropDragStart.set(null);
  }

  // Generate SVG path for crop mask (outer rect with inner cutout)
  getCropMaskPath(pageNum: number): string {
    const dims = this.pageDimensions()[pageNum];
    const crop = this.currentCropRect();
    if (!dims || !crop) return '';

    // Outer rectangle (full page) - clockwise
    const outer = `M 0 0 L ${dims.width} 0 L ${dims.width} ${dims.height} L 0 ${dims.height} Z`;

    // Inner rectangle (crop area) - counter-clockwise for cutout
    const inner = `M ${crop.x} ${crop.y} L ${crop.x} ${crop.y + crop.height} L ${crop.x + crop.width} ${crop.y + crop.height} L ${crop.x + crop.width} ${crop.y} Z`;

    return outer + ' ' + inner;
  }

  // Start dragging/resizing crop rectangle
  onCropDragStart(event: MouseEvent, type: string): void {
    event.preventDefault();
    event.stopPropagation();

    const rect = this.currentCropRect();
    if (!rect) return;

    const coords = this.getSvgCoordinates(event, rect.pageNum);
    if (!coords) return;

    this.isDraggingCrop.set(true);
    this.cropDragType.set(type);
    this.cropDragStart.set({
      x: coords.x,
      y: coords.y,
      rect: { ...rect }
    });
  }

  // Handle crop drag/resize during mouse move
  private handleCropDrag(event: MouseEvent, pageNum: number): void {
    const dragStart = this.cropDragStart();
    const dragType = this.cropDragType();
    if (!dragStart || !dragType) return;

    const coords = this.getSvgCoordinates(event, pageNum);
    if (!coords) return;

    const dx = coords.x - dragStart.x;
    const dy = coords.y - dragStart.y;
    const orig = dragStart.rect;
    const dims = this.pageDimensions()[pageNum];

    let x = orig.x;
    let y = orig.y;
    let width = orig.width;
    let height = orig.height;

    // Apply changes based on drag type
    switch (dragType) {
      case 'move':
        x = orig.x + dx;
        y = orig.y + dy;
        break;
      case 'nw':
        x = orig.x + dx;
        y = orig.y + dy;
        width = orig.width - dx;
        height = orig.height - dy;
        break;
      case 'n':
        y = orig.y + dy;
        height = orig.height - dy;
        break;
      case 'ne':
        y = orig.y + dy;
        width = orig.width + dx;
        height = orig.height - dy;
        break;
      case 'e':
        width = orig.width + dx;
        break;
      case 'se':
        width = orig.width + dx;
        height = orig.height + dy;
        break;
      case 's':
        height = orig.height + dy;
        break;
      case 'sw':
        x = orig.x + dx;
        width = orig.width - dx;
        height = orig.height + dy;
        break;
      case 'w':
        x = orig.x + dx;
        width = orig.width - dx;
        break;
    }

    // Ensure minimum size
    const minSize = 20;
    if (width < minSize) {
      if (dragType.includes('w')) x = orig.x + orig.width - minSize;
      width = minSize;
    }
    if (height < minSize) {
      if (dragType.includes('n')) y = orig.y + orig.height - minSize;
      height = minSize;
    }

    // Constrain to page bounds
    if (dims) {
      x = Math.max(0, Math.min(x, dims.width - width));
      y = Math.max(0, Math.min(y, dims.height - height));
      width = Math.min(width, dims.width - x);
      height = Math.min(height, dims.height - y);
    }

    this.currentCropRect.set({ x, y, width, height, pageNum });
  }

  // End crop drag/resize
  private endCropDrag(): void {
    if (this.isDraggingCrop()) {
      const rect = this.currentCropRect();
      if (rect && rect.width > 10 && rect.height > 10) {
        this.cropComplete.emit(rect);
      }
    }
    this.isDraggingCrop.set(false);
    this.cropDragType.set(null);
    this.cropDragStart.set(null);
  }

  // ===========================================================================
  // SPLIT MODE - Page splitting for scanned book spreads
  // ===========================================================================

  // Split drag state
  private readonly isDraggingSplit = signal(false);
  private readonly splitDragPageNum = signal<number | null>(null);
  private readonly splitDragStartX = signal<number | null>(null);

  // Get split line X position for a page
  getSplitLineX(pageNum: number): number {
    const fn = this.splitPositionFn();
    if (!fn) return 0;

    const dims = this.pageDimensions()[pageNum];
    if (!dims) return 0;

    const position = fn(pageNum); // 0-1 percentage
    return dims.width * position;
  }

  // Get page dimensions helper
  getPageDimensions(pageNum: number): PageDimension | null {
    return this.pageDimensions()[pageNum] || null;
  }

  // Get the left half page number after split
  getSplitLeftPageNum(pageNum: number): string {
    // Reading order: left-to-right means left side comes first
    // For page 0: left = page 1, right = page 2
    // For page 1: left = page 3, right = page 4
    const baseNum = pageNum * 2 + 1;
    return `P${baseNum}`;
  }

  // Get the right half page number after split
  getSplitRightPageNum(pageNum: number): string {
    const baseNum = pageNum * 2 + 2;
    return `P${baseNum}`;
  }

  // Check if page is skipped (not split)
  isPageSkipped(pageNum: number): boolean {
    return this.skippedPages().has(pageNum);
  }

  // Toggle whether a page should be split
  togglePageSplit(event: Event, pageNum: number): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.splitPageToggle.emit({ pageNum, enabled: checked });
  }

  // Start dragging split line
  onSplitDragStart(event: MouseEvent, pageNum: number): void {
    event.preventDefault();
    event.stopPropagation();

    this.isDraggingSplit.set(true);
    this.splitDragPageNum.set(pageNum);

    const coords = this.getSvgCoordinates(event, pageNum);
    if (coords) {
      this.splitDragStartX.set(coords.x);
    }

    // Add document-level listeners for drag
    document.addEventListener('mousemove', this.onSplitDragMove);
    document.addEventListener('mouseup', this.onSplitDragEnd);
  }

  // Handle split line drag
  private onSplitDragMove = (event: MouseEvent): void => {
    if (!this.isDraggingSplit()) return;

    const pageNum = this.splitDragPageNum();
    if (pageNum === null) return;

    const dims = this.pageDimensions()[pageNum];
    if (!dims) return;

    // Get the page wrapper element
    const pageWrapper = document.querySelector(`[data-page="${pageNum}"]`);
    if (!pageWrapper) return;

    const svg = pageWrapper.querySelector('.block-overlay') as SVGSVGElement;
    if (!svg) return;

    // Convert mouse position to SVG coordinates
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    // Calculate new position as percentage
    const newPosition = Math.max(0.1, Math.min(0.9, svgP.x / dims.width));

    // Emit the change
    this.splitPositionChange.emit({ pageNum, position: newPosition });
  };

  // End split line drag
  private onSplitDragEnd = (): void => {
    this.isDraggingSplit.set(false);
    this.splitDragPageNum.set(null);
    this.splitDragStartX.set(null);

    document.removeEventListener('mousemove', this.onSplitDragMove);
    document.removeEventListener('mouseup', this.onSplitDragEnd);
  };

  // ===========================================================================
  // BLOCK DRAG - Drag text blocks to reposition them (edit mode)
  // ===========================================================================

  // Start dragging a block
  onBlockMouseDown(event: MouseEvent, block: TextBlock): void {
    // Only allow dragging in edit mode
    if (this.editorMode() !== 'edit') return;

    event.preventDefault();
    event.stopPropagation();

    // Get SVG coordinates
    const coords = this.getSvgCoordinates(event, block.page);
    if (!coords) return;

    // Get current block position (including any existing offset)
    const currentOffset = this.blockOffsets().get(block.id);
    const blockX = block.x + (currentOffset?.offsetX ?? 0);
    const blockY = block.y + (currentOffset?.offsetY ?? 0);

    // Store drag start state
    this.draggingBlock = block;
    this.dragStartX = coords.x;
    this.dragStartY = coords.y;
    this.dragStartBlockX = blockX;
    this.dragStartBlockY = blockY;
    this.isDraggingBlock.set(true);

    // Add document-level listeners for drag
    document.addEventListener('mousemove', this.onBlockDragMove);
    document.addEventListener('mouseup', this.onBlockDragEnd);
  }

  // Handle block drag movement
  private onBlockDragMove = (event: MouseEvent): void => {
    if (!this.isDraggingBlock() || !this.draggingBlock) return;

    const block = this.draggingBlock;
    const dims = this.pageDimensions()[block.page];
    if (!dims) return;

    // Get the page wrapper element
    const pageWrapper = document.querySelector(`[data-page="${block.page}"]`);
    if (!pageWrapper) return;

    const svg = pageWrapper.querySelector('.block-overlay') as SVGSVGElement;
    if (!svg) return;

    // Convert mouse position to SVG coordinates
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());

    // Calculate delta from start
    const deltaX = svgP.x - this.dragStartX;
    const deltaY = svgP.y - this.dragStartY;

    // Calculate new position
    let newX = this.dragStartBlockX + deltaX;
    let newY = this.dragStartBlockY + deltaY;

    // Constrain to page bounds
    newX = Math.max(0, Math.min(newX, dims.width - block.width));
    newY = Math.max(0, Math.min(newY, dims.height - block.height));

    // Calculate offset from original position
    const offsetX = newX - block.x;
    const offsetY = newY - block.y;

    // Emit the position change
    this.blockMoved.emit({ blockId: block.id, offsetX, offsetY });
  };

  // End block drag
  private onBlockDragEnd = (): void => {
    // Emit drag end event before clearing state
    if (this.draggingBlock) {
      this.blockDragEnd.emit({
        blockId: this.draggingBlock.id,
        pageNum: this.draggingBlock.page
      });
    }

    this.draggingBlock = null;
    this.isDraggingBlock.set(false);

    document.removeEventListener('mousemove', this.onBlockDragMove);
    document.removeEventListener('mouseup', this.onBlockDragEnd);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT: Render page with text overlays composited onto canvas
  // This is the WYSIWYG export method - what you see is what you get
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render a single page with all text overlays composited onto a canvas.
   * For export, deleted content is removed (white) without X marks.
   *
   * @param pageNum - Page number (0-indexed)
   * @param scale - Render scale (default 2.0 for good quality)
   * @returns Promise<string> - Data URL of the rendered page image
   */
  async renderPageForExport(pageNum: number, scale: number = 2.0): Promise<string> {
    const dims = this.pageDimensions()[pageNum];
    if (!dims) {
      throw new Error(`No dimensions for page ${pageNum}`);
    }

    const canvasWidth = Math.round(dims.width * scale);
    const canvasHeight = Math.round(dims.height * scale);

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;

    // Determine if this page should show white background
    // Only use explicit blankedPages or removeBackgrounds, not pagesWithAllImagesDeleted
    // because re-rendered pages already have images whited out with native text preserved
    const pageIsBlanked = this.blankedPages().has(pageNum) || this.removeBackgrounds();

    // Get page blocks once for use throughout this function
    const pageBlocks = this.getPageBlocks(pageNum);

    // Check if this page has any image blocks (for diagnostic logging)
    const imageBlocksOnPage = pageBlocks.filter(b => b.is_image);
    const hasImages = imageBlocksOnPage.length > 0;

    if (pageIsBlanked) {
      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    } else {
      // Draw the page image
      const imgUrl = this.pageImages().get(pageNum);
      if (imgUrl && imgUrl !== 'loading') {
        await this.drawImageToCanvas(ctx, imgUrl, canvasWidth, canvasHeight);
      } else {
        // Fallback to white if no image
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }

      // Paint deleted regions white (cleanly removed in export, no X marks)
      for (const block of pageBlocks) {
        if (this.isDeleted(block.id)) {
          // Use white to cleanly remove deleted content
          ctx.fillStyle = '#ffffff';

          const x = block.x * scale;
          const y = block.y * scale;
          const w = block.width * scale;
          const h = block.height * scale;
          ctx.fillRect(x, y, w, h);
        }
      }

      // Paint deleted custom category highlights white (e.g., footnote numbers)
      const pageHighlights = this.getHighlightsForPage(pageNum);
      const deletedHighlights = pageHighlights.filter(h => h.deleted);

      if (deletedHighlights.length > 0) {
        console.log(`[renderPageForExport] Page ${pageNum}: ${deletedHighlights.length} deleted highlights`);
        console.log(`  Canvas: ${canvasWidth}x${canvasHeight}, Scale: ${scale}, Page dims: ${dims.width}x${dims.height}`);
        if (hasImages) {
          console.log(`  PAGE HAS ${imageBlocksOnPage.length} IMAGE(S):`);
          for (const img of imageBlocksOnPage) {
            console.log(`    - Image at (${img.x.toFixed(1)}, ${img.y.toFixed(1)}) size ${img.width.toFixed(1)}x${img.height.toFixed(1)}`);
          }
        }
      }

      for (const highlight of deletedHighlights) {
        ctx.fillStyle = '#ffffff';
        const x = highlight.rect.x * scale;
        const y = highlight.rect.y * scale;
        const w = highlight.rect.w * scale;
        const h = highlight.rect.h * scale;
        const yRatio = highlight.rect.y / dims.height;
        console.log(`  - "${highlight.rect.text}" at (${highlight.rect.x.toFixed(1)}, ${highlight.rect.y.toFixed(1)}) yRatio=${yRatio.toFixed(3)} -> scaled (${x.toFixed(1)}, ${y.toFixed(1)})${hasImages ? ' [PAGE HAS IMAGES]' : ''}`);
        ctx.fillRect(x, y, w, h);
      }
    }

    // Draw text overlays for NON-deleted blocks only (deleted text is removed in export)
    for (const block of pageBlocks) {
      // Only draw text for non-deleted blocks that should show text overlay
      if (this.shouldShowTextOverlay(block) && !this.isDeleted(block.id)) {
        this.drawTextBlockToCanvas(ctx, block, scale);
      }
    }

    // Export does NOT include delete markers - content is cleanly removed
    return canvas.toDataURL('image/png');
  }

  /**
   * Draw an image onto the canvas
   */
  private drawImageToCanvas(ctx: CanvasRenderingContext2D, imgUrl: string, width: number, height: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        resolve();
      };
      img.onerror = reject;
      img.src = imgUrl;
    });
  }

  /**
   * Draw a text block onto the canvas
   */
  private drawTextBlockToCanvas(ctx: CanvasRenderingContext2D, block: TextBlock, scale: number): void {
    const text = this.getDisplayText(block);
    if (!text) return;

    const fontSize = this.getOverlayFontSize(block) * scale;
    const x = this.getBlockX(block) * scale;
    const y = this.getBlockY(block) * scale;
    const width = this.getBlockWidth(block) * scale;
    const height = this.getExpandedHeight(block) * scale;

    const deleted = this.isDeleted(block.id);

    // Set font
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';

    // Set color based on deleted state
    if (deleted) {
      ctx.fillStyle = 'rgba(102, 102, 102, 0.35)';  // Faded gray for deleted
    } else {
      ctx.fillStyle = '#000000';  // Black for normal text
    }

    // Simple text wrapping
    const lineHeight = fontSize * 1.15;
    const words = text.split(/\s+/);
    let line = '';
    let currentY = y + fontSize * 0.1;  // Small top padding

    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > width && line) {
        ctx.fillText(line, x, currentY);
        line = word;
        currentY += lineHeight;

        // Stop if we've exceeded the block height
        if (currentY > y + height) break;
      } else {
        line = testLine;
      }
    }

    // Draw remaining text
    if (line && currentY <= y + height) {
      ctx.fillText(line, x, currentY);
    }
  }

  /**
   * Draw delete marker (X) onto the canvas
   */
  private drawDeleteMarkerToCanvas(ctx: CanvasRenderingContext2D, block: TextBlock, scale: number): void {
    const x = this.getBlockX(block) * scale;
    const y = this.getBlockY(block) * scale;
    const w = this.getBlockWidth(block) * scale;
    const h = this.getBlockHeight(block) * scale;

    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2 * scale;

    // Draw X
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + w, y);
    ctx.lineTo(x, y + h);
    ctx.stroke();
  }

  /**
   * Render all pages for export.
   * Returns an array of data URLs, one per page (excluding deleted pages).
   */
  async renderAllPagesForExport(scale: number = 2.0): Promise<Array<{ pageNum: number; dataUrl: string }>> {
    const results: Array<{ pageNum: number; dataUrl: string }> = [];
    const deletedPages = this.deletedPages();
    const totalPages = this.totalPages();

    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      if (deletedPages.has(pageNum)) continue;

      const dataUrl = await this.renderPageForExport(pageNum, scale);
      results.push({ pageNum, dataUrl });
    }

    return results;
  }
}

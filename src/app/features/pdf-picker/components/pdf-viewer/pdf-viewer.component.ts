import { Component, input, output, ViewChild, ElementRef, effect, signal, computed, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TextBlock, Category, PageDimension } from '../../services/pdf.service';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

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
  imports: [CommonModule, DesktopButtonComponent],
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
      <div
        #viewport
        class="pdf-viewport"
        (wheel)="onWheel($event)"
              >
        <div class="pdf-container" [class.grid]="layout() === 'grid'" [class.organize-mode]="editorMode() === 'organize'">
          @for (pageNum of pageNumbers(); track pageNum; let idx = $index) {
            <div
              class="page-wrapper"
              [attr.data-page]="pageNum"
              [attr.data-index]="idx"
              [style.width.px]="getPageWidth(pageNum)"
              [class.dragging]="isDraggingPage() && draggedPageIndex === idx"
              [class.drag-over]="dragOverIndex() === idx"
              [class.drag-over-before]="dragOverIndex() === idx && dropTargetIndex === idx"
              [class.drag-over-after]="dragOverIndex() === idx && dropTargetIndex === idx + 1"
              [draggable]="editorMode() === 'organize'"
              (contextmenu)="onPageContextMenu($event, pageNum)"
              (dragstart)="onPageDragStart($event, idx, pageNum)"
              (dragend)="onPageDragEnd($event)"
              (dragover)="onPageDragOver($event, idx)"
              (dragleave)="onPageDragLeave($event)"
              (drop)="onPageDrop($event, idx)"
            >
              <div class="page-content">
                @if (getImageUrl(pageNum) && getImageUrl(pageNum) !== 'loading') {
                  <img
                    #pageImage
                    class="pdf-image"
                    [src]="getImageUrl(pageNum)"
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
                  [class.organize-mode]="editorMode() === 'organize'"
                  [attr.viewBox]="getViewBox(pageNum)"
                  preserveAspectRatio="none"
                  (mousedown)="onOverlayMouseDown($event, pageNum)"
                  (mousemove)="onOverlayMouseMove($event, pageNum)"
                  (mouseup)="onOverlayMouseUp($event, pageNum)"
                  (mouseleave)="onOverlayMouseLeave()"
                >
                  @if (!cropMode() && !sampleMode()) {
                    @for (block of getPageBlocks(pageNum); track block.id) {
                      <rect
                        class="block-rect"
                        [attr.x]="getBlockX(block)"
                        [attr.y]="getBlockY(block)"
                        [attr.width]="getBlockWidth(block)"
                        [attr.height]="getBlockHeight(block)"
                        [attr.fill]="isSelected(block.id) ? getBlockFill(block) : 'transparent'"
                        [attr.stroke]="isSelected(block.id) ? getBlockStroke(block) : (hasCorrectedText(block.id) ? '#4caf50' : (hasOffset(block.id) ? '#2196f3' : 'transparent'))"
                        [class.selected]="isSelected(block.id)"
                        [class.deleted]="isDeleted(block.id)"
                        [class.corrected]="hasCorrectedText(block.id)"
                        [class.moved]="hasOffset(block.id)"
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
                      @if (hasTextOverlay(block) && !isDeleted(block.id)) {
                        <!-- Text overlay at new position (original text redacted from PDF render) -->
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
                            [style.font-size.px]="block.font_size"
                            [style.width.px]="getBlockWidth(block)"
                            [class.corrected]="hasCorrectedText(block.id)"
                            [class.moved]="hasOffset(block.id)"
                          >{{ getDisplayText(block) }}</div>
                        </foreignObject>
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
                        fill="rgba(255, 107, 53, 0.15)"
                        stroke="var(--accent, #ff6b35)"
                        stroke-width="2"
                        stroke-dasharray="6,3"
                      />
                    }
                  }

                  <!-- Category highlights (lightweight match rects for custom categories + regex preview) -->
                  <!-- Shown in normal mode and regex search mode, hidden in crop/sample mode -->
                  @if (!cropMode() && !sampleMode()) {
                    @for (highlight of getHighlightsForPage(pageNum); track $index) {
                      <rect
                        class="highlight-rect"
                        [class.deleted]="highlight.deleted"
                        [attr.x]="highlight.rect.x"
                        [attr.y]="highlight.rect.y"
                        [attr.width]="highlight.rect.w"
                        [attr.height]="highlight.rect.h"
                        [attr.fill]="highlight.deleted ? 'rgba(255, 68, 68, 0.2)' : highlight.color + '40'"
                        [attr.stroke]="highlight.deleted ? '#ff4444' : highlight.color"
                        stroke-width="1"
                      >
                        <title>{{ highlight.rect.text }}</title>
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
                      stroke="#ff6b35"
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
                      fill="#ff6b35"
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
                Page {{ pageNum + 1 }}
              </div>
            </div>
          }
        </div>
      </div>
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
        <div class="menu-item" (click)="onSelectAllOnPage()">Select all on page {{ pageMenuPageNum() + 1 }}</div>
        <div class="menu-item" (click)="onDeselectAllOnPage()">Deselect all on page {{ pageMenuPageNum() + 1 }}</div>
      </div>
    }
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      flex: 1;
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
      gap: var(--ui-spacing-md) !important;
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
      background: var(--accent, #ff6b35);
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
    }

    .pdf-image {
      display: block;
      width: 100%;
      height: auto;
    }

    .block-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: all;
      cursor: crosshair;

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
      stroke: var(--accent, #ff6b35);
      stroke-width: 3;
      stroke-dasharray: 8,4;
      cursor: move;
      pointer-events: all;
      animation: cropPulse 1.5s ease-in-out infinite;
    }

    .crop-handle {
      fill: var(--accent, #ff6b35);
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

    .block-overlay.organize-mode .block-rect {
      opacity: 0;
      pointer-events: none;
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
      fill: rgba(255, 68, 68, 0.2) !important;
      stroke: #ff4444 !important;
      stroke-dasharray: 4, 2;
      opacity: 0.6;
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
    .block-overlay .highlight-rect {
      pointer-events: none;
      stroke-width: 1;
      opacity: 0.8;
    }

    .block-overlay .highlight-rect.deleted {
      stroke-dasharray: 4, 2;
      opacity: 0.6;
    }

    .highlight-delete-mark {
      pointer-events: none;
      opacity: 0.8;
    }

    .delete-mark {
      pointer-events: none;
      opacity: 0.8;
    }

    /* Text overlay for corrected/moved blocks */
    .text-overlay {
      pointer-events: none;
      overflow: visible;
    }

    .text-overlay-content {
      padding: 2px 4px;
      font-family: Georgia, 'Times New Roman', Times, serif;
      line-height: 1.2;
      color: #1a1a1a;
      background: #ffffff;
      border: 1px solid #4caf50;
      white-space: pre-wrap;
      word-wrap: break-word;
      box-sizing: border-box;
      min-height: 100%;
    }

    .text-overlay-content.corrected {
      background: #ffffff;
      border-color: #4caf50;
    }

    .text-overlay-content.moved {
      background: #f0f8ff;
      border-color: #2196f3;
    }

    .text-overlay-content.corrected.moved {
      background: #f0fff0;
      border-color: #00bcd4;
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
export class PdfViewerComponent {
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.closeAllContextMenus();
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
  cropMode = input<boolean>(false);
  cropCurrentPage = input<number>(0);
  editorMode = input<string>('select'); // 'select' | 'edit' | 'crop' | 'organize' | 'split'
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
  zoomChange = output<'in' | 'out'>();
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

  // Output for marquee selection
  marqueeSelect = output<{ blockIds: string[]; additive: boolean }>();

  @ViewChild('viewport') viewport!: ElementRef<HTMLDivElement>;

  // Zoom state for preserving scroll position
  private pendingZoomAdjustment: { scrollRatioX: number; scrollRatioY: number; cursorX: number; cursorY: number } | null = null;
  private previousZoom = 100;

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
    const fn = this.pageImageUrlFn();
    return fn(pageNum);
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
    return this.blocksByPage().get(pageNum) || [];
  }

  getSampleRectsForPage(pageNum: number): Array<{ x: number; y: number; width: number; height: number }> {
    return this.sampleRects().filter(r => r.page === pageNum);
  }

  getBlockFill(block: TextBlock): string {
    const cat = this.categories()[block.category_id];
    return (cat?.color || '#ff6b35') + '40';
  }

  getBlockStroke(block: TextBlock): string {
    const cat = this.categories()[block.category_id];
    return cat?.color || '#ff6b35';
  }

  isSelected(blockId: string): boolean {
    return this.selectedBlockIds().includes(blockId);
  }

  isDeleted(blockId: string): boolean {
    return this.deletedBlockIds().has(blockId);
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
    return block.y + (offset?.offsetY ?? 0);
  }

  getBlockWidth(block: TextBlock): number {
    const sizeOverride = this.blockSizes().get(block.id);
    return sizeOverride?.width ?? block.width;
  }

  getBlockHeight(block: TextBlock): number {
    const sizeOverride = this.blockSizes().get(block.id);
    return sizeOverride?.height ?? block.height;
  }

  getCorrectedText(blockId: string): string | null {
    return this.textCorrections().get(blockId) ?? null;
  }

  hasTextOverlay(block: TextBlock): boolean {
    // Show text overlay if block has correction OR has been moved/resized
    return this.hasCorrectedText(block.id) || this.hasOffset(block.id) || this.blockSizes().has(block.id);
  }

  getDisplayText(block: TextBlock): string {
    return this.getCorrectedText(block.id) ?? block.text;
  }

  getExpandedHeight(block: TextBlock): number {
    const baseHeight = this.getBlockHeight(block);
    const displayText = this.getDisplayText(block);
    const originalText = block.text;

    // Calculate approximate height needed based on text length ratio
    const textRatio = displayText.length / Math.max(originalText.length, 1);

    // Also account for newlines
    const newlineCount = (displayText.match(/\n/g) || []).length;
    const originalNewlines = (originalText.match(/\n/g) || []).length;
    const extraNewlines = Math.max(0, newlineCount - originalNewlines);

    // Estimate: each newline adds roughly one line height (font_size * 1.2)
    const lineHeight = block.font_size * 1.2;
    const extraHeight = extraNewlines * lineHeight;

    // Scale height by text ratio, with extra for newlines, minimum 1.5x for safety
    const scaledHeight = Math.max(baseHeight * textRatio, baseHeight) + extraHeight;

    // Return at least 1.5x original height to allow for some expansion, max 5x
    return Math.min(Math.max(scaledHeight, baseHeight * 1.5), baseHeight * 5);
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

  onBlockClick(event: MouseEvent, block: TextBlock): void {
    event.preventDefault();
    event.stopPropagation();
    this.blockClick.emit({
      block,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey
    });
  }

  onBlockDoubleClick(event: MouseEvent, block: TextBlock): void {
    event.preventDefault();
    event.stopPropagation();

    // Get screen coordinates of the block for inline editing
    const target = event.target as SVGRectElement;
    const rect = target.getBoundingClientRect();

    this.blockDoubleClick.emit({
      block,
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

  // Accumulated scroll delta for smoother zoom
  private scrollDeltaAccumulator = 0;
  private readonly SCROLL_THRESHOLD = 50; // Pixels of scroll needed to trigger zoom

  onWheel(event: WheelEvent): void {
    // Cmd/Ctrl + scroll for zoom
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();

      if (!this.viewport?.nativeElement) return;

      // Accumulate scroll delta
      this.scrollDeltaAccumulator += event.deltaY;

      // Only zoom when accumulated delta exceeds threshold
      if (Math.abs(this.scrollDeltaAccumulator) < this.SCROLL_THRESHOLD) {
        return;
      }

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

      // Emit zoom direction to parent and reset accumulator
      if (this.scrollDeltaAccumulator < 0) {
        this.zoomChange.emit('in');
      } else {
        this.zoomChange.emit('out');
      }
      this.scrollDeltaAccumulator = 0;
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

  // Page drag/drop for organize mode
  onPageDragStart(event: DragEvent, index: number, pageNum: number): void {
    if (this.editorMode() !== 'organize') {
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
    if (this.editorMode() !== 'organize' || this.draggedPageIndex === null) return;

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

  // Public method to scroll to a specific page
  scrollToPage(pageNum: number): void {
    if (!this.viewport?.nativeElement) return;

    const vp = this.viewport.nativeElement;
    const pageWrapper = vp.querySelector(`.page-wrapper[data-page="${pageNum}"]`);

    if (pageWrapper) {
      pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Unified overlay mouse handlers (for crop, marquee selection, and sample mode)
  onOverlayMouseDown(event: MouseEvent, pageNum: number): void {
    // Check if clicking on a block (block rects have their own handlers)
    const target = event.target as Element;
    if (target.classList.contains('block-rect')) {
      return; // Let block handler take over
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

  onOverlayMouseUp(event: MouseEvent, pageNum: number): void {
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
}

import { Component, Input, Output, EventEmitter, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, fromEvent, merge } from 'rxjs';
import { takeUntil, filter } from 'rxjs/operators';

export interface TextEditResult {
  blockId: string;
  text: string;
  cancelled: boolean;
  // New dimensions if resized (undefined if not changed)
  width?: number;
  height?: number;
}

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null;

@Component({
  selector: 'app-inline-text-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <!-- Translucent overlay covering the text block -->
    <div
      class="inline-editor-overlay"
      [style.left.px]="currentX"
      [style.top.px]="currentY"
      [style.width.px]="currentWidth"
      [style.height.px]="currentHeight"
      (click)="$event.stopPropagation()"
      (mousedown)="$event.stopPropagation()"
    >
      <textarea
        #textArea
        class="inline-editor-textarea"
        [(ngModel)]="editedText"
        (ngModelChange)="onTextChange()"
        (keydown)="onKeyDown($event)"
        (blur)="onBlur()"
        [style.font-size.px]="fontSize"
      ></textarea>

      <!-- Hidden measurement div for calculating text height -->
      <div
        #measureDiv
        class="measure-div"
        [style.width.px]="currentWidth - 12"
        [style.font-size.px]="fontSize"
      >{{ editedText }}</div>

      <!-- Resize handles -->
      <div class="resize-handle resize-n" (mousedown)="startResize($event, 'n')"></div>
      <div class="resize-handle resize-s" (mousedown)="startResize($event, 's')"></div>
      <div class="resize-handle resize-e" (mousedown)="startResize($event, 'e')"></div>
      <div class="resize-handle resize-w" (mousedown)="startResize($event, 'w')"></div>
      <div class="resize-handle resize-ne" (mousedown)="startResize($event, 'ne')"></div>
      <div class="resize-handle resize-nw" (mousedown)="startResize($event, 'nw')"></div>
      <div class="resize-handle resize-se" (mousedown)="startResize($event, 'se')"></div>
      <div class="resize-handle resize-sw" (mousedown)="startResize($event, 'sw')"></div>
    </div>

    <!-- Floating action buttons positioned below the block -->
    <div
      class="inline-editor-actions"
      [style.left.px]="currentX + currentWidth - actionsWidth"
      [style.top.px]="currentY + currentHeight + 4"
      (click)="$event.stopPropagation()"
      (mousedown)="$event.stopPropagation()"
    >
      <button class="action-btn save-btn" (click)="save()" title="Save (Ctrl+Enter)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
      <button class="action-btn cancel-btn" (click)="cancel()" title="Cancel (Escape)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      @if (hasCorrection) {
        <button class="action-btn revert-btn" (click)="revert()" title="Revert to original">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
        </button>
      }
      @if (wasResized) {
        <button class="action-btn reset-size-btn" (click)="resetSize()" title="Reset to original size">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>
          </svg>
        </button>
      }
    </div>
  `,
  styles: [`
    .inline-editor-overlay {
      position: fixed;
      z-index: 1000;
      background: rgba(255, 255, 200, 0.92);
      border: 3px solid #007acc;
      border-radius: 2px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .inline-editor-textarea {
      width: 100%;
      height: 100%;
      border: none;
      background: transparent;
      color: #1a1a1a;
      font-family: Georgia, 'Times New Roman', Times, serif;
      line-height: 1.35;
      padding: 4px 6px;
      resize: none;
      outline: none;
      overflow-y: auto;
    }

    .inline-editor-textarea::selection {
      background: rgba(0, 122, 204, 0.3);
    }

    /* Hidden div for measuring text height */
    .measure-div {
      position: absolute;
      visibility: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: Georgia, 'Times New Roman', Times, serif;
      line-height: 1.35;
      padding: 4px 6px;
      pointer-events: none;
    }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      background: transparent;
    }

    .resize-handle:hover {
      background: rgba(0, 122, 204, 0.3);
    }

    .resize-n, .resize-s {
      left: 8px;
      right: 8px;
      height: 6px;
      cursor: ns-resize;
    }
    .resize-n { top: -3px; }
    .resize-s { bottom: -3px; }

    .resize-e, .resize-w {
      top: 8px;
      bottom: 8px;
      width: 6px;
      cursor: ew-resize;
    }
    .resize-e { right: -3px; }
    .resize-w { left: -3px; }

    .resize-ne, .resize-nw, .resize-se, .resize-sw {
      width: 12px;
      height: 12px;
    }
    .resize-ne { top: -3px; right: -3px; cursor: nesw-resize; }
    .resize-nw { top: -3px; left: -3px; cursor: nwse-resize; }
    .resize-se { bottom: -3px; right: -3px; cursor: nwse-resize; }
    .resize-sw { bottom: -3px; left: -3px; cursor: nesw-resize; }

    .inline-editor-actions {
      position: fixed;
      z-index: 1001;
      display: flex;
      gap: 4px;
      background: rgba(30, 30, 30, 0.95);
      padding: 4px;
      border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
    }

    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .save-btn {
      background: #4caf50;
      color: white;
    }

    .save-btn:hover {
      background: #66bb6a;
      transform: scale(1.05);
    }

    .cancel-btn {
      background: #666;
      color: #fff;
    }

    .cancel-btn:hover {
      background: #888;
      transform: scale(1.05);
    }

    .revert-btn {
      background: #ff9800;
      color: white;
    }

    .revert-btn:hover {
      background: #ffa726;
      transform: scale(1.05);
    }

    .reset-size-btn {
      background: #9c27b0;
      color: white;
    }

    .reset-size-btn:hover {
      background: #ab47bc;
      transform: scale(1.05);
    }
  `]
})
export class InlineTextEditorComponent implements AfterViewInit, OnDestroy {
  @Input() blockId: string = '';
  @Input() originalText: string = '';
  @Input() correctedText: string | null = null;
  @Input() x: number = 0;
  @Input() y: number = 0;
  @Input() width: number = 200;
  @Input() height: number = 50;
  @Input() fontSize: number = 14;

  @Output() editComplete = new EventEmitter<TextEditResult>();

  @ViewChild('textArea') textArea!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('measureDiv') measureDiv!: ElementRef<HTMLDivElement>;

  editedText: string = '';
  private initialHeight: number = 50; // Store initial height for comparison
  private isClosing = false;

  // Current dimensions (may differ from input if resized)
  currentX: number = 0;
  currentY: number = 0;
  currentWidth: number = 200;
  currentHeight: number = 50;

  // Resize state
  private resizing: ResizeHandle = null;
  private resizeStartX: number = 0;
  private resizeStartY: number = 0;
  private resizeStartWidth: number = 0;
  private resizeStartHeight: number = 0;
  private resizeStartLeft: number = 0;
  private resizeStartTop: number = 0;

  // RxJS subjects for cleanup
  private destroy$ = new Subject<void>();
  private resizeStop$ = new Subject<void>();

  // Minimum dimensions
  private readonly MIN_WIDTH = 100;
  private readonly MIN_HEIGHT = 40;

  constructor(private cdr: ChangeDetectorRef) {}

  get hasCorrection(): boolean {
    return this.correctedText !== null && this.correctedText !== this.originalText;
  }

  get wasResized(): boolean {
    return this.currentWidth !== this.width || this.currentHeight !== this.height;
  }

  get actionsWidth(): number {
    // Base width for save + cancel buttons, plus optional buttons
    let width = 60; // 2 buttons * 26px + gap
    if (this.hasCorrection) width += 30;
    if (this.wasResized) width += 30;
    return width;
  }

  ngAfterViewInit(): void {
    // Initialize current dimensions from input
    this.currentX = this.x;
    this.currentY = this.y;
    this.currentWidth = this.width;
    this.currentHeight = this.height;
    this.initialHeight = this.height;

    // Use corrected text if available, otherwise original
    this.editedText = this.correctedText ?? this.originalText;

    // Focus the textarea after view init
    setTimeout(() => {
      if (this.textArea) {
        this.textArea.nativeElement.focus();
        // Move cursor to end instead of selecting all
        const len = this.textArea.nativeElement.value.length;
        this.textArea.nativeElement.setSelectionRange(len, len);
      }
      // Do initial height measurement
      this.adjustHeightToFitContent();
    }, 0);
  }

  /**
   * Called when text content changes - auto-expand height to fit
   */
  onTextChange(): void {
    // Use requestAnimationFrame to ensure the measureDiv has updated
    requestAnimationFrame(() => {
      this.adjustHeightToFitContent();
    });
  }

  /**
   * Adjust the editor height to fit the text content
   */
  private adjustHeightToFitContent(): void {
    if (!this.measureDiv) return;

    const measureEl = this.measureDiv.nativeElement;
    const measuredHeight = measureEl.scrollHeight + 8; // Add padding

    // Only expand, don't shrink below initial height
    const newHeight = Math.max(this.initialHeight, measuredHeight, this.MIN_HEIGHT);

    if (newHeight !== this.currentHeight) {
      this.currentHeight = newHeight;
    }
  }

  ngOnDestroy(): void {
    // Ensure we emit if destroyed without explicit save/cancel
    if (!this.isClosing) {
      this.cancel();
    }
    // Clean up RxJS subscriptions
    this.stopResize();
    this.destroy$.next();
    this.destroy$.complete();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.save();
    }
  }

  onBlur(): void {
    // Small delay to allow button clicks and resize to register
    setTimeout(() => {
      if (!this.isClosing && !this.resizing) {
        this.save();
      }
    }, 200);
  }

  // Resize handling using RxJS
  startResize(event: MouseEvent, handle: ResizeHandle): void {
    event.preventDefault();
    event.stopPropagation();

    this.resizing = handle;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartWidth = this.currentWidth;
    this.resizeStartHeight = this.currentHeight;
    this.resizeStartLeft = this.currentX;
    this.resizeStartTop = this.currentY;

    // Mouse move - track position
    fromEvent<MouseEvent>(document, 'mousemove')
      .pipe(takeUntil(this.resizeStop$))
      .subscribe((e) => {
        if (!this.resizing) return;

        const deltaX = e.clientX - this.resizeStartX;
        const deltaY = e.clientY - this.resizeStartY;

        let newWidth = this.resizeStartWidth;
        let newHeight = this.resizeStartHeight;
        let newX = this.resizeStartLeft;
        let newY = this.resizeStartTop;

        // Handle horizontal resize
        if (this.resizing!.includes('e')) {
          newWidth = Math.max(this.MIN_WIDTH, this.resizeStartWidth + deltaX);
        } else if (this.resizing!.includes('w')) {
          const widthChange = Math.min(deltaX, this.resizeStartWidth - this.MIN_WIDTH);
          newWidth = this.resizeStartWidth - widthChange;
          newX = this.resizeStartLeft + widthChange;
        }

        // Handle vertical resize
        if (this.resizing!.includes('s')) {
          newHeight = Math.max(this.MIN_HEIGHT, this.resizeStartHeight + deltaY);
        } else if (this.resizing!.includes('n')) {
          const heightChange = Math.min(deltaY, this.resizeStartHeight - this.MIN_HEIGHT);
          newHeight = this.resizeStartHeight - heightChange;
          newY = this.resizeStartTop + heightChange;
        }

        this.currentWidth = newWidth;
        this.currentHeight = newHeight;
        this.currentX = newX;
        this.currentY = newY;
        this.cdr.detectChanges();
      });

    // All the ways resizing can end
    merge(
      fromEvent(document, 'mouseup'),
      fromEvent(document, 'pointerup'),
      fromEvent(window, 'blur'),
      fromEvent(document, 'visibilitychange').pipe(
        filter(() => document.hidden)
      ),
      fromEvent<MouseEvent>(document, 'mouseleave').pipe(
        filter((e) => e.relatedTarget === null)
      )
    )
      .pipe(takeUntil(this.resizeStop$))
      .subscribe(() => {
        this.stopResize();
      });
  }

  private stopResize(): void {
    if (this.resizing) {
      this.resizing = null;
      this.resizeStop$.next();
      this.cdr.detectChanges();
    }
  }

  resetSize(): void {
    this.currentWidth = this.width;
    this.currentHeight = this.height;
    this.currentX = this.x;
    this.currentY = this.y;
  }

  save(): void {
    if (this.isClosing) return;
    this.isClosing = true;

    const result: TextEditResult = {
      blockId: this.blockId,
      text: this.editedText,
      cancelled: false
    };

    // Include new dimensions if resized
    if (this.wasResized) {
      result.width = this.currentWidth;
      result.height = this.currentHeight;
    }

    this.editComplete.emit(result);
  }

  cancel(): void {
    if (this.isClosing) return;
    this.isClosing = true;

    this.editComplete.emit({
      blockId: this.blockId,
      text: this.correctedText ?? this.originalText,
      cancelled: true
    });
  }

  revert(): void {
    if (this.isClosing) return;
    this.isClosing = true;

    // Emit with original text to clear the correction
    this.editComplete.emit({
      blockId: this.blockId,
      text: this.originalText,
      cancelled: false
    });
  }
}

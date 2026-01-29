import { Component, Input, Output, EventEmitter, ElementRef, ViewChild, AfterViewInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'desktop-split-pane',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="split-pane"
      [class.horizontal]="direction === 'horizontal'"
      [class.vertical]="direction === 'vertical'"
      [class.resizing]="isResizing"
      #container
    >
      <div
        class="pane primary"
        [style.flex-basis.px]="primarySize"
        [style.min-width.px]="direction === 'horizontal' ? minSize : null"
        [style.min-height.px]="direction === 'vertical' ? minSize : null"
      >
        <ng-content select="[pane-primary]"></ng-content>
      </div>

      <div
        class="splitter"
        (mousedown)="startResize($event)"
        [title]="'Drag to resize'"
      >
        <div class="splitter-line"></div>
      </div>

      <div
        class="pane secondary"
        [style.min-width.px]="direction === 'horizontal' ? minSize : null"
        [style.min-height.px]="direction === 'vertical' ? minSize : null"
      >
        <ng-content select="[pane-secondary]"></ng-content>
      </div>
    </div>
  `,
  styles: [`
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      display: block;
      height: 100%;
      width: 100%;
    }

    .split-pane {
      display: flex;
      height: 100%;
      width: 100%;
      overflow: hidden;

      &.horizontal {
        flex-direction: row;
      }

      &.vertical {
        flex-direction: column;
      }

      &.resizing {
        cursor: col-resize;
        user-select: none;

        &.vertical {
          cursor: row-resize;
        }

        .pane {
          pointer-events: none;
        }

        .splitter-line {
          background: var(--accent);
        }
      }
    }

    .pane {
      overflow: hidden;
      display: flex;
      flex-direction: column;

      &.secondary {
        flex: 1;
      }
    }

    .splitter {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      transition: background $duration-fast $ease-out;

      .horizontal & {
        width: 1px;
        cursor: col-resize;
        background: var(--border-subtle);
        position: relative;

        // Larger hit area
        &::before {
          content: '';
          position: absolute;
          top: 0;
          left: -3px;
          right: -3px;
          bottom: 0;
        }
      }

      .vertical & {
        height: 1px;
        cursor: row-resize;
        background: var(--border-subtle);
        position: relative;

        // Larger hit area
        &::before {
          content: '';
          position: absolute;
          top: -3px;
          left: 0;
          right: 0;
          bottom: -3px;
        }
      }

      &:hover {
        .splitter-line {
          background: var(--accent);
          opacity: 1;
        }
      }
    }

    .splitter-line {
      position: absolute;
      background: transparent;
      opacity: 0;
      transition: all $duration-fast $ease-out;

      .horizontal & {
        width: 3px;
        height: 100%;
        border-radius: $radius-full;
      }

      .vertical & {
        width: 100%;
        height: 3px;
        border-radius: $radius-full;
      }
    }
  `]
})
export class SplitPaneComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLElement>;

  @Input() direction: 'horizontal' | 'vertical' = 'horizontal';
  @Input() primarySize = 250;
  @Input() minSize = 100;
  @Input() maxSize = 600;

  @Output() sizeChanged = new EventEmitter<number>();

  isResizing = false;
  private startPos = 0;
  private startSize = 0;
  private cleanupFn: (() => void) | null = null;

  constructor(private ngZone: NgZone) {}

  ngAfterViewInit() {
    // Initialization if needed
  }

  ngOnDestroy() {
    // Ensure cleanup if component is destroyed while resizing
    this.stopResize();
  }

  startResize(event: MouseEvent) {
    // Prevent default to avoid text selection and other drag behaviors
    event.preventDefault();
    event.stopPropagation();

    this.isResizing = true;
    this.startPos = this.direction === 'horizontal' ? event.clientX : event.clientY;
    this.startSize = this.primarySize;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizing) return;
      e.preventDefault();

      const currentPos = this.direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - this.startPos;
      const newSize = Math.min(this.maxSize, Math.max(this.minSize, this.startSize + delta));

      // Run inside Angular zone to trigger change detection
      this.ngZone.run(() => {
        this.primarySize = newSize;
        this.sizeChanged.emit(newSize);
      });
    };

    const onMouseUp = () => {
      this.stopResize();
    };

    // Also stop if window loses focus (e.g., alt-tab, click outside browser)
    const onWindowBlur = () => {
      this.stopResize();
    };

    // Store cleanup function
    this.cleanupFn = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onWindowBlur);
    };

    // Run event listeners outside Angular zone for performance
    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      window.addEventListener('blur', onWindowBlur);
    });
  }

  private stopResize() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
    if (this.isResizing) {
      this.ngZone.run(() => {
        this.isResizing = false;
      });
    }
  }
}

import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnDestroy,
  ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subject, fromEvent, merge } from 'rxjs';
import { takeUntil, filter } from 'rxjs/operators';

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
        (mousedown)="onSplitterMouseDown($event)"
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
export class SplitPaneComponent implements OnDestroy {
  @Input() direction: 'horizontal' | 'vertical' = 'horizontal';
  @Input() primarySize = 250;
  @Input() minSize = 100;
  @Input() maxSize = 600;

  @Output() sizeChanged = new EventEmitter<number>();

  isResizing = false;

  private destroy$ = new Subject<void>();
  private resizeStop$ = new Subject<void>();
  private startPos = 0;
  private startSize = 0;

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnDestroy(): void {
    this.stopResize();
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSplitterMouseDown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    this.isResizing = true;
    this.startPos = this.direction === 'horizontal' ? event.clientX : event.clientY;
    this.startSize = this.primarySize;

    // Mouse move - track position
    fromEvent<MouseEvent>(document, 'mousemove')
      .pipe(takeUntil(this.resizeStop$))
      .subscribe((e) => {
        e.preventDefault();
        const currentPos = this.direction === 'horizontal' ? e.clientX : e.clientY;
        const delta = currentPos - this.startPos;
        const newSize = Math.min(this.maxSize, Math.max(this.minSize, this.startSize + delta));

        this.primarySize = newSize;
        this.sizeChanged.emit(newSize);
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
    if (this.isResizing) {
      this.isResizing = false;
      this.resizeStop$.next();
      this.cdr.detectChanges();
    }
  }
}

import { Component, EventEmitter, Input, Output, HostListener, ElementRef, AfterViewInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ContextMenuAction, ContextMenuPosition } from '../../models/cascade.model';

@Component({
  selector: 'desktop-context-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible) {
      <div
        class="context-menu"
        [style.left.px]="adjustedPosition.x"
        [style.top.px]="adjustedPosition.y"
        (click)="$event.stopPropagation()"
      >
        @for (action of actions; track action.action) {
          @if (action.divider) {
            <div class="menu-divider"></div>
          } @else {
            <button
              class="menu-item"
              [class.disabled]="action.disabled"
              [disabled]="action.disabled"
              (click)="onActionClick(action)"
            >
              @if (action.icon) {
                <span class="menu-icon">{{ action.icon }}</span>
              }
              <span class="menu-label">{{ action.label }}</span>
              @if (action.shortcut) {
                <span class="menu-shortcut">{{ action.shortcut }}</span>
              }
            </button>
          }
        }
      </div>
    }
  `,
  styles: [`
    @use '../../styles/variables' as *;

    .context-menu {
      position: fixed;
      z-index: 10000;
      min-width: 180px;
      max-width: 280px;
      padding: $spacing-1;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      box-shadow:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 10px 20px -2px rgba(0, 0, 0, 0.15),
        0 0 0 1px rgba(0, 0, 0, 0.05);
      animation: menuAppear 0.12s $ease-out;
      overflow: hidden;
    }

    @keyframes menuAppear {
      from {
        opacity: 0;
        transform: scale(0.96) translateY(-4px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: $spacing-2-5;
      width: 100%;
      padding: $spacing-2 $spacing-3;
      background: transparent;
      border: none;
      border-radius: $radius-md;
      color: var(--text-primary);
      font-family: $font-body;
      font-size: $font-size-sm;
      font-weight: $font-weight-regular;
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      text-align: left;

      &:hover:not(.disabled) {
        background: var(--hover-bg);

        .menu-icon {
          transform: scale(1.1);
        }
      }

      &:active:not(.disabled) {
        background: var(--active-bg);
      }

      &.disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    .menu-icon {
      flex-shrink: 0;
      font-size: 14px;
      line-height: 1;
      transition: transform $duration-fast $ease-out;
    }

    .menu-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .menu-shortcut {
      flex-shrink: 0;
      font-family: $font-mono;
      font-size: 11px;
      color: var(--text-tertiary);
      padding: 2px 6px;
      background: var(--bg-sunken);
      border-radius: $radius-sm;
    }

    .menu-divider {
      height: 1px;
      margin: $spacing-1 $spacing-2;
      background: var(--border-subtle);
    }
  `]
})
export class ContextMenuComponent implements AfterViewInit, OnChanges {
  @Input() visible = false;
  @Input() position: ContextMenuPosition = { x: 0, y: 0 };
  @Input() actions: ContextMenuAction[] = [];
  @Output() actionSelected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  adjustedPosition: ContextMenuPosition = { x: 0, y: 0 };

  constructor(private elementRef: ElementRef) {}

  ngAfterViewInit() {
    this.adjustPosition();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['position'] || changes['visible']) {
      this.adjustPosition();
    }
  }

  private adjustPosition() {
    if (!this.visible) {
      this.adjustedPosition = this.position;
      return;
    }

    // Delay to allow DOM to render
    setTimeout(() => {
      const menu = this.elementRef.nativeElement.querySelector('.context-menu');
      if (!menu) {
        this.adjustedPosition = this.position;
        return;
      }

      const rect = menu.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let x = this.position.x;
      let y = this.position.y;

      // Adjust if menu would overflow right edge
      if (x + rect.width > viewportWidth - 8) {
        x = viewportWidth - rect.width - 8;
      }

      // Adjust if menu would overflow bottom edge
      if (y + rect.height > viewportHeight - 8) {
        y = viewportHeight - rect.height - 8;
      }

      // Ensure minimum position
      x = Math.max(8, x);
      y = Math.max(8, y);

      this.adjustedPosition = { x, y };
    });
  }

  @HostListener('document:click')
  onDocumentClick() {
    if (this.visible) {
      this.close();
    }
  }

  @HostListener('document:contextmenu')
  onDocumentContextMenu() {
    if (this.visible) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.visible) {
      this.close();
    }
  }

  onActionClick(action: ContextMenuAction) {
    if (!action.disabled) {
      this.actionSelected.emit(action.action);
      this.close();
    }
  }

  close() {
    this.visible = false;
    this.closed.emit();
  }
}

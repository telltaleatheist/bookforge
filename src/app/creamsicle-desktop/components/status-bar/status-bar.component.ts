import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface StatusBarItem {
  id: string;
  text?: string;
  icon?: string;
  tooltip?: string;
  clickable?: boolean;
}

@Component({
  selector: 'desktop-status-bar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <footer class="status-bar">
      <div class="status-left">
        @for (item of leftItems; track item.id) {
          @if (item.clickable) {
            <button
              class="status-item clickable"
              [title]="item.tooltip || ''"
              (click)="onItemClick(item)"
            >
              @if (item.icon) {
                <span class="item-icon">{{ item.icon }}</span>
              }
              @if (item.text) {
                <span class="item-text">{{ item.text }}</span>
              }
            </button>
          } @else {
            <span class="status-item" [title]="item.tooltip || ''">
              @if (item.icon) {
                <span class="item-icon">{{ item.icon }}</span>
              }
              @if (item.text) {
                <span class="item-text">{{ item.text }}</span>
              }
            </span>
          }
        }
        <ng-content select="[status-left]"></ng-content>
      </div>

      <div class="status-center">
        @if (centerText) {
          <span class="status-text">{{ centerText }}</span>
        }
        <ng-content select="[status-center]"></ng-content>
      </div>

      <div class="status-right">
        <ng-content select="[status-right]"></ng-content>
        @for (item of rightItems; track item.id) {
          @if (item.clickable) {
            <button
              class="status-item clickable"
              [title]="item.tooltip || ''"
              (click)="onItemClick(item)"
            >
              @if (item.icon) {
                <span class="item-icon">{{ item.icon }}</span>
              }
              @if (item.text) {
                <span class="item-text">{{ item.text }}</span>
              }
            </button>
          } @else {
            <span class="status-item" [title]="item.tooltip || ''">
              @if (item.icon) {
                <span class="item-icon">{{ item.icon }}</span>
              }
              @if (item.text) {
                <span class="item-text">{{ item.text }}</span>
              }
            </span>
          }
        }
      </div>
    </footer>
  `,
  styles: [`
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      display: block;
    }

    .status-bar {
      @include statusbar;
      position: relative;
    }

    .status-left,
    .status-center,
    .status-right {
      @include flex-center;
      gap: $spacing-3;
    }

    .status-left {
      justify-content: flex-start;
    }

    .status-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
    }

    .status-right {
      justify-content: flex-end;
    }

    .status-item {
      @include flex-center;
      gap: $spacing-1;
      padding: 0 $spacing-1;
      height: 18px;
      border-radius: $radius-sm;
      transition: $transition-colors;
      font-family: $font-body;
      font-size: $font-size-xs;
      color: var(--text-tertiary);

      &.clickable {
        @include button-reset;
        cursor: pointer;

        &:hover {
          background: var(--hover-bg);
          color: var(--text-secondary);
        }

        &:active {
          background: var(--active-bg);
        }
      }
    }

    .item-icon {
      font-size: 11px;
      line-height: 1;
      opacity: 0.8;
    }

    .status-text {
      color: var(--text-muted);
    }
  `]
})
export class StatusBarComponent {
  @Input() leftItems: StatusBarItem[] = [];
  @Input() rightItems: StatusBarItem[] = [];
  @Input() centerText?: string;

  @Output() itemClicked = new EventEmitter<StatusBarItem>();

  onItemClick(item: StatusBarItem) {
    this.itemClicked.emit(item);
  }
}

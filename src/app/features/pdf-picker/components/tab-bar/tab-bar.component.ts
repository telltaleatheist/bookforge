import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface DocumentTab {
  id: string;
  name: string;
  path: string;
  hasUnsavedChanges: boolean;
  icon?: string;
  closable?: boolean; // defaults to true
}

@Component({
  selector: 'app-tab-bar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tab-bar">
      <div class="tabs-scroll">
        @for (tab of tabs(); track tab.id) {
          <div
            class="tab"
            [class.active]="tab.id === activeTabId()"
            [class.permanent]="tab.closable === false"
            (click)="onTabClick(tab)"
            [title]="tab.path || tab.name"
          >
            <span class="tab-icon">{{ tab.icon || '📄' }}</span>
            <span class="tab-name">
              {{ tab.name }}
              @if (tab.hasUnsavedChanges) {
                <span class="unsaved-indicator">•</span>
              }
            </span>
            @if (tab.closable !== false) {
              <button
                class="tab-close"
                (click)="onCloseTab($event, tab)"
                title="Close (⌘W)"
              >
                ×
              </button>
            }
          </div>
        }
      </div>
      <button class="new-tab-btn" (click)="newTab.emit()" title="Open new PDF">
        +
      </button>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .tab-bar {
      display: flex;
      align-items: stretch;
      height: var(--ui-tab-height);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .tabs-scroll {
      flex: 1;
      display: flex;
      overflow-x: auto;
      overflow-y: hidden;

      &::-webkit-scrollbar {
        height: 4px;
      }

      &::-webkit-scrollbar-track {
        background: transparent;
      }

      &::-webkit-scrollbar-thumb {
        background: var(--border-default);
        border-radius: 2px;
      }
    }

    .tab {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: 0 var(--ui-spacing-md);
      min-width: 120px;
      max-width: 200px;
      border-right: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      position: relative;
      animation: tabSlideIn $duration-fast $ease-out both;

      &:hover {
        background: var(--hover-bg);

        .tab-close {
          opacity: 1;
        }
      }

      &:active {
        transform: scale(0.98);
      }

      &.active {
        background: var(--bg-surface);
        border-bottom: 2px solid var(--accent);
        margin-bottom: -1px;

        .tab-close {
          opacity: 1;
        }
      }
    }

    @keyframes tabSlideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .tab-icon {
      font-size: var(--ui-icon-size-sm);
      flex-shrink: 0;
    }

    .tab-name {
      flex: 1;
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .unsaved-indicator {
      color: var(--accent);
      font-weight: bold;
      margin-left: 2px;
    }

    .tab-close {
      width: var(--ui-btn-height-xs);
      height: var(--ui-btn-height-xs);
      border: none;
      border-radius: $radius-sm;
      background: transparent;
      color: var(--text-tertiary);
      font-size: var(--ui-font-base);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: all $duration-fast $ease-out;
      flex-shrink: 0;

      &:hover {
        background: var(--hover-bg);
        color: var(--text-primary);
      }
    }

    .new-tab-btn {
      width: var(--ui-tab-height);
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--ui-icon-size-sm);
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background: var(--hover-bg);
        color: var(--text-primary);
      }
    }
  `]
})
export class TabBarComponent {
  tabs = input.required<DocumentTab[]>();
  activeTabId = input.required<string | null>();

  tabSelected = output<DocumentTab>();
  tabClosed = output<DocumentTab>();
  newTab = output<void>();

  onTabClick(tab: DocumentTab): void {
    this.tabSelected.emit(tab);
  }

  onCloseTab(event: Event, tab: DocumentTab): void {
    event.stopPropagation();
    this.tabClosed.emit(tab);
  }
}

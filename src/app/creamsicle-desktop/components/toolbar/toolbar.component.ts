import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface ToolbarItem {
  id: string;
  type: 'button' | 'toggle' | 'dropdown' | 'divider' | 'spacer' | 'search';
  icon?: string;
  label?: string;
  tooltip?: string;
  active?: boolean;
  disabled?: boolean;
  items?: ToolbarDropdownItem[]; // for dropdown type
}

export interface ToolbarDropdownItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  divider?: boolean;
}

@Component({
  selector: 'desktop-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toolbar" [class.bordered]="bordered">
      @for (item of items; track item.id) {
        @switch (item.type) {
          @case ('button') {
            <button
              class="toolbar-button"
              [class.icon-only]="!item.label"
              [class.disabled]="item.disabled"
              [disabled]="item.disabled"
              [title]="item.tooltip || item.label || ''"
              (click)="onItemClick(item)"
            >
              @if (item.icon) {
                <span class="button-icon">{{ item.icon }}</span>
              }
              @if (item.label) {
                <span class="button-label">{{ item.label }}</span>
              }
            </button>
          }
          @case ('toggle') {
            <button
              class="toolbar-button toggle"
              [class.active]="item.active"
              [class.icon-only]="!item.label"
              [class.disabled]="item.disabled"
              [disabled]="item.disabled"
              [title]="item.tooltip || item.label || ''"
              (click)="onToggleClick(item)"
            >
              @if (item.icon) {
                <span class="button-icon">{{ item.icon }}</span>
              }
              @if (item.label) {
                <span class="button-label">{{ item.label }}</span>
              }
            </button>
          }
          @case ('dropdown') {
            <div class="toolbar-dropdown" [class.disabled]="item.disabled">
              <button
                class="toolbar-button dropdown-trigger"
                [class.icon-only]="!item.label"
                [disabled]="item.disabled"
                [title]="item.tooltip || ''"
                (click)="toggleDropdown(item)"
              >
                @if (item.icon) {
                  <span class="button-icon">{{ item.icon }}</span>
                }
                @if (item.label) {
                  <span class="button-label">{{ item.label }}</span>
                }
                <span class="dropdown-chevron">
                  <svg width="8" height="8" viewBox="0 0 8 8">
                    <path d="M1.5 2.5L4 5L6.5 2.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
                  </svg>
                </span>
              </button>
              @if (activeDropdown === item.id && item.items) {
                <div class="dropdown-menu">
                  @for (dropdownItem of item.items; track dropdownItem.id) {
                    @if (dropdownItem.divider) {
                      <div class="dropdown-divider"></div>
                    } @else {
                      <button
                        class="dropdown-item"
                        [class.disabled]="dropdownItem.disabled"
                        [disabled]="dropdownItem.disabled"
                        (click)="onDropdownItemClick(item, dropdownItem)"
                      >
                        @if (dropdownItem.icon) {
                          <span class="item-icon">{{ dropdownItem.icon }}</span>
                        }
                        <span class="item-label">{{ dropdownItem.label }}</span>
                        @if (dropdownItem.shortcut) {
                          <span class="item-shortcut">{{ dropdownItem.shortcut }}</span>
                        }
                      </button>
                    }
                  }
                </div>
              }
            </div>
          }
          @case ('search') {
            <div class="toolbar-search">
              <input
                type="text"
                class="search-input"
                placeholder="Search..."
                (input)="onSearchInput($event)"
              />
            </div>
          }
          @case ('divider') {
            <div class="toolbar-divider"></div>
          }
          @case ('spacer') {
            <div class="toolbar-spacer"></div>
          }
        }
      }

      <!-- Slot for custom content -->
      <ng-content></ng-content>
    </div>
  `,
  styleUrl: './toolbar.component.scss'
})
export class ToolbarComponent {
  @Input() items: ToolbarItem[] = [];
  @Input() bordered = true;

  @Output() itemClicked = new EventEmitter<ToolbarItem>();
  @Output() toggleChanged = new EventEmitter<{ item: ToolbarItem; active: boolean }>();
  @Output() dropdownItemClicked = new EventEmitter<{ parent: ToolbarItem; item: ToolbarDropdownItem }>();
  @Output() searchChanged = new EventEmitter<string>();

  activeDropdown: string | null = null;

  onItemClick(item: ToolbarItem) {
    this.activeDropdown = null;
    this.itemClicked.emit(item);
  }

  onToggleClick(item: ToolbarItem) {
    item.active = !item.active;
    this.toggleChanged.emit({ item, active: item.active });
    // Also emit itemClicked so consumers can handle all clicks uniformly
    this.itemClicked.emit(item);
  }

  toggleDropdown(item: ToolbarItem) {
    this.activeDropdown = this.activeDropdown === item.id ? null : item.id;
  }

  onDropdownItemClick(parent: ToolbarItem, item: ToolbarDropdownItem) {
    this.activeDropdown = null;
    this.dropdownItemClicked.emit({ parent, item });
  }

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.searchChanged.emit(value);
  }
}

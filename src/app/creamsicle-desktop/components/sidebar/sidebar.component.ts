import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface SidebarSection {
  id: string;
  title?: string;
  collapsible?: boolean;
  items: SidebarItem[];
}

export interface SidebarItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
  disabled?: boolean;
  children?: SidebarItem[];
}

@Component({
  selector: 'desktop-sidebar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <aside class="sidebar" [style.width.px]="width">
      <!-- Search (optional) -->
      @if (showSearch) {
        <div class="sidebar-search">
          <input
            type="text"
            class="search-input"
            placeholder="Search..."
            [value]="searchQuery()"
            (input)="onSearchInput($event)"
          />
        </div>
      }

      <!-- Sections -->
      <nav class="sidebar-content">
        @for (section of sections; track section.id) {
          <div class="sidebar-section">
            @if (section.title) {
              <div
                class="section-header"
                [class.collapsible]="section.collapsible"
                (click)="section.collapsible && toggleSection(section.id)"
              >
                <span class="section-title">{{ section.title }}</span>
                @if (section.collapsible) {
                  <span class="section-chevron" [class.collapsed]="isSectionCollapsed(section.id)">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                      <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
                    </svg>
                  </span>
                }
              </div>
            }

            @if (!isSectionCollapsed(section.id)) {
              <div class="section-items">
                @for (item of section.items; track item.id) {
                  <button
                    class="sidebar-item"
                    [class.selected]="selectedId() === item.id"
                    [class.disabled]="item.disabled"
                    [disabled]="item.disabled"
                    (click)="selectItem(item)"
                  >
                    @if (item.icon) {
                      <span class="item-icon">{{ item.icon }}</span>
                    }
                    <span class="item-label">{{ item.label }}</span>
                    @if (item.badge) {
                      <span class="item-badge">{{ item.badge }}</span>
                    }
                  </button>
                }
              </div>
            }
          </div>
        }
      </nav>

      <!-- Footer (optional) -->
      @if (showFooter) {
        <div class="sidebar-footer">
          <ng-content select="[sidebar-footer]"></ng-content>
        </div>
      }

      <!-- Resize Handle -->
      @if (resizable) {
        <div
          class="resize-handle"
          (mousedown)="startResize($event)"
        ></div>
      }
    </aside>
  `,
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  @Input() sections: SidebarSection[] = [];
  @Input() width = 220;
  @Input() minWidth = 150;
  @Input() maxWidth = 350;
  @Input() showSearch = false;
  @Input() showFooter = false;
  @Input() resizable = true;

  @Output() itemSelected = new EventEmitter<SidebarItem>();
  @Output() searchChanged = new EventEmitter<string>();
  @Output() widthChanged = new EventEmitter<number>();

  selectedId = signal<string | null>(null);
  searchQuery = signal('');
  collapsedSections = signal<Set<string>>(new Set());

  private resizing = false;
  private startX = 0;
  private startWidth = 0;

  selectItem(item: SidebarItem) {
    if (item.disabled) return;
    this.selectedId.set(item.id);
    this.itemSelected.emit(item);
  }

  onSearchInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
    this.searchChanged.emit(value);
  }

  toggleSection(sectionId: string) {
    this.collapsedSections.update(set => {
      const newSet = new Set(set);
      if (newSet.has(sectionId)) {
        newSet.delete(sectionId);
      } else {
        newSet.add(sectionId);
      }
      return newSet;
    });
  }

  isSectionCollapsed(sectionId: string): boolean {
    return this.collapsedSections().has(sectionId);
  }

  startResize(event: MouseEvent) {
    this.resizing = true;
    this.startX = event.clientX;
    this.startWidth = this.width;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.resizing) return;
      const delta = e.clientX - this.startX;
      const newWidth = Math.min(this.maxWidth, Math.max(this.minWidth, this.startWidth + delta));
      this.width = newWidth;
      this.widthChanged.emit(newWidth);
    };

    const onMouseUp = () => {
      this.resizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }
}

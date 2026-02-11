import { Component, Input, Output, EventEmitter, signal, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subject, fromEvent, merge } from 'rxjs';
import { takeUntil, filter } from 'rxjs/operators';

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
    <aside class="sidebar" [style.width.px]="width" [class.resizing]="resizing">
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
          (mousedown)="onResizeHandleMouseDown($event)"
        ></div>
      }
    </aside>
  `,
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent implements OnDestroy {
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

  resizing = false;
  private startX = 0;
  private startWidth = 0;

  private destroy$ = new Subject<void>();
  private resizeStop$ = new Subject<void>();

  constructor(private cdr: ChangeDetectorRef) {}

  ngOnDestroy(): void {
    this.stopResize();
    this.destroy$.next();
    this.destroy$.complete();
  }

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

  onResizeHandleMouseDown(event: MouseEvent): void {
    event.preventDefault();
    this.resizing = true;
    this.startX = event.clientX;
    this.startWidth = this.width;

    // Mouse move - track position
    fromEvent<MouseEvent>(document, 'mousemove')
      .pipe(takeUntil(this.resizeStop$))
      .subscribe((e) => {
        const delta = e.clientX - this.startX;
        const newWidth = Math.min(this.maxWidth, Math.max(this.minWidth, this.startWidth + delta));
        this.width = newWidth;
        this.widthChanged.emit(newWidth);
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
      this.resizing = false;
      this.resizeStop$.next();
      this.cdr.detectChanges();
    }
  }
}

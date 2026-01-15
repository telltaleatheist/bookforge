import { Component, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Category, TextBlock } from '../../services/pdf.service';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

@Component({
  selector: 'app-categories-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Categories</h3>
      <div class="panel-actions">
        <desktop-button variant="ghost" size="xs" (click)="clearSelection.emit()">Clear</desktop-button>
      </div>
    </div>

    <!-- Find & Create Custom Category Button -->
    <div class="create-category-section">
      <desktop-button
        variant="secondary"
        size="sm"
        icon="🔍"
        [disabled]="!hasBlocks()"
        (click)="openCustomCategory.emit()"
      >
        Find & Create Category
      </desktop-button>
      <p class="create-hint">Use regex patterns to find and group text blocks</p>
    </div>

    <div class="categories-list">
      @if (categories().length === 0) {
        <div class="empty-state">
          <p>Load a PDF to see categories</p>
        </div>
      } @else {
        @for (cat of categories(); track cat.id) {
          <div
            class="category-item"
            [class.has-selection]="getSelectedCount(cat.id) > 0"
            (click)="onCategoryClick($event, cat.id)"
          >
            <div class="category-color" [style.background]="cat.color"></div>
            <div class="category-info">
              <div class="category-name">{{ cat.name }}</div>
              <div class="category-meta">
                {{ cat.block_count }} blocks, {{ cat.char_count | number }} chars
                @if (getSelectedCount(cat.id) > 0) {
                  <span class="selection-count">({{ getSelectedCount(cat.id) }} selected)</span>
                }
              </div>
              @if (cat.sample_text) {
                <div class="category-sample">"{{ cat.sample_text.substring(0, 60) }}..."</div>
              }
            </div>
          </div>
        }
      }
    </div>

    <div class="panel-footer">
      <div class="stats-row">
        <span>Included: <strong>{{ includedChars() | number }}</strong></span>
        <span>Excluded: <strong>{{ excludedChars() | number }}</strong></span>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      height: 100%;
      border-left: 1px solid var(--border-subtle);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      min-height: var(--ui-panel-header);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }

    .panel-title {
      font-size: var(--ui-font-lg);
      font-weight: $font-weight-semibold;
      margin: 0;
      color: var(--text-primary);
    }

    .panel-actions {
      display: flex;
      gap: var(--ui-spacing-xs);
    }

    .create-category-section {
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);

      desktop-button {
        width: 100%;
      }

      .create-hint {
        margin: var(--ui-spacing-sm) 0 0 0;
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
        text-align: center;
      }
    }

    .categories-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-sm);
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
    }

    .category-item {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      border-radius: $radius-md;
      margin-bottom: var(--ui-spacing-xs);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: all $duration-fast $ease-out;
      animation: slideInFromRight $duration-normal $ease-out both;

      &:hover {
        border-color: var(--border-default);
        background: var(--hover-bg);
        transform: translateX(-2px);
      }

      &:active {
        transform: scale(0.98);
      }

      &.has-selection {
        border-color: var(--accent);
        background: var(--accent-subtle);

        .category-color {
          box-shadow: 0 0 0 2px var(--accent);
        }
      }
    }

    @for $i from 1 through 20 {
      .category-item:nth-child(#{$i}) {
        animation-delay: #{$i * 30}ms;
      }
    }

    @keyframes slideInFromRight {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .category-color {
      width: var(--ui-icon-size-sm);
      height: var(--ui-icon-size-sm);
      border-radius: $radius-sm;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .category-info {
      flex: 1;
      min-width: 0;
    }

    .category-name {
      font-size: var(--ui-font-base);
      font-weight: $font-weight-medium;
      color: var(--text-primary);
      margin-bottom: 2px;
    }

    .category-meta {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .selection-count {
      color: var(--accent);
      font-weight: $font-weight-medium;
    }

    .category-sample {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      margin-top: var(--ui-spacing-xs);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-style: italic;
    }

    .panel-footer {
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }

    .stats-row {
      display: flex;
      justify-content: space-between;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);

      strong {
        color: var(--text-primary);
      }
    }
  `],
})
export class CategoriesPanelComponent {
  categories = input.required<Category[]>();
  blocks = input.required<TextBlock[]>();
  selectedBlockIds = input.required<string[]>();
  includedChars = input.required<number>();
  excludedChars = input.required<number>();

  // Click selects ALL blocks of this category (Cmd/Ctrl+click to add to selection)
  selectCategory = output<{ categoryId: string; additive: boolean }>();
  // Clear all selections
  clearSelection = output<void>();
  // Open custom category creator modal
  openCustomCategory = output<void>();

  // Check if blocks are available
  hasBlocks(): boolean {
    return this.blocks().length > 0;
  }

  // Compute selection counts per category
  private selectionCountsCache = computed(() => {
    const counts = new Map<string, number>();
    const selected = new Set(this.selectedBlockIds());
    for (const block of this.blocks()) {
      if (selected.has(block.id)) {
        counts.set(block.category_id, (counts.get(block.category_id) || 0) + 1);
      }
    }
    return counts;
  });

  getSelectedCount(categoryId: string): number {
    return this.selectionCountsCache().get(categoryId) || 0;
  }

  onCategoryClick(event: MouseEvent, categoryId: string): void {
    this.selectCategory.emit({
      categoryId,
      additive: event.metaKey || event.ctrlKey
    });
  }
}

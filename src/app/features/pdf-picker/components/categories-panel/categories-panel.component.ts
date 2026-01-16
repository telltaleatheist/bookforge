import { Component, input, output, computed, signal, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Category, TextBlock } from '../../services/pdf.service';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

interface RegexMatch {
  page: number;
  text: string;
}

@Component({
  selector: 'app-categories-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Categories</h3>
      <div class="panel-actions">
        <desktop-button variant="ghost" size="xs" (click)="selectAll.emit()">All</desktop-button>
        <desktop-button variant="ghost" size="xs" (click)="deselectAll.emit()">None</desktop-button>
      </div>
    </div>

    <!-- Create Custom Category Section (Collapsible) -->
    <div class="create-category-section">
      <button class="section-header" (click)="createSectionExpanded.set(!createSectionExpanded())">
        <span class="expand-icon">{{ createSectionExpanded() ? '▼' : '▶' }}</span>
        <span>Create Category</span>
      </button>
      @if (createSectionExpanded()) {
        <div class="section-content">
          <div class="create-buttons">
            <desktop-button
              variant="secondary"
              size="sm"
              icon="🎯"
              [disabled]="!hasBlocks()"
              (click)="enterSampleMode.emit()"
            >
              By Sample
            </desktop-button>
            <desktop-button
              variant="secondary"
              size="sm"
              icon=".*"
              [disabled]="!hasBlocks()"
              [class.active]="regexExpanded()"
              (click)="toggleRegexPanel()"
            >
              By Regex
            </desktop-button>
          </div>
        </div>

        <!-- Regex Form (nested collapsible) -->
        @if (regexExpanded()) {
      <div class="regex-form-section">
        <div class="form-group">
          <label>Category Name</label>
          <input
            type="text"
            [ngModel]="regexName()"
            (ngModelChange)="regexNameChange.emit($event)"
            placeholder="e.g., Footnotes"
          />
        </div>

        <div class="form-group">
          <label>Regex Pattern</label>
          <input
            type="text"
            [ngModel]="regexPattern()"
            (ngModelChange)="regexPatternChange.emit($event)"
            placeholder="e.g., \\[\\d+\\]"
          />
        </div>

        <div class="form-row">
          <div class="form-group half">
            <label>Min Font</label>
            <input
              type="number"
              [ngModel]="regexMinFontSize()"
              (ngModelChange)="regexMinFontSizeChange.emit($event)"
              placeholder="0"
            />
          </div>
          <div class="form-group half">
            <label>Max Font</label>
            <input
              type="number"
              [ngModel]="regexMaxFontSize() || null"
              (ngModelChange)="regexMaxFontSizeChange.emit($event || 0)"
              placeholder="any"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group half">
            <label>Min Baseline</label>
            <input
              type="number"
              step="0.1"
              [ngModel]="regexMinBaseline()"
              (ngModelChange)="regexMinBaselineChange.emit($event)"
              placeholder="any"
            />
          </div>
          <div class="form-group half">
            <label>Max Baseline</label>
            <input
              type="number"
              step="0.1"
              [ngModel]="regexMaxBaseline()"
              (ngModelChange)="regexMaxBaselineChange.emit($event)"
              placeholder="any"
            />
          </div>
        </div>

        <div class="form-row search-options">
          <label class="checkbox-label">
            <input
              type="checkbox"
              [checked]="regexLiteralMode()"
              (change)="regexLiteralModeChange.emit($any($event.target).checked)"
            />
            <span>Literal</span>
            <span class="option-hint">(escape special chars)</span>
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              [checked]="regexCaseSensitive()"
              (change)="regexCaseSensitiveChange.emit($any($event.target).checked)"
            />
            <span>Case sensitive</span>
          </label>
        </div>

        <!-- Collapsible Filters Section -->
        <div class="filters-section">
          <button class="filters-header" (click)="filtersExpanded.set(!filtersExpanded())">
            <span class="expand-icon">{{ filtersExpanded() ? '▼' : '▶' }}</span>
            <span>Filters</span>
            @if (hasActiveFilters()) {
              <span class="filter-badge">active</span>
            }
          </button>

          @if (filtersExpanded()) {
            <div class="filters-content">
              <!-- Categories Filter -->
              <div class="filter-group">
                <div class="filter-label">
                  <span>Categories</span>
                  <button class="select-toggle" (click)="toggleAllCategories()">
                    {{ allCategoriesSelected() ? 'None' : 'All' }}
                  </button>
                </div>
                <div class="filter-checkboxes">
                  @for (cat of categories(); track cat.id) {
                    <label class="filter-checkbox">
                      <input
                        type="checkbox"
                        [checked]="isCategoryInFilter(cat.id)"
                        (change)="toggleCategoryFilter(cat.id)"
                      />
                      <span class="cat-color" [style.background]="cat.color"></span>
                      <span>{{ cat.name }}</span>
                    </label>
                  }
                </div>
              </div>

              <!-- Pages Filter -->
              <div class="filter-group">
                <div class="filter-label">Pages</div>
                <select
                  class="page-filter-select"
                  [ngModel]="regexPageFilterType()"
                  (ngModelChange)="regexPageFilterTypeChange.emit($event)"
                >
                  <option value="all">All pages</option>
                  <option value="range">Page range</option>
                  <option value="even">Even pages only</option>
                  <option value="odd">Odd pages only</option>
                  <option value="specific">Specific pages</option>
                </select>

                @if (regexPageFilterType() === 'range') {
                  <div class="page-range-inputs">
                    <input
                      type="number"
                      min="1"
                      [ngModel]="regexPageRangeStart()"
                      (ngModelChange)="regexPageRangeStartChange.emit($event)"
                      placeholder="from"
                    />
                    <span>to</span>
                    <input
                      type="number"
                      min="1"
                      [ngModel]="regexPageRangeEnd()"
                      (ngModelChange)="regexPageRangeEndChange.emit($event)"
                      placeholder="to"
                    />
                  </div>
                }

                @if (regexPageFilterType() === 'specific') {
                  <input
                    type="text"
                    class="specific-pages-input"
                    [ngModel]="regexSpecificPages()"
                    (ngModelChange)="regexSpecificPagesChange.emit($event)"
                    placeholder="e.g., 1, 3, 10-15, 42"
                  />
                }
              </div>
            </div>
          }
        </div>

        <div class="form-group">
          <label>Color</label>
          <input
            type="color"
            [ngModel]="regexColor()"
            (ngModelChange)="regexColorChange.emit($event)"
          />
        </div>

        <div class="regex-preview">
          <div class="preview-header">
            <span>{{ regexMatchCount() }} matches</span>
            @if (regexMatchCount() > 5000) {
              <span class="preview-limit">(showing first 5000)</span>
            }
          </div>
          @if (regexMatches().length > 0) {
            <div class="preview-list">
              @for (match of regexMatches().slice(0, 20); track $index) {
                <div class="preview-item">
                  <span class="preview-page">p.{{ match.page + 1 }}</span>
                  <span class="preview-text">"{{ match.text }}"</span>
                </div>
              }
              @if (regexMatches().length > 20) {
                <div class="preview-more">...and {{ regexMatches().length - 20 }} more in preview</div>
              }
            </div>
          }
        </div>

        <div class="regex-actions">
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="!regexName() || (!isEditing() && regexMatchCount() === 0)"
            (click)="createRegexCategory.emit()"
          >
            {{ isEditing() ? 'Update' : 'Create' }} {{ regexMatchCount() > 0 ? '(' + regexMatchCount() + ')' : '' }}
          </desktop-button>
        </div>
      </div>
        }
      }
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
            [class.is-custom]="isCustomCategory(cat.id)"
            [class.is-enabled]="cat.enabled"
            (click)="onCategoryClick($event, cat.id)"
            (contextmenu)="onCategoryRightClick($event, cat.id)"
          >
            <div class="category-color" [style.background]="cat.color"></div>
            <div class="category-info">
              <div class="category-name">
                {{ cat.name }}
                @if (isCustomCategory(cat.id)) {
                  <span class="custom-badge">custom</span>
                }
              </div>
              <div class="category-meta">
                {{ cat.block_count }} {{ isCustomCategory(cat.id) ? 'matches' : 'blocks' }}, {{ cat.char_count | number }} chars
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

    <!-- Context Menu -->
    @if (contextMenu()) {
      <div
        class="context-menu-backdrop"
        (click)="closeContextMenu()"
        (contextmenu)="closeContextMenu(); $event.preventDefault()"
      ></div>
      <div
        class="context-menu"
        [style.left.px]="contextMenu()!.x"
        [style.top.px]="contextMenu()!.y"
      >
        <button class="context-menu-item" (click)="onContextMenuSelectInverse()">
          <span class="context-menu-icon">🔄</span>
          Select Inverse
        </button>
        @if (isCustomCategory(contextMenu()!.categoryId)) {
          <button class="context-menu-item" (click)="onContextMenuEdit()">
            <span class="context-menu-icon">✏️</span>
            Edit Category
          </button>
          <button class="context-menu-item danger" (click)="onContextMenuDelete()">
            <span class="context-menu-icon">🗑</span>
            Delete Category
          </button>
        }
      </div>
    }

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
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);

      .section-header {
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--ui-spacing-xs);
        padding: var(--ui-spacing-sm) var(--ui-spacing-md);
        background: transparent;
        border: none;
        cursor: pointer;
        font-size: var(--ui-font-sm);
        font-weight: $font-weight-medium;
        color: var(--text-secondary);
        text-align: left;

        &:hover {
          background: var(--hover-bg);
          color: var(--text-primary);
        }

        .expand-icon {
          font-size: 8px;
          width: 12px;
        }
      }

      .section-content {
        padding: 0 var(--ui-spacing-md) var(--ui-spacing-sm);
      }

      .create-buttons {
        display: flex;
        gap: var(--ui-spacing-sm);

        desktop-button {
          flex: 1;

          &.active {
            background: var(--accent-subtle);
            border-color: var(--accent);
          }
        }
      }
    }

    .regex-form-section {
      padding: var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      animation: slideDown 0.2s ease-out;

      .form-group {
        margin-bottom: var(--ui-spacing-sm);

        label {
          display: block;
          font-size: var(--ui-font-xs);
          font-weight: $font-weight-medium;
          color: var(--text-secondary);
          margin-bottom: 2px;
        }

        input[type="text"],
        input[type="number"] {
          width: 100%;
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          border: 1px solid var(--border-default);
          border-radius: $radius-sm;
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: var(--ui-font-sm);

          &:focus {
            outline: none;
            border-color: var(--accent);
          }

          &::placeholder {
            color: var(--text-tertiary);
          }
        }

        input[type="color"] {
          width: 40px;
          height: 24px;
          border: 1px solid var(--border-default);
          border-radius: $radius-sm;
          cursor: pointer;
          padding: 0;
        }
      }

      .form-row {
        display: flex;
        gap: var(--ui-spacing-sm);

        .half {
          flex: 1;
        }

        &.search-options {
          flex-wrap: wrap;
          margin-bottom: var(--ui-spacing-sm);

          .checkbox-label {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: var(--ui-font-xs);
            color: var(--text-secondary);
            cursor: pointer;

            input[type="checkbox"] {
              width: 14px;
              height: 14px;
              margin: 0;
              cursor: pointer;
              accent-color: var(--accent);
            }

            .option-hint {
              color: var(--text-tertiary);
              font-size: 10px;
            }
          }
        }
      }

      .filters-section {
        margin: var(--ui-spacing-sm) 0;
        border: 1px solid var(--border-subtle);
        border-radius: $radius-sm;
        overflow: hidden;

        .filters-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: var(--ui-spacing-xs);
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          background: var(--bg-surface);
          border: none;
          cursor: pointer;
          font-size: var(--ui-font-xs);
          color: var(--text-secondary);
          text-align: left;

          &:hover {
            background: var(--hover-bg);
          }

          .expand-icon {
            font-size: 8px;
            width: 12px;
          }

          .filter-badge {
            margin-left: auto;
            padding: 1px 6px;
            background: var(--accent);
            color: white;
            border-radius: 8px;
            font-size: 9px;
            font-weight: 600;
          }
        }

        .filters-content {
          padding: var(--ui-spacing-sm);
          border-top: 1px solid var(--border-subtle);
          background: var(--bg-sunken);
        }

        .filter-group {
          margin-bottom: var(--ui-spacing-sm);

          &:last-child {
            margin-bottom: 0;
          }
        }

        .filter-label {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: var(--ui-font-xs);
          font-weight: 500;
          color: var(--text-secondary);
          margin-bottom: var(--ui-spacing-xs);

          .select-toggle {
            padding: 2px 6px;
            font-size: 9px;
            background: var(--bg-surface);
            border: 1px solid var(--border-default);
            border-radius: $radius-sm;
            cursor: pointer;
            color: var(--text-secondary);

            &:hover {
              background: var(--hover-bg);
            }
          }
        }

        .filter-checkboxes {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 120px;
          overflow-y: auto;
        }

        .filter-checkbox {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: var(--ui-font-xs);
          color: var(--text-primary);
          cursor: pointer;

          input[type="checkbox"] {
            width: 12px;
            height: 12px;
            margin: 0;
            accent-color: var(--accent);
          }

          .cat-color {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            flex-shrink: 0;
          }
        }

        .page-filter-select {
          width: 100%;
          padding: var(--ui-spacing-xs);
          border: 1px solid var(--border-default);
          border-radius: $radius-sm;
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: var(--ui-font-xs);
          cursor: pointer;

          &:focus {
            outline: none;
            border-color: var(--accent);
          }
        }

        .page-range-inputs {
          display: flex;
          align-items: center;
          gap: var(--ui-spacing-xs);
          margin-top: var(--ui-spacing-xs);

          input {
            flex: 1;
            padding: var(--ui-spacing-xs);
            border: 1px solid var(--border-default);
            border-radius: $radius-sm;
            background: var(--bg-surface);
            color: var(--text-primary);
            font-size: var(--ui-font-xs);
            width: 60px;

            &:focus {
              outline: none;
              border-color: var(--accent);
            }
          }

          span {
            color: var(--text-tertiary);
            font-size: var(--ui-font-xs);
          }
        }

        .specific-pages-input {
          width: 100%;
          margin-top: var(--ui-spacing-xs);
          padding: var(--ui-spacing-xs);
          border: 1px solid var(--border-default);
          border-radius: $radius-sm;
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: var(--ui-font-xs);

          &:focus {
            outline: none;
            border-color: var(--accent);
          }

          &::placeholder {
            color: var(--text-tertiary);
          }
        }
      }

      .regex-preview {
        margin-top: var(--ui-spacing-sm);
        border: 1px solid var(--border-subtle);
        border-radius: $radius-sm;
        overflow: hidden;

        .preview-header {
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          background: var(--bg-surface);
          font-size: var(--ui-font-xs);
          color: var(--text-secondary);
          border-bottom: 1px solid var(--border-subtle);
          display: flex;
          gap: var(--ui-spacing-xs);
          align-items: center;

          .preview-limit {
            color: var(--text-tertiary);
            font-style: italic;
          }
        }

        .preview-list {
          max-height: 120px;
          overflow-y: auto;
        }

        .preview-item {
          display: flex;
          gap: var(--ui-spacing-xs);
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          font-size: 10px;
          border-bottom: 1px solid var(--border-subtle);

          &:last-child {
            border-bottom: none;
          }

          .preview-page {
            color: #ff7b54;
            font-weight: 600;
            flex-shrink: 0;
            width: 32px;
          }

          .preview-text {
            color: var(--text-primary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
        }

        .preview-more {
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          font-size: 10px;
          color: var(--text-tertiary);
          font-style: italic;
        }
      }

      .regex-actions {
        margin-top: var(--ui-spacing-sm);
        display: flex;
        justify-content: flex-end;
      }
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
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

    .custom-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: $font-weight-medium;
      margin-left: var(--ui-spacing-xs);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    // Custom category enabled state - lights up like regular categories with selection
    .category-item.is-custom.is-enabled {
      border-color: var(--accent);
      background: var(--accent-subtle);

      .category-color {
        box-shadow: 0 0 0 2px var(--accent);
      }
    }

    // Custom category disabled state - dimmed
    .category-item.is-custom:not(.is-enabled) {
      opacity: 0.5;

      .category-color {
        opacity: 0.4;
      }
    }

    // Context menu
    .context-menu-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 999;
    }

    .context-menu {
      position: fixed;
      z-index: 1000;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      padding: var(--ui-spacing-xs);
      min-width: 160px;
    }

    .context-menu-item {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      width: 100%;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      text-align: left;
      cursor: pointer;
      border-radius: $radius-sm;
      transition: background $duration-fast;

      &:hover {
        background: var(--hover-bg);
      }

      &.danger {
        color: var(--error);

        &:hover {
          background: var(--error-subtle);
        }
      }
    }

    .context-menu-icon {
      font-size: 14px;
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

  // Regex form inputs
  regexName = input<string>('');
  regexPattern = input<string>('');
  regexColor = input<string>('#E91E63');
  regexMinFontSize = input<number>(0);
  regexMaxFontSize = input<number>(0);
  regexMinBaseline = input<number | null>(null);
  regexMaxBaseline = input<number | null>(null);
  regexCaseSensitive = input<boolean>(false);
  regexLiteralMode = input<boolean>(true);
  regexMatches = input<RegexMatch[]>([]);
  regexMatchCount = input<number>(0);
  isEditing = input<boolean>(false);  // True when editing existing category

  // Filter inputs
  regexCategoryFilter = input<string[]>([]);  // Empty = all categories
  regexPageFilterType = input<'all' | 'range' | 'even' | 'odd' | 'specific'>('all');
  regexPageRangeStart = input<number>(1);
  regexPageRangeEnd = input<number>(1);
  regexSpecificPages = input<string>('');

  // Click selects ALL blocks of this category (Cmd/Ctrl+click to add to selection)
  selectCategory = output<{ categoryId: string; additive: boolean }>();
  // Select inverse - toggle selection of all blocks in category
  selectInverse = output<string>();
  // Select all blocks
  selectAll = output<void>();
  // Deselect all blocks
  deselectAll = output<void>();
  // Enter sample mode to create custom category
  enterSampleMode = output<void>();
  // Delete a custom category
  deleteCategory = output<string>();
  // Edit a custom category (load into form)
  editCategory = output<string>();
  // Toggle category enabled state
  toggleCategory = output<string>();

  // Regex form outputs
  regexNameChange = output<string>();
  regexPatternChange = output<string>();
  regexColorChange = output<string>();
  regexMinFontSizeChange = output<number>();
  regexMaxFontSizeChange = output<number>();
  regexMinBaselineChange = output<number | null>();
  regexMaxBaselineChange = output<number | null>();
  regexCaseSensitiveChange = output<boolean>();
  regexLiteralModeChange = output<boolean>();
  createRegexCategory = output<void>();
  regexExpandedChange = output<boolean>();

  // Filter outputs
  regexCategoryFilterChange = output<string[]>();
  regexPageFilterTypeChange = output<'all' | 'range' | 'even' | 'odd' | 'specific'>();
  regexPageRangeStartChange = output<number>();
  regexPageRangeEndChange = output<number>();
  regexSpecificPagesChange = output<string>();

  // Local state
  readonly createSectionExpanded = signal(false);
  readonly regexExpanded = signal(false);
  readonly filtersExpanded = signal(false);
  readonly contextMenu = signal<{ x: number; y: number; categoryId: string } | null>(null);

  // Check if any filters are active (not default)
  // Default is all categories selected (filter contains all IDs)
  hasActiveFilters(): boolean {
    const filter = this.regexCategoryFilter();
    const allCount = this.categories().length;
    const categoryFilterActive = filter.length !== allCount;
    return categoryFilterActive || this.regexPageFilterType() !== 'all';
  }

  // Check if all categories are selected
  allCategoriesSelected(): boolean {
    const filter = this.regexCategoryFilter();
    return filter.length === this.categories().length;
  }

  // Check if no categories are selected
  noCategoriesSelected(): boolean {
    return this.regexCategoryFilter().length === 0;
  }

  // Check if a category is in the filter
  isCategoryInFilter(categoryId: string): boolean {
    return this.regexCategoryFilter().includes(categoryId);
  }

  // Toggle a category in the filter
  toggleCategoryFilter(categoryId: string): void {
    const currentFilter = this.regexCategoryFilter();

    if (currentFilter.includes(categoryId)) {
      // Remove from filter (can result in empty array = none selected)
      const newFilter = currentFilter.filter(id => id !== categoryId);
      this.regexCategoryFilterChange.emit(newFilter);
    } else {
      // Add to filter
      const newFilter = [...currentFilter, categoryId];
      this.regexCategoryFilterChange.emit(newFilter);
    }
  }

  // Toggle all categories on/off
  toggleAllCategories(): void {
    if (this.allCategoriesSelected()) {
      // Deselect all
      this.regexCategoryFilterChange.emit([]);
    } else {
      // Select all
      const allCategories = this.categories().map(c => c.id);
      this.regexCategoryFilterChange.emit(allCategories);
    }
  }

  toggleRegexPanel(): void {
    const newState = !this.regexExpanded();
    this.regexExpanded.set(newState);
    this.regexExpandedChange.emit(newState);
  }

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
    // Both custom and regular categories use the same pattern:
    // Click = add/enable, Cmd/Ctrl+click = remove/disable
    this.selectCategory.emit({
      categoryId,
      additive: event.metaKey || event.ctrlKey
    });
  }

  isCustomCategory(categoryId: string): boolean {
    return categoryId.startsWith('custom_sample_') || categoryId.startsWith('custom_regex_');
  }

  onCategoryRightClick(event: MouseEvent, categoryId: string): void {
    event.preventDefault();
    this.contextMenu.set({
      x: event.clientX,
      y: event.clientY,
      categoryId
    });
  }

  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  onContextMenuSelectInverse(): void {
    const menu = this.contextMenu();
    if (menu) {
      this.selectInverse.emit(menu.categoryId);
      this.closeContextMenu();
    }
  }

  onContextMenuDelete(): void {
    const menu = this.contextMenu();
    if (menu) {
      this.deleteCategory.emit(menu.categoryId);
      this.closeContextMenu();
    }
  }

  onContextMenuEdit(): void {
    const menu = this.contextMenu();
    if (menu) {
      this.editCategory.emit(menu.categoryId);
      this.closeContextMenu();
      // Expand the create section and regex panel
      this.createSectionExpanded.set(true);
      this.regexExpanded.set(true);
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.closeContextMenu();
  }
}

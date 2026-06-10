import { Component, input, output, computed, signal, HostListener, ChangeDetectionStrategy, ElementRef, inject, effect, Pipe, PipeTransform } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Category, TextBlock } from '../../services/pdf.service';
import { ClassificationThresholds, CategoryBaselines } from '../../services/category-learner';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

@Pipe({ name: 'safeHtml', standalone: true })
class SafeHtmlPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);
  transform(value: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(value);
  }
}

interface RegexMatch {
  page: number;
  text: string;
}

@Component({
  selector: 'app-categories-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, SafeHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!analysisOnly()) {
    <div class="panel-header">
      <h3 class="panel-title">Categories</h3>
      <div class="panel-actions">
        <desktop-button variant="ghost" size="xs" (click)="selectAll.emit()">All</desktop-button>
        <desktop-button variant="ghost" size="xs" (click)="deselectAll.emit()">None</desktop-button>
      </div>
    </div>
    }

    @if (!analysisOnly()) {
    <!-- Create Custom Category Section (Collapsible) -->
    <div class="create-category-section">
      <button class="section-header" (click)="toggleCreateSection()">
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
          <label>Pattern Presets</label>
          <select
            class="preset-select"
            [ngModel]="selectedPreset()"
            (ngModelChange)="onPresetChange($event)"
          >
            <option value="">Custom pattern...</option>
            @for (preset of patternPresets; track preset.value) {
              <option [value]="preset.value">{{ preset.label }}</option>
            }
          </select>
        </div>

        <div class="form-group">
          <label>Regex Pattern</label>
          <input
            type="text"
            [ngModel]="regexPattern()"
            (ngModelChange)="onPatternChange($event)"
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
            @if (regexMatchCount() > 10000) {
              <span class="preview-limit">(showing first 10000)</span>
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
    }

    @if (!analysisOnly() && baselines()) {
      <div class="baselines-info">
        Body font: {{ baselines()!.bodySize }}pt {{ baselines()!.bodyFont }}
        @if (baselines()!.bodyIsItalic) { | Italic: Yes } @else { | Italic: No }
      </div>
    }

    @if (!analysisOnly()) {
      <div class="redetect-section">
        <div class="redetect-actions">
          <desktop-button
            variant="primary"
            size="sm"
            (click)="recategorize.emit()"
          >
            Re-categorize
          </desktop-button>
          <desktop-button
            variant="secondary"
            size="sm"
            (click)="mergeBlocks.emit()"
          >
            Merge Blocks
          </desktop-button>
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="resetThresholds.emit()"
          >
            Reset Defaults
          </desktop-button>
        </div>
        @if (categoryCorrections().size > 0) {
          <p class="redetect-hint">{{ categoryCorrections().size }} correction{{ categoryCorrections().size !== 1 ? 's' : '' }} — re-categorize to propagate.</p>
          <div class="redetect-actions">
            <desktop-button variant="ghost" size="sm" (click)="clearCorrections.emit()">
              Clear Corrections
            </desktop-button>
          </div>
        } @else {
          <p class="redetect-hint">Correct a few blocks, then re-categorize to fix the rest.</p>
        }
      </div>
    }

    <div class="categories-list">
      @if (analysisOnly()) {
        <!-- Analysis mode: tabs for Flags and Search -->
        <div class="analysis-tabs">
          <button
            class="analysis-tab"
            [class.active]="analysisTab() === 'flags'"
            (click)="analysisTab.set('flags')"
          >
            Flags
            @if (analysisFlags().length > 0) {
              <span class="tab-badge">{{ analysisFlags().length }}</span>
            }
          </button>
          <button
            class="analysis-tab"
            [class.active]="analysisTab() === 'search'"
            (click)="analysisTab.set('search')"
          >
            Search
            @if (searchResults().length > 0) {
              <span class="tab-badge">{{ searchResults().length }}</span>
            }
          </button>
        </div>

        @if (analysisTab() === 'flags') {
          <div class="analysis-section">
            @if (analysisFlags().length > 0) {
              <!-- Color legend -->
              <div class="analysis-legend">
                @for (cat of analysisCategories(); track cat.id) {
                  @if (cat.flagCount > 0) {
                    <div class="legend-item">
                      <span class="legend-color" [style.background]="cat.color"></span>
                      <span class="legend-name">{{ cat.name }}</span>
                      <span class="legend-count">{{ cat.flagCount }}</span>
                    </div>
                  }
                }
              </div>

              <!-- Flat chronological list -->
              @for (flag of sortedFlags(); track $index) {
                <div
                  class="analysis-flag"
                  [class.expanded]="expandedFlagIndex() === $index"
                  [class.clickable]="flag.page !== undefined"
                  [class.selected]="flag === selectedFlag()"
                  [style.border-left-color]="flag.categoryColor"
                  (click)="onFlagItemClick(flag, $index)"
                >
                  <div class="flag-header">
                    <span class="category-dot" [style.background]="flag.categoryColor"></span>
                    <span class="flag-category-label">{{ flag.categoryName }}</span>
                    <span class="flag-chapter">{{ flag.chapterTitle }}</span>
                    @if (flag.page !== undefined) {
                      <span class="flag-page">p.{{ flag.page + 1 }}</span>
                    }
                  </div>
                  @if (expandedFlagIndex() === $index) {
                    <div class="flag-quote-full">"{{ flag.quote }}"</div>
                    <div class="flag-description-full">{{ flag.description }}</div>
                  } @else {
                    <div class="flag-quote">"{{ flag.quote.length > 80 ? flag.quote.substring(0, 80) + '...' : flag.quote }}"</div>
                  }
                </div>
              }
            } @else {
              <div class="empty-state">
                <p>No analysis results</p>
                <p class="empty-hint">Run content analysis from the version picker to see flags here</p>
              </div>
            }
          </div>
        } @else {
          <!-- Search tab -->
          <div class="search-section">
            <div class="search-input-wrapper">
              <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                type="text"
                class="search-input"
                placeholder="Search text..."
                [ngModel]="searchQuery()"
                (ngModelChange)="onSearchQueryChange($event)"
              />
              @if (searchQuery()) {
                <button class="clear-search" (click)="clearSearch()">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              }
            </div>
            <div class="search-options">
              <label class="search-option" title="Match words consecutively as a phrase">
                <input type="checkbox" [ngModel]="searchPhraseMode()" (ngModelChange)="searchPhraseMode.set($event)" />
                Phrase
              </label>
              <label class="search-option" title="Match similar-sounding words (Soundex + Levenshtein)">
                <input type="checkbox" [ngModel]="searchPhoneticMode()" (ngModelChange)="searchPhoneticMode.set($event)" />
                Phonetic
              </label>
            </div>
            @if (searchQuery()) {
              <div class="search-status">
                {{ searchResults().length }} {{ searchResults().length === 1 ? 'match' : 'matches' }}
              </div>
            }
            <div class="search-results-list">
              @for (result of searchResults().slice(0, 200); track $index) {
                <div class="search-result clickable" (click)="onSearchResultClick(result)">
                  <span class="result-page">p.{{ result.page + 1 }}</span>
                  <span class="result-text" [innerHTML]="result.highlightedText | safeHtml"></span>
                </div>
              }
              @if (searchResults().length > 200) {
                <div class="search-more">...and {{ searchResults().length - 200 }} more</div>
              }
            </div>
          </div>
        }
      } @else if (categories().length === 0) {
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
            [class.has-thresholds-open]="thresholdExpanded() === cat.id"
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
                @if (hasThresholdControls(cat.id) && thresholds()) {
                  <button class="threshold-chevron" (click)="toggleThresholdPanel($event, cat.id)" title="Tune thresholds">
                    {{ thresholdExpanded() === cat.id ? '▼' : '▶' }}
                  </button>
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
          @if (thresholdExpanded() === cat.id && thresholds()) {
            <div class="threshold-panel" [style.border-left-color]="cat.color">
              @for (control of getThresholdControls(cat.id); track control.path) {
                <div class="threshold-row">
                  <label class="threshold-label">{{ control.label }}</label>
                  <input
                    type="range"
                    [min]="control.min"
                    [max]="control.max"
                    [step]="control.step"
                    [value]="getThresholdValue(control.path)"
                    [style.accent-color]="cat.color"
                    (input)="onThresholdInput($event, control.path)"
                    (click)="$event.stopPropagation()"
                  />
                  <span class="threshold-value">{{ formatThresholdValue(control.path, control.format) }}</span>
                </div>
              }
            </div>
          }
        }
      }

    </div>

    @if (!analysisOnly()) {
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
    }
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

    .baselines-info {
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      font-family: monospace;
    }

    .redetect-section {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);

      .redetect-hint {
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
        margin: var(--ui-spacing-sm) 0 var(--ui-spacing-xs);
        line-height: 1.4;
      }

      .redetect-actions {
        display: flex;
        gap: var(--ui-spacing-sm);
        align-items: center;
      }
    }

    .threshold-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-left: 4px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      font-size: 8px;
      cursor: pointer;
      border-radius: 3px;
      vertical-align: middle;

      &:hover {
        background: var(--hover-bg);
        color: var(--text-primary);
      }
    }

    .threshold-panel {
      margin: 0 0 var(--ui-spacing-xs);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-sunken);
      border-left: 3px solid var(--border-default);
      border-radius: 0 $radius-sm $radius-sm 0;
      animation: slideDown 0.15s ease-out;
    }

    .threshold-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      height: 28px;

      .threshold-label {
        flex: 0 0 110px;
        font-size: 10px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      input[type="range"] {
        flex: 1;
        height: 4px;
        cursor: pointer;
        min-width: 60px;
      }

      .threshold-value {
        flex: 0 0 60px;
        font-size: 10px;
        color: var(--text-primary);
        text-align: right;
        font-family: monospace;
      }
    }

    .category-item.has-thresholds-open {
      margin-bottom: 0;
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
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

        select.preset-select {
          width: 100%;
          padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
          border: 1px solid var(--border-default);
          border-radius: $radius-sm;
          background: var(--bg-surface);
          color: var(--text-primary);
          font-size: var(--ui-font-sm);
          cursor: pointer;

          &:focus {
            outline: none;
            border-color: var(--accent);
          }
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

    ::ng-deep mark {
      background: rgba(255, 213, 79, 0.4);
      color: inherit;
      padding: 0 1px;
      border-radius: 2px;
    }

    /* Analysis Tabs */
    .analysis-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .analysis-tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;

      &:hover {
        color: var(--text-primary);
        background: var(--hover-bg);
      }

      &.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      .tab-badge {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--bg-subtle);
        border-radius: 8px;
        font-weight: 600;
      }

      &.active .tab-badge {
        background: var(--accent-subtle);
        color: var(--accent);
      }
    }

    /* Search Section */
    .search-section {
      padding: var(--ui-spacing-sm);
    }

    .search-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;

      .search-icon {
        position: absolute;
        left: 8px;
        color: var(--text-tertiary);
        pointer-events: none;
      }

      .search-input {
        width: 100%;
        padding: var(--ui-spacing-sm) var(--ui-spacing-sm) var(--ui-spacing-sm) 30px;
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

      .clear-search {
        position: absolute;
        right: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border: none;
        background: var(--bg-subtle);
        border-radius: 50%;
        cursor: pointer;
        color: var(--text-secondary);
        padding: 0;

        &:hover {
          background: var(--hover-bg);
          color: var(--text-primary);
        }
      }
    }

    .search-options {
      display: flex;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xs) 0;
    }

    .search-option {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      cursor: pointer;

      input[type="checkbox"] {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: var(--accent);
        cursor: pointer;
      }
    }

    .search-status {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      padding: var(--ui-spacing-xs) 0;
    }

    .search-results-list {
      margin-top: var(--ui-spacing-xs);
    }

    .search-result {
      display: flex;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      font-size: 11px;
      border-bottom: 1px solid var(--border-subtle);
      align-items: flex-start;

      &:last-child {
        border-bottom: none;
      }

      &.clickable {
        cursor: pointer;

        &:hover {
          background: var(--accent-subtle);
        }
      }

      .result-page {
        color: #ff7b54;
        font-weight: 600;
        flex-shrink: 0;
        width: 32px;
        padding-top: 1px;
      }

      .result-text {
        color: var(--text-primary);
        line-height: 1.4;
        word-break: break-word;
      }
    }

    .search-more {
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      font-size: 10px;
      color: var(--text-tertiary);
      font-style: italic;
    }

    .empty-hint {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      margin-top: 4px;
    }

    /* Analysis Results Section */
    .analysis-section {
      padding-top: var(--ui-spacing-xs);
    }

    /* Color legend */
    .analysis-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: var(--ui-spacing-xs);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--text-secondary);
    }

    .legend-color {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .legend-name {
      white-space: nowrap;
    }

    .legend-count {
      color: var(--text-tertiary);
      font-weight: 600;
    }

    /* Flat flag list */
    .analysis-flag {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-left: 3px solid transparent;
      cursor: pointer;
      transition: background 0.1s ease;

      &:hover {
        background: var(--hover-bg);
      }

      &.selected {
        background: var(--accent-subtle);
        box-shadow: inset 0 0 0 1px var(--accent);
      }

      &.expanded {
        background: var(--bg-elevated);
        border-left-width: 4px;
        padding-bottom: var(--ui-spacing-md);
      }

      & + .analysis-flag {
        border-top: 1px solid var(--border-subtle);
      }
    }

    .flag-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
    }

    .category-dot {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .flag-category-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .flag-chapter {
      font-size: 10px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flag-page {
      margin-left: auto;
      font-size: 9px;
      color: #ff7b54;
      font-weight: 600;
      flex-shrink: 0;
    }

    .flag-quote {
      font-size: 11px;
      color: var(--text-secondary);
      font-style: italic;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flag-quote-full {
      font-size: 12px;
      color: var(--text-primary);
      font-style: italic;
      line-height: 1.5;
      margin: var(--ui-spacing-xs) 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .flag-description-full {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
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

  // Category correction inputs
  categoryCorrections = input<Map<string, string>>(new Map());

  // Classification threshold inputs
  thresholds = input<ClassificationThresholds | null>(null);
  baselines = input<CategoryBaselines | null>(null);

  // Analysis inputs
  analysisOnly = input<boolean>(false);
  analysisFlags = input<Array<{
    categoryId: string;
    categoryName: string;
    categoryColor: string;
    quote: string;
    description: string;
    severity: 'low' | 'medium' | 'high';
    chapterId: string;
    chapterTitle: string;
    page?: number;
  }>>([]);
  analysisCategories = input<Array<{
    id: string;
    name: string;
    color: string;
    enabled: boolean;
    flagCount: number;
  }>>([]);

  // Selected flag index (set when user clicks a highlight on the PDF in analysis mode)
  selectedFlagIndex = input<number>(-1);

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

  // Block merge output
  mergeBlocks = output<void>();

  // Category re-detection outputs
  clearCorrections = output<void>();

  // Threshold outputs
  thresholdChange = output<{ path: string; value: number }>();
  recategorize = output<void>();
  resetThresholds = output<void>();

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

  // Analysis flag / search result navigation
  navigateToFlag = output<{
    page: number;
    // For pulsing: either flag category info or search block bounds
    categoryId?: string;
    color?: string;
    blockText?: string;  // search result text to find matching block
  }>();

  // Create section state (can be controlled by parent)
  createSectionExpandedChange = output<boolean>();

  private readonly el = inject(ElementRef);

  // Resolved selected flag object (from flat index into unsorted analysisFlags)
  readonly selectedFlag = computed(() => {
    const idx = this.selectedFlagIndex();
    if (idx < 0) return null;
    // Index is into the unsorted analysisFlags array — resolve the object
    // so reference equality works against sortedFlags in the template
    return this.analysisFlags()[idx] ?? null;
  });

  // Scroll to and expand selected flag when it changes
  private readonly scrollToFlagEffect = effect(() => {
    const flag = this.selectedFlag();
    if (!flag) return;
    // Find the index in sortedFlags to expand it
    const sorted = this.sortedFlags();
    const sortedIdx = sorted.indexOf(flag);
    if (sortedIdx >= 0) {
      this.expandedFlagIndex.set(sortedIdx);
    }
    // Use setTimeout to let the DOM update first
    setTimeout(() => {
      const el = this.el.nativeElement.querySelector('.analysis-flag.selected');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 0);
  });

  // Local state
  readonly createSectionExpanded = signal(false);
  readonly regexExpanded = signal(false);
  readonly filtersExpanded = signal(false);
  readonly contextMenu = signal<{ x: number; y: number; categoryId: string } | null>(null);
  readonly selectedPreset = signal<string>('');

  // Threshold accordion state
  readonly thresholdExpanded = signal<string | null>(null);

  // Categories that have tunable thresholds (body and image do not)
  private readonly thresholdCategories = new Set([
    'header', 'footer', 'footnote_ref', 'footnote', 'caption', 'title', 'heading', 'subheading', 'quote'
  ]);

  // Analysis tab state
  readonly analysisTab = signal<'flags' | 'search'>('flags');
  readonly expandedFlagIndex = signal<number>(-1);

  // Flags sorted by page (chronological order through the document)
  readonly sortedFlags = computed(() => {
    const flags = this.analysisFlags();
    if (!flags.length) return flags;
    return [...flags].sort((a, b) => {
      const pa = a.page ?? Infinity;
      const pb = b.page ?? Infinity;
      return pa - pb;
    });
  });

  // Search state
  readonly searchQuery = signal('');
  readonly searchPhraseMode = signal(false);
  readonly searchPhoneticMode = signal(false);

  // Debounced copy of the query — searchResults scans every block (with
  // soundex/Levenshtein in phonetic mode), so don't run it per keystroke
  private readonly debouncedSearchQuery = signal('');
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Search results computed from blocks
  readonly searchResults = computed(() => {
    const query = this.debouncedSearchQuery().trim();
    if (!query) return [];

    const blocks = this.blocks();
    if (!blocks.length) return [];

    const results: Array<{ page: number; text: string; highlightedText: string }> = [];

    for (const block of blocks) {
      if (!block.text) continue;
      if (this.matchesQuery(query, block.text)) {
        results.push({
          page: block.page,
          text: block.text,
          highlightedText: this.highlightMatch(query, block.text),
        });
      }
    }

    return results;
  });

  // Pattern presets for common reference formats
  readonly patternPresets = [
    { label: 'Numbers (1-999)', value: '^\\d{1,3}$' },
    { label: 'Numbers with period (1. 2. 3.)', value: '^\\d{1,3}\\.$' },
    { label: 'Bracketed numbers [1] [2]', value: '^\\[\\d{1,3}\\]$' },
    { label: 'Parenthesized numbers (1) (2)', value: '^\\(\\d{1,3}\\)$' },
    { label: 'Superscript digits ¹²³', value: '^[¹²³⁴⁵⁶⁷⁸⁹⁰]+$' },
    { label: 'Roman numerals (i, ii, iv)', value: '^[ivxlcdm]+$' },
    { label: 'Roman (uppercase) I, II, IV', value: '^[IVXLCDM]+$' },
    { label: 'Letters (a, b, c)', value: '^[a-z]$' },
    { label: 'Letters (uppercase A, B, C)', value: '^[A-Z]$' },
    { label: 'Asterisk references *†‡', value: '^[*†‡§¶]+$' },
  ];

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

  toggleCreateSection(): void {
    const newState = !this.createSectionExpanded();
    this.createSectionExpanded.set(newState);
    this.createSectionExpandedChange.emit(newState);
  }

  collapseCreateSection(): void {
    this.createSectionExpanded.set(false);
    this.regexExpanded.set(false);
    this.createSectionExpandedChange.emit(false);
  }

  toggleRegexPanel(): void {
    const newState = !this.regexExpanded();
    this.regexExpanded.set(newState);
    this.regexExpandedChange.emit(newState);
  }

  onPresetChange(value: string): void {
    this.selectedPreset.set(value);
    if (value) {
      this.regexPatternChange.emit(value);
      // When selecting a preset, disable literal mode since presets are actual regex
      this.regexLiteralModeChange.emit(false);
    }
  }

  onPatternChange(value: string): void {
    this.regexPatternChange.emit(value);
    // When manually editing, clear preset selection if pattern doesn't match any preset
    const matchingPreset = this.patternPresets.find(p => p.value === value);
    if (!matchingPreset) {
      this.selectedPreset.set('');
    }
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

  // Threshold control methods
  hasThresholdControls(categoryId: string): boolean {
    return this.thresholdCategories.has(categoryId);
  }

  toggleThresholdPanel(event: MouseEvent, categoryId: string): void {
    event.stopPropagation();
    this.thresholdExpanded.set(this.thresholdExpanded() === categoryId ? null : categoryId);
  }

  getThresholdControls(categoryId: string): Array<{ path: string; label: string; min: number; max: number; step: number; format: 'pct' | 'ratio' | 'int' }> {
    switch (categoryId) {
      case 'header':
        return [
          { path: 'header.topYPct', label: 'Header zone', min: 0.05, max: 0.25, step: 0.01, format: 'pct' },
          { path: 'header.regionScoreThreshold', label: 'Region threshold', min: 1, max: 5, step: 1, format: 'int' },
          { path: 'region.headerBottomPct', label: 'Header region max', min: 0.05, max: 0.30, step: 0.01, format: 'pct' },
        ];
      case 'footer':
        return [
          { path: 'region.footerBottomPct', label: 'Footer zone start', min: 0.80, max: 0.99, step: 0.01, format: 'pct' },
          { path: 'region.footerShortBottomPct', label: 'Short text zone', min: 0.80, max: 0.99, step: 0.01, format: 'pct' },
          { path: 'region.footerShortMaxChars', label: 'Short max chars', min: 10, max: 200, step: 10, format: 'int' },
        ];
      case 'footnote_ref':
        return [
          { path: 'footnoteRef.maxFontRatio', label: 'Font ratio', min: 0.50, max: 1.0, step: 0.05, format: 'ratio' },
          { path: 'footnoteRef.maxChars', label: 'Max chars', min: 1, max: 10, step: 1, format: 'int' },
        ];
      case 'footnote':
        return [
          { path: 'region.lowerBottomPct', label: 'Lower region start', min: 0.50, max: 0.90, step: 0.01, format: 'pct' },
          { path: 'footnote.fontRatio', label: 'Font ratio', min: 0.80, max: 1.10, step: 0.05, format: 'ratio' },
          { path: 'footnote.lowerHalfYPct', label: 'Lower half start', min: 0.30, max: 0.80, step: 0.05, format: 'pct' },
        ];
      case 'caption':
        return [
          { path: 'caption.smallFontRatio', label: 'Small font ratio', min: 0.60, max: 1.0, step: 0.05, format: 'ratio' },
          { path: 'caption.nearImageFontRatio', label: 'Near-image ratio', min: 0.80, max: 1.05, step: 0.05, format: 'ratio' },
          { path: 'caption.maxLinesNearImage', label: 'Max lines', min: 1, max: 20, step: 1, format: 'int' },
        ];
      case 'title':
        return [
          { path: 'title.minFontRatio', label: 'Font ratio', min: 1.1, max: 3.0, step: 0.1, format: 'ratio' },
          { path: 'title.minChars', label: 'Min chars', min: 1, max: 10, step: 1, format: 'int' },
        ];
      case 'heading':
        return [
          { path: 'heading.minFontRatio', label: 'Font ratio', min: 1.0, max: 2.0, step: 0.05, format: 'ratio' },
        ];
      case 'subheading':
        return [
          { path: 'subheading.maxLines', label: 'Max lines', min: 1, max: 10, step: 1, format: 'int' },
          { path: 'subheading.maxChars', label: 'Max chars', min: 50, max: 500, step: 50, format: 'int' },
        ];
      case 'quote':
        return [
          { path: 'quote.minLines', label: 'Min lines', min: 1, max: 10, step: 1, format: 'int' },
        ];
      default:
        return [];
    }
  }

  getThresholdValue(path: string): number {
    const t = this.thresholds();
    if (!t) return 0;
    const parts = path.split('.');
    if (parts.length === 2) {
      return (t as any)[parts[0]]?.[parts[1]] ?? 0;
    }
    return 0;
  }

  formatThresholdValue(path: string, format: 'pct' | 'ratio' | 'int'): string {
    const value = this.getThresholdValue(path);
    const bl = this.baselines();

    if (format === 'pct') {
      return `${Math.round(value * 100)}%`;
    }
    if (format === 'ratio') {
      const base = bl ? `(${(value * bl.bodySize).toFixed(1)}pt)` : '';
      return `${value.toFixed(2)} ${base}`;
    }
    return `${value}`;
  }

  onThresholdInput(event: Event, path: string): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    this.thresholdChange.emit({ path, value });
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

  getAnalysisFlagsForCategory(categoryId: string): Array<{
    quote: string;
    description: string;
    severity: string;
    chapterTitle: string;
    page?: number;
  }> {
    return this.analysisFlags().filter(f => f.categoryId === categoryId);
  }

  onFlagClick(flag: { page?: number; categoryId?: string; categoryColor?: string }): void {
    if (flag.page !== undefined) {
      this.navigateToFlag.emit({ page: flag.page, categoryId: flag.categoryId, color: flag.categoryColor });
    }
  }

  onFlagItemClick(flag: { page?: number; categoryId?: string; categoryColor?: string }, index: number): void {
    // Toggle expand/collapse
    if (this.expandedFlagIndex() === index) {
      this.expandedFlagIndex.set(-1);
    } else {
      this.expandedFlagIndex.set(index);
      // Also navigate to the page and pulse
      if (flag.page !== undefined) {
        this.navigateToFlag.emit({ page: flag.page, categoryId: flag.categoryId, color: flag.categoryColor });
      }
    }
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

  // --- Search methods ---

  onSearchQueryChange(value: string): void {
    this.searchQuery.set(value);
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      this.debouncedSearchQuery.set(value);
    }, 200);
  }

  clearSearch(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.searchQuery.set('');
    this.debouncedSearchQuery.set('');
  }

  onSearchResultClick(result: { page: number; text: string }): void {
    this.navigateToFlag.emit({ page: result.page, blockText: result.text, color: '#FFD54F' });
  }

  matchesQuery(query: string, text: string): boolean {
    if (!query || !text) return false;
    const trimmed = query.trim();
    if (!trimmed) return false;

    // Auto-detect boolean operators
    if (/\s+(AND|OR|NOT)\s+/.test(trimmed)) {
      return this.evaluateBooleanQuery(trimmed, text);
    } else if (this.searchPhraseMode()) {
      return this.matchesPhrase(trimmed, text);
    } else {
      return this.matchesAnyWord(trimmed, text);
    }
  }

  private matchesAnyWord(query: string, text: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    for (const searchWord of words) {
      // Simple substring check first
      if (textLower.includes(searchWord)) return true;

      // Phonetic matching if enabled
      if (this.searchPhoneticMode() && searchWord.length >= 3) {
        for (const textWord of textWords) {
          if (this.wordsMatchPhonetically(searchWord, textWord)) return true;
        }
      }
    }
    return false;
  }

  private matchesPhrase(query: string, text: string): boolean {
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    // Exact phrase in double quotes
    const exactMatch = query.match(/^"([^"]+)"$/);
    if (exactMatch) {
      return textLower.includes(exactMatch[1].toLowerCase());
    }

    // Phonetic phrase: words must appear consecutively
    const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (searchWords.length === 0) return false;

    for (let start = 0; start <= textWords.length - searchWords.length; start++) {
      let allMatch = true;
      for (let i = 0; i < searchWords.length; i++) {
        const tw = textWords[start + i];
        const sw = searchWords[i];
        if (this.searchPhoneticMode()) {
          if (!this.wordsMatchPhonetically(sw, tw)) { allMatch = false; break; }
        } else {
          if (!tw.includes(sw)) { allMatch = false; break; }
        }
      }
      if (allMatch) return true;
    }
    return false;
  }

  private wordsMatchPhonetically(search: string, text: string): boolean {
    if (text === search) return true;
    if (search.length <= 2) return text === search;
    if (search.length >= 3 && text.includes(search)) return true;

    if (this.searchPhoneticMode() && search.length >= 3) {
      const ss = this.soundex(search);
      const ts = this.soundex(text);
      if (ss && ts && ss === ts && ss !== '0000') return true;

      const maxDist = Math.max(1, Math.floor(search.length / 3));
      if (this.levenshteinDistance(search, text) <= maxDist) return true;
    }
    return false;
  }

  private evaluateBooleanQuery(query: string, line: string): boolean {
    let processed = query;

    // OR
    const orPattern = /("?[\w]+"?)\s+OR\s+("?[\w]+"?)/g;
    for (const match of [...query.matchAll(orPattern)]) {
      const a = this.termMatches(match[1], line);
      const b = this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a || b) ? 'TRUE' : 'FALSE');
    }

    // AND
    const andPattern = /("?[\w]+"?)\s+AND\s+("?[\w]+"?)/g;
    for (const match of [...processed.matchAll(andPattern)]) {
      const a = match[1] === 'TRUE' || match[1] === 'FALSE' ? match[1] === 'TRUE' : this.termMatches(match[1], line);
      const b = match[2] === 'TRUE' || match[2] === 'FALSE' ? match[2] === 'TRUE' : this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a && b) ? 'TRUE' : 'FALSE');
    }

    // NOT
    const notPattern = /("?[\w]+"?)\s+NOT\s+("?[\w]+"?)/g;
    for (const match of [...processed.matchAll(notPattern)]) {
      const a = match[1] === 'TRUE' || match[1] === 'FALSE' ? match[1] === 'TRUE' : this.termMatches(match[1], line);
      const b = match[2] === 'TRUE' || match[2] === 'FALSE' ? match[2] === 'TRUE' : this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a && !b) ? 'TRUE' : 'FALSE');
    }

    if (!/\s+(AND|OR|NOT)\s+/.test(query)) {
      return this.termMatches(query, line);
    }
    return processed.includes('TRUE');
  }

  private termMatches(term: string, text: string): boolean {
    const clean = term.replace(/"/g, '').toLowerCase();
    return text.toLowerCase().includes(clean);
  }

  private soundex(word: string): string {
    if (!word || word.length === 0) return '0000';
    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length === 0) return '0000';

    const codes: Record<string, string> = {
      'B': '1', 'F': '1', 'P': '1', 'V': '1',
      'C': '2', 'G': '2', 'J': '2', 'K': '2', 'Q': '2', 'S': '2', 'X': '2', 'Z': '2',
      'D': '3', 'T': '3',
      'L': '4',
      'M': '5', 'N': '5',
      'R': '6',
    };

    let result = clean[0];
    let prevCode = codes[clean[0]] || '';

    for (let i = 1; i < clean.length && result.length < 4; i++) {
      const code = codes[clean[i]];
      if (code && code !== prevCode) {
        result += code;
        prevCode = code;
      } else if (!code) {
        prevCode = '';
      }
    }
    return (result + '000').substring(0, 4);
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = Array(n + 1).fill(0).map((_, i) => i);
    let curr = Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  private highlightMatch(query: string, text: string): string {
    // Escape HTML entities first
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Truncate for display
    const maxLen = 120;
    const truncated = escaped.length > maxLen ? escaped.substring(0, maxLen) + '...' : escaped;

    // Highlight matching terms
    const terms = query.replace(/"/g, '').split(/\s+/).filter(w => w.length > 0 && !['AND', 'OR', 'NOT'].includes(w));
    let result = truncated;
    for (const term of terms) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      result = result.replace(regex, '<mark>$&</mark>');
    }
    return result;
  }
}

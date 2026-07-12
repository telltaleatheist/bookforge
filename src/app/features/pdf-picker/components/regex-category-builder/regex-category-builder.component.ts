import { Component, input, output, computed, signal, effect, untracked, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Category } from '../../services/pdf.service';
import { DesktopButtonComponent, DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';

/**
 * All regex-category form fields collected into a single object. The builder
 * owns these locally; the parent shell keeps ONE `regexCriteria` signal instead
 * of the ~14 individual form signals it used to round-trip through the panel.
 */
export interface RegexCriteria {
  name: string;
  pattern: string;
  color: string;
  minFontSize: number;
  /** 0 means "no max filter". */
  maxFontSize: number;
  minBaseline: number | null;
  maxBaseline: number | null;
  caseSensitive: boolean;
  /** When true, special regex chars in the pattern are escaped (literal search). */
  literalMode: boolean;
  /** Category IDs to include. Empty = none (matches nothing). */
  categoryFilter: string[];
  pageFilterType: 'all' | 'range' | 'even' | 'odd' | 'specific';
  pageRangeStart: number;
  pageRangeEnd: number;
  specificPages: string;
}

/** Factory for a fresh, empty criteria (matches the shell's historic reset values). */
export function defaultRegexCriteria(): RegexCriteria {
  return {
    name: '',
    pattern: '',
    color: '#FF5722',
    minFontSize: 0,
    maxFontSize: 0,
    minBaseline: null,
    maxBaseline: null,
    caseSensitive: false,
    literalMode: false,
    categoryFilter: [],
    pageFilterType: 'all',
    pageRangeStart: 1,
    pageRangeEnd: 1,
    specificPages: '',
  };
}

interface RegexMatchPreview {
  page: number;
  text: string;
}

/**
 * Self-contained regex category builder. Owns the whole regex form as local
 * signals and emits a single {@link RegexCriteria} object (debounced while
 * typing). The parent keeps match computation, viewer highlighting and the
 * timeline; it feeds live `matches`/`matchCount` back in for the preview.
 *
 * Contract:
 *   [categories] [matches] [matchCount] [editCriteria] [isEditing] [expanded]
 *   → (criteriaChange /* debounced ~250ms *​/) (create) (expandedChange)
 *
 * `expanded` is controlled by the parent (its `regexPanelExpanded` drives the
 * viewer's regex-search overlay); toggling the "By regex" header emits
 * `expandedChange` and the parent pushes the new value back in.
 */
@Component({
  selector: 'app-regex-category-builder',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, DesktopSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="regex-toggle"
      [class.active]="expanded()"
      [disabled]="categories().length === 0"
      (click)="toggleForm()"
    >
      <span class="regex-toggle-icon">.*</span>
      <span>By regex</span>
      <span class="regex-toggle-chevron">{{ expanded() ? '▼' : '▶' }}</span>
    </button>

    @if (expanded()) {
      <div class="regex-form-section">
        <div class="form-group">
          <label>Category name</label>
          <input
            type="text"
            [ngModel]="name()"
            (ngModelChange)="onNameChange($event)"
            placeholder="e.g., Footnotes"
          />
        </div>

        <div class="form-group">
          <label>Pattern presets</label>
          <desktop-select
            class="preset-select"
            [options]="patternPresetOptions()"
            [ngModel]="selectedPreset()"
            (ngModelChange)="onPresetChange($event)"
          />
        </div>

        <div class="form-group">
          <label>Regex pattern</label>
          <input
            type="text"
            [ngModel]="pattern()"
            (ngModelChange)="onPatternChange($event)"
            placeholder="e.g., \\[\\d+\\]"
          />
        </div>

        <div class="form-row">
          <div class="form-group half">
            <label>Min font</label>
            <input
              type="number"
              [ngModel]="minFontSize()"
              (ngModelChange)="onMinFontSizeChange($event)"
              placeholder="0"
            />
          </div>
          <div class="form-group half">
            <label>Max font</label>
            <input
              type="number"
              [ngModel]="maxFontSize() || null"
              (ngModelChange)="onMaxFontSizeChange($event)"
              placeholder="any"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group half">
            <label>Min baseline</label>
            <input
              type="number"
              step="0.1"
              [ngModel]="minBaseline()"
              (ngModelChange)="onMinBaselineChange($event)"
              placeholder="any"
            />
          </div>
          <div class="form-group half">
            <label>Max baseline</label>
            <input
              type="number"
              step="0.1"
              [ngModel]="maxBaseline()"
              (ngModelChange)="onMaxBaselineChange($event)"
              placeholder="any"
            />
          </div>
        </div>

        <div class="form-row search-options">
          <label class="checkbox-label">
            <input
              type="checkbox"
              [checked]="literalMode()"
              (change)="onLiteralModeChange($any($event.target).checked)"
            />
            <span>Literal</span>
            <span class="option-hint">(escape special chars)</span>
          </label>
          <label class="checkbox-label">
            <input
              type="checkbox"
              [checked]="caseSensitive()"
              (change)="onCaseSensitiveChange($any($event.target).checked)"
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
                <desktop-select
                  class="page-filter-select"
                  [options]="pageFilterOptions"
                  [ngModel]="pageFilterType()"
                  (ngModelChange)="onPageFilterTypeChange($event)"
                />

                @if (pageFilterType() === 'range') {
                  <div class="page-range-inputs">
                    <input
                      type="number"
                      min="1"
                      [ngModel]="pageRangeStart()"
                      (ngModelChange)="onPageRangeStartChange($event)"
                      placeholder="from"
                    />
                    <span>to</span>
                    <input
                      type="number"
                      min="1"
                      [ngModel]="pageRangeEnd()"
                      (ngModelChange)="onPageRangeEndChange($event)"
                      placeholder="to"
                    />
                  </div>
                }

                @if (pageFilterType() === 'specific') {
                  <input
                    type="text"
                    class="specific-pages-input"
                    [ngModel]="specificPages()"
                    (ngModelChange)="onSpecificPagesChange($event)"
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
            [ngModel]="color()"
            (ngModelChange)="onColorChange($event)"
          />
        </div>

        <div class="regex-preview">
          <div class="preview-header">
            <span>{{ matchCount() }} matches</span>
            @if (matchCount() > 10000) {
              <span class="preview-limit">(showing first 10000)</span>
            }
          </div>
          @if (matches().length > 0) {
            <div class="preview-list">
              @for (match of matches().slice(0, 20); track $index) {
                <div class="preview-item">
                  <span class="preview-page">p.{{ match.page + 1 }}</span>
                  <span class="preview-text">"{{ match.text }}"</span>
                </div>
              }
              @if (matches().length > 20) {
                <div class="preview-more">...and {{ matches().length - 20 }} more in preview</div>
              }
            </div>
          }
        </div>

        <div class="regex-actions">
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="!name() || (!isEditing() && matchCount() === 0)"
            (click)="onCreate()"
          >
            {{ isEditing() ? 'Update' : 'Create' }} {{ matchCount() > 0 ? '(' + matchCount() + ')' : '' }}
          </desktop-button>
        </div>
      </div>
    }
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: block;
    }

    .regex-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-sm;
      cursor: pointer;
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--text-secondary);
      text-align: left;

      &:hover:not(:disabled) {
        background: var(--hover-bg);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent-subtle);
        border-color: var(--accent);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .regex-toggle-icon {
        font-family: monospace;
        color: var(--text-tertiary);
      }

      .regex-toggle-chevron {
        margin-left: auto;
        font-size: 8px;
        color: var(--text-tertiary);
      }
    }

    .regex-form-section {
      margin-top: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-sm;
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

        .preset-select {
          width: 100%;
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
            color: var(--accent);
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
  `],
})
export class RegexCategoryBuilderComponent {
  readonly categories = input.required<Category[]>();
  readonly matches = input<RegexMatchPreview[]>([]);
  readonly matchCount = input<number>(0);
  /** Non-null triggers loading the given criteria into the form (edit flow). */
  readonly editCriteria = input<RegexCriteria | null>(null);
  readonly isEditing = input<boolean>(false);
  /** Controlled by the parent's regexPanelExpanded (drives the viewer overlay). */
  readonly expanded = input<boolean>(false);

  readonly criteriaChange = output<RegexCriteria>();
  readonly create = output<RegexCriteria>();
  readonly expandedChange = output<boolean>();

  // --- Local form state ---
  readonly name = signal('');
  readonly pattern = signal('');
  readonly color = signal('#FF5722');
  readonly minFontSize = signal(0);
  readonly maxFontSize = signal(0);
  readonly minBaseline = signal<number | null>(null);
  readonly maxBaseline = signal<number | null>(null);
  readonly caseSensitive = signal(false);
  readonly literalMode = signal(false);
  readonly categoryFilter = signal<string[]>([]);
  readonly pageFilterType = signal<'all' | 'range' | 'even' | 'odd' | 'specific'>('all');
  readonly pageRangeStart = signal(1);
  readonly pageRangeEnd = signal(1);
  readonly specificPages = signal('');

  readonly selectedPreset = signal<string>('');
  readonly filtersExpanded = signal(false);

  private criteriaTimer: ReturnType<typeof setTimeout> | null = null;

  readonly pageFilterOptions: DesktopSelectItems = [
    { value: 'all', label: 'All pages' },
    { value: 'range', label: 'Page range' },
    { value: 'even', label: 'Even pages only' },
    { value: 'odd', label: 'Odd pages only' },
    { value: 'specific', label: 'Specific pages' },
  ];

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

  readonly patternPresetOptions = computed<DesktopSelectItems>(() => [
    { value: '', label: 'Custom pattern...' },
    ...this.patternPresets.map(p => ({ value: p.value, label: p.label })),
  ]);

  constructor() {
    // Load an edit request into the form. editCustomCategory in the shell
    // builds a fresh RegexCriteria object each time, so reference identity
    // changes and this effect fires per edit.
    effect(() => {
      const ec = this.editCriteria();
      if (!ec) return;
      untracked(() => {
        this.applyCriteria(ec);
        this.selectedPreset.set('');
        // Sync the parent (pattern is empty on edit → matches clear). Deferred a
        // microtask so the output fires outside this effect's synchronous run.
        queueMicrotask(() => this.emitCriteriaNow());
      });
    });
  }

  // --- Criteria plumbing ---

  buildCriteria(): RegexCriteria {
    return {
      name: this.name(),
      pattern: this.pattern(),
      color: this.color(),
      minFontSize: this.minFontSize(),
      maxFontSize: this.maxFontSize(),
      minBaseline: this.minBaseline(),
      maxBaseline: this.maxBaseline(),
      caseSensitive: this.caseSensitive(),
      literalMode: this.literalMode(),
      categoryFilter: this.categoryFilter(),
      pageFilterType: this.pageFilterType(),
      pageRangeStart: this.pageRangeStart(),
      pageRangeEnd: this.pageRangeEnd(),
      specificPages: this.specificPages(),
    };
  }

  private applyCriteria(c: RegexCriteria): void {
    this.name.set(c.name);
    this.pattern.set(c.pattern);
    this.color.set(c.color);
    this.minFontSize.set(c.minFontSize);
    this.maxFontSize.set(c.maxFontSize);
    this.minBaseline.set(c.minBaseline);
    this.maxBaseline.set(c.maxBaseline);
    this.caseSensitive.set(c.caseSensitive);
    this.literalMode.set(c.literalMode);
    this.categoryFilter.set(c.categoryFilter);
    this.pageFilterType.set(c.pageFilterType);
    this.pageRangeStart.set(c.pageRangeStart);
    this.pageRangeEnd.set(c.pageRangeEnd);
    this.specificPages.set(c.specificPages);
  }

  private resetForm(): void {
    this.applyCriteria(defaultRegexCriteria());
    // Fresh builds start with every category included (parity with the shell's
    // historic "select all categories" reset).
    this.categoryFilter.set(this.categories().map(c => c.id));
    this.selectedPreset.set('');
    this.filtersExpanded.set(false);
  }

  private scheduleCriteriaChange(): void {
    if (this.criteriaTimer) clearTimeout(this.criteriaTimer);
    this.criteriaTimer = setTimeout(() => {
      this.criteriaTimer = null;
      this.criteriaChange.emit(this.buildCriteria());
    }, 250);
  }

  private emitCriteriaNow(): void {
    if (this.criteriaTimer) {
      clearTimeout(this.criteriaTimer);
      this.criteriaTimer = null;
    }
    this.criteriaChange.emit(this.buildCriteria());
  }

  toggleForm(): void {
    const willOpen = !this.expanded();
    if (willOpen && !this.isEditing()) {
      this.resetForm();
      this.emitCriteriaNow();
    }
    this.expandedChange.emit(willOpen);
  }

  onCreate(): void {
    this.emitCriteriaNow();
    this.create.emit(this.buildCriteria());
  }

  // --- Field handlers ---

  onNameChange(value: string): void {
    this.name.set(value);
    this.scheduleCriteriaChange();
  }

  onColorChange(value: string): void {
    this.color.set(value);
    this.scheduleCriteriaChange();
  }

  onPatternChange(value: string): void {
    this.pattern.set(value);
    // Clear the preset selection if the pattern no longer matches a preset.
    if (!this.patternPresets.some(p => p.value === value)) {
      this.selectedPreset.set('');
    }
    this.scheduleCriteriaChange();
  }

  onPresetChange(value: string): void {
    this.selectedPreset.set(value);
    if (value) {
      this.pattern.set(value);
      // Presets are real regex — turn off literal (escaping) mode.
      this.literalMode.set(false);
    }
    this.scheduleCriteriaChange();
  }

  onMinFontSizeChange(value: number): void {
    this.minFontSize.set(isNaN(value) ? 0 : value);
    this.scheduleCriteriaChange();
  }

  onMaxFontSizeChange(value: number | null): void {
    // Empty field emits null → treat as 0 ("no max filter").
    this.maxFontSize.set(value && !isNaN(value) ? value : 0);
    this.scheduleCriteriaChange();
  }

  onMinBaselineChange(value: number | null): void {
    this.minBaseline.set(value === null || isNaN(value) ? null : value);
    this.scheduleCriteriaChange();
  }

  onMaxBaselineChange(value: number | null): void {
    this.maxBaseline.set(value === null || isNaN(value) ? null : value);
    this.scheduleCriteriaChange();
  }

  onCaseSensitiveChange(value: boolean): void {
    this.caseSensitive.set(value);
    this.scheduleCriteriaChange();
  }

  onLiteralModeChange(value: boolean): void {
    this.literalMode.set(value);
    this.scheduleCriteriaChange();
  }

  onPageFilterTypeChange(value: 'all' | 'range' | 'even' | 'odd' | 'specific'): void {
    this.pageFilterType.set(value);
    this.scheduleCriteriaChange();
  }

  onPageRangeStartChange(value: number): void {
    this.pageRangeStart.set(value || 1);
    this.scheduleCriteriaChange();
  }

  onPageRangeEndChange(value: number): void {
    this.pageRangeEnd.set(value || 1);
    this.scheduleCriteriaChange();
  }

  onSpecificPagesChange(value: string): void {
    this.specificPages.set(value);
    this.scheduleCriteriaChange();
  }

  // --- Category filter helpers ---

  hasActiveFilters(): boolean {
    const filter = this.categoryFilter();
    const categoryFilterActive = filter.length !== this.categories().length;
    return categoryFilterActive || this.pageFilterType() !== 'all';
  }

  allCategoriesSelected(): boolean {
    return this.categoryFilter().length === this.categories().length;
  }

  isCategoryInFilter(categoryId: string): boolean {
    return this.categoryFilter().includes(categoryId);
  }

  toggleCategoryFilter(categoryId: string): void {
    const current = this.categoryFilter();
    if (current.includes(categoryId)) {
      this.categoryFilter.set(current.filter(id => id !== categoryId));
    } else {
      this.categoryFilter.set([...current, categoryId]);
    }
    this.scheduleCriteriaChange();
  }

  toggleAllCategories(): void {
    if (this.allCategoriesSelected()) {
      this.categoryFilter.set([]);
    } else {
      this.categoryFilter.set(this.categories().map(c => c.id));
    }
    this.scheduleCriteriaChange();
  }
}

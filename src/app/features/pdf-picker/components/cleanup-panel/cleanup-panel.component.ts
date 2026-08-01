import { Component, input, output, computed, signal, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Category, TextBlock } from '../../services/pdf.service';
import { ClassificationThresholds, CategoryBaselines } from '../../services/category-learner';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';
import { RegexCategoryBuilderComponent, RegexCriteria } from '../regex-category-builder/regex-category-builder.component';

interface RegexMatchPreview {
  page: number;
  text: string;
}

interface ThresholdControl {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  format: 'pct' | 'ratio' | 'int';
}

/**
 * The block-classification workhorse. Lists detected categories with
 * include/exclude toggling, selection helpers, correction status and a
 * re-categorize action. Raw threshold knobs live in the panel-shell [advanced]
 * slot; the custom-category tools (By sample + regex builder) live in a
 * collapsible section. Split out of the old 73KB categories-panel.
 */
@Component({
  selector: 'app-cleanup-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent, PanelShellComponent, RegexCategoryBuilderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell title="Clean up" [hasAdvanced]="true" (close)="close.emit()">
      <!-- Selection toolbar -->
      <div class="cleanup-toolbar">
        <span class="toolbar-label">Categories</span>
        <div class="toolbar-actions">
          <desktop-button variant="ghost" size="xs" (click)="selectAll.emit()">All</desktop-button>
          <desktop-button variant="ghost" size="xs" (click)="deselectAll.emit()">None</desktop-button>
        </div>
      </div>

      <!-- Custom category tools (collapsible) -->
      <div class="custom-section">
        <button class="section-header" (click)="toggleCustomSection()">
          <span class="expand-icon">{{ customExpanded() ? '▼' : '▶' }}</span>
          <span>Custom category</span>
        </button>
        @if (customExpanded()) {
          <div class="custom-content">
            <desktop-button
              variant="secondary"
              size="sm"
              icon="🎯"
              [disabled]="!hasBlocks()"
              (click)="enterSampleMode.emit()"
            >
              By sample
            </desktop-button>
            <app-regex-category-builder
              [categories]="categories()"
              [matches]="regexMatches()"
              [matchCount]="regexMatchCount()"
              [editCriteria]="regexEditCriteria()"
              [isEditing]="regexIsEditing()"
              [expanded]="regexExpanded()"
              (criteriaChange)="regexCriteriaChange.emit($event)"
              (create)="regexCreate.emit($event)"
              (expandedChange)="regexExpandedChange.emit($event)"
            />
          </div>
        }
      </div>

      <!-- Corrections + re-categorize -->
      <div class="redetect-section">
        <label class="category-colors-toggle">
          <input
            type="checkbox"
            [checked]="showCategoryColors()"
            (change)="showCategoryColorsChange.emit(!showCategoryColors())"
          />
          <span>Show category colors on page</span>
        </label>
        <div class="redetect-actions">
          <desktop-button variant="primary" size="sm" (click)="recategorize.emit()">
            Re-categorize
          </desktop-button>
        </div>
        @if (categoryCorrections().size > 0) {
          <p class="redetect-hint">
            {{ categoryCorrections().size }} block{{ categoryCorrections().size !== 1 ? 's' : '' }} set by hand —
            locked, and never changed by re-categorize.
          </p>
          <div class="redetect-actions">
            <desktop-button variant="ghost" size="sm" (click)="clearCorrections.emit()">
              Clear corrections
            </desktop-button>
          </div>
        } @else {
          <p class="redetect-hint">Correct a few blocks, then re-categorize to fix the rest.</p>
        }
        @if (uncertainCount() > 0) {
          <p class="redetect-hint">
            <strong>{{ uncertainCount() }}</strong> uncertain block{{ uncertainCount() !== 1 ? 's' : '' }} —
            press <kbd>N</kbd> to step through them.
          </p>
        }
        @if (labelMode()) {
          @if (labelSourceName()) {
            <p class="redetect-hint">
              Labeling <strong>{{ labelSourceName() }}</strong> — labels are bound to this
              file and its pagination.
            </p>
          }
          <div class="training-actions">
            @if (corpusMode()) {
              <desktop-button
                variant="primary"
                size="sm"
                [disabled]="corpusReadOnly()"
                (click)="saveCorpusLabels.emit()"
              >
                Save labels
              </desktop-button>
            }
            <desktop-button variant="secondary" size="sm" (click)="alignFromEpub.emit()">
              Align from EPUB…
            </desktop-button>
            @if (!corpusMode()) {
              <desktop-button variant="primary" size="sm" (click)="exportTrainingData.emit()">
                Export training data
              </desktop-button>
            }
            <desktop-button variant="ghost" size="sm" (click)="resetLabels.emit()">
              Clear labels
            </desktop-button>
            @if (hasLabelSnapshot()) {
              <desktop-button variant="ghost" size="sm" (click)="restoreLabels.emit()">
                Restore labels
              </desktop-button>
            }
          </div>
          @if (corpusMode()) {
            <p class="redetect-hint">
              This is a training-corpus book, not a library project. Nothing is
              saved automatically — <strong>Save labels</strong> (⌘S) writes them
              back to <code>{{ corpusLabelsPath() }}</code>, and nothing is
              written anywhere else.
            </p>
          } @else {
            <p class="redetect-hint">
              Labels are saved with the book, so they carry over to Select and Edit.
              Export writes a training copy to
              <code>/Volumes/Callisto/training/rubric</code>, outside the synced library.
            </p>
          }
        }
        <details class="shortcut-legend">
          <summary>Labelling shortcuts</summary>
          <p class="legend-note">With blocks selected, press:</p>
          <ul>
            <li><kbd>B</kbd> body</li>
            <li><kbd>C</kbd> chapter</li>
            <li><kbd>T</kbd> title</li>
            <li><kbd>H</kbd> heading · <kbd>⇧H</kbd> subheading</li>
            <li><kbd>Q</kbd> quote</li>
            <li><kbd>P</kbd> caption</li>
            <li><kbd>F</kbd> footnote · <kbd>⇧F</kbd> footnote no.</li>
            <li><kbd>R</kbd> header · <kbd>⇧R</kbd> footer</li>
            <li><kbd>I</kbd> image</li>
            <li><kbd>M</kbd> front matter · <kbd>⇧M</kbd> back matter</li>
            <li><kbd>L</kbd> list · <kbd>⇧T</kbd> table</li>
            <li><kbd>N</kbd> next uncertain · <kbd>⇧N</kbd> previous</li>
          </ul>
        </details>
      </div>

      <!-- Categories list -->
      <div class="categories-list">
        @if (categories().length === 0) {
          <div class="empty-state"><p>Load a PDF to see categories</p></div>
        } @else {
          @for (cat of categories(); track cat.id) {
            <div
              class="category-item"
              [class.has-selection]="getSelectedCount(cat.id) > 0"
              [class.assignable]="labelMode() && hasSelection()"
              [title]="labelMode() && hasSelection() ? 'Assign selected blocks to ' + cat.name : ''"
              [class.is-custom]="isCustomCategory(cat.id)"
              [class.is-enabled]="!hiddenCategoryIds().has(cat.id)"
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
                  @if (isCustomCategory(cat.id)) {
                    {{ cat.block_count }} matches, {{ cat.char_count | number }} chars
                  } @else {
                    {{ getLiveCount(cat.id).total }} blocks
                    @if (getLiveCount(cat.id).deleted > 0) {
                      <span class="deleted-count">, {{ getLiveCount(cat.id).deleted }} deleted</span>
                    }
                  }
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

      <!-- Context menu -->
      @if (contextMenu()) {
        <div
          class="context-menu-backdrop"
          (click)="closeContextMenu()"
          (contextmenu)="closeContextMenu(); $event.preventDefault()"
        ></div>
        <div class="context-menu" [style.left.px]="contextMenu()!.x" [style.top.px]="contextMenu()!.y">
          <button class="context-menu-item" (click)="onContextMenuSelectInverse()">
            <span class="context-menu-icon">🔄</span>
            Select inverse
          </button>
          @if (!isCustomCategory(contextMenu()!.categoryId)) {
            @if (isCategoryFullyDeleted(contextMenu()!.categoryId)) {
              <button class="context-menu-item" (click)="onContextMenuRestoreBlocks()">
                <span class="context-menu-icon">↩</span>
                Keep these {{ getLiveCount(contextMenu()!.categoryId).total }} blocks
              </button>
            } @else {
              <button class="context-menu-item danger" (click)="onContextMenuDeleteBlocks()">
                <span class="context-menu-icon">🗑</span>
                Delete
                {{ getLiveCount(contextMenu()!.categoryId).total - getLiveCount(contextMenu()!.categoryId).deleted }}
                blocks
              </button>
            }
          }
          @if (isCustomCategory(contextMenu()!.categoryId)) {
            <button class="context-menu-item" (click)="onContextMenuEdit()">
              <span class="context-menu-icon">✏️</span>
              Edit category
            </button>
            <button class="context-menu-item danger" (click)="onContextMenuDelete()">
              <span class="context-menu-icon">🗑</span>
              Delete category
            </button>
          }
        </div>
      }

      <!-- Advanced: raw threshold tuning -->
      <div advanced>
        @if (baselines(); as bl) {
          <div class="baselines-info">
            Body font: {{ bl.bodySize }}pt {{ bl.bodyFont }}
            @if (bl.bodyIsItalic) { | Italic: Yes } @else { | Italic: No }
          </div>
        }
        @if (thresholds()) {
          @for (cat of thresholdCategoriesPresent(); track cat.id) {
            <div class="threshold-group" [style.border-left-color]="cat.color">
              <div class="threshold-group-name">{{ cat.name }}</div>
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
                  />
                  <span class="threshold-value">{{ formatThresholdValue(control.path, control.format) }}</span>
                </div>
              }
            </div>
          }
          <desktop-button variant="ghost" size="sm" (click)="resetThresholds.emit()">
            Reset defaults
          </desktop-button>
        } @else {
          <p class="advanced-empty">Threshold tuning becomes available once a document is analyzed.</p>
        }
      </div>

      <!-- Footer: char counts -->
      <div footer>
        <div class="stats-row">
          <span>Included: <strong>{{ includedChars() | number }}</strong></span>
          <span>Excluded: <strong>{{ excludedChars() | number }}</strong></span>
        </div>
      </div>
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host { display: contents; }

    .cleanup-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--ui-spacing-sm);
    }

    .toolbar-label {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--text-secondary);
    }

    .toolbar-actions {
      display: flex;
      gap: var(--ui-spacing-xs);
    }

    .custom-section {
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      margin-bottom: var(--ui-spacing-md);
      overflow: hidden;

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

      .custom-content {
        display: flex;
        flex-direction: column;
        gap: var(--ui-spacing-sm);
        padding: 0 var(--ui-spacing-md) var(--ui-spacing-md);

        desktop-button {
          width: 100%;
        }
      }
    }

    .redetect-section {
      margin-bottom: var(--ui-spacing-md);

      .category-colors-toggle {
        display: flex;
        align-items: center;
        gap: var(--ui-spacing-sm);
        font-size: var(--ui-font-xs);
        color: var(--text-secondary);
        margin-bottom: var(--ui-spacing-sm);
        cursor: pointer;
        user-select: none;

        input { cursor: pointer; }
      }

      .category-item.assignable {
        cursor: copy;

        &:hover {
          outline: 1px solid var(--accent, #06b6d4);
          outline-offset: -1px;
        }
      }

      .training-actions {
        display: flex;
        gap: var(--ui-spacing-sm);
        margin-top: var(--ui-spacing-sm);
      }

      code {
        font-family: var(--ui-font-mono, monospace);
        font-size: 0.95em;
      }

      .shortcut-legend {
        margin-top: var(--ui-spacing-sm);
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);

        summary {
          cursor: pointer;
          user-select: none;
          color: var(--text-secondary);
        }

        .legend-note { margin: var(--ui-spacing-xs) 0; }

        ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 2px;
        }
      }

      kbd {
        display: inline-block;
        min-width: 1.1em;
        padding: 0 4px;
        border: 1px solid var(--border-subtle, #4444);
        border-radius: 3px;
        background: var(--bg-elevated, #0002);
        font-family: var(--ui-font-mono, monospace);
        font-size: 0.95em;
        text-align: center;
      }

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

    .categories-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 160px;
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
    }

    .category-item {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      border-radius: $radius-md;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover {
        border-color: var(--border-default);
        background: var(--hover-bg);
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

      &.is-custom.is-enabled {
        border-color: var(--accent);
        background: var(--accent-subtle);

        .category-color {
          box-shadow: 0 0 0 2px var(--accent);
        }
      }

      &.is-custom:not(.is-enabled) {
        opacity: 0.5;

        .category-color {
          opacity: 0.4;
        }
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

    /* A deleted class is one the book will not carry — say so plainly, in the
       same place the counts live, rather than leaving the row looking normal. */
    .deleted-count {
      color: var(--danger, #d9534f);
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

    .context-menu-backdrop {
      position: fixed;
      inset: 0;
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

    .stats-row {
      display: flex;
      justify-content: space-between;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);

      strong {
        color: var(--text-primary);
      }
    }

    /* Advanced slot */
    .baselines-info {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      font-family: monospace;
      margin-bottom: var(--ui-spacing-md);
    }

    .advanced-empty {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      margin: 0;
    }

    .threshold-group {
      margin-bottom: var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-sunken);
      border-left: 3px solid var(--border-default);
      border-radius: 0 $radius-sm $radius-sm 0;
    }

    .threshold-group-name {
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      margin-bottom: var(--ui-spacing-xs);
      text-transform: capitalize;
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
  `],
})
export class CleanupPanelComponent {
  readonly categories = input.required<Category[]>();
  /** Custom categories whose highlights are hidden — a view toggle, not export state. */
  readonly hiddenCategoryIds = input.required<ReadonlySet<string>>();
  readonly blocks = input.required<TextBlock[]>();
  /** Needed for LIVE counts: `Category.block_count` is a snapshot taken at
   *  detection and never updated, so a row driven by it promises to delete a
   *  number that stopped being true the first time the user touched a block. */
  readonly deletedBlockIds = input.required<ReadonlySet<string>>();
  readonly selectedBlockIds = input.required<string[]>();
  readonly includedChars = input.required<number>();
  readonly excludedChars = input.required<number>();
  readonly categoryCorrections = input<Map<string, string>>(new Map());
  readonly showCategoryColors = input<boolean>(false);
  readonly uncertainCount = input<number>(0);
  readonly labelMode = input<boolean>(false);
  readonly labelSourceName = input<string>('');
  /** Whether a pre-adopt snapshot exists — gates the Restore button. */
  readonly hasLabelSnapshot = input<boolean>(false);
  /**
   * Corpus book: labels are written explicitly to the book's own folder under
   * /Volumes/Callisto/training/rubric/, and there is no project to save into.
   */
  readonly corpusMode = input<boolean>(false);
  /** The corpus book's directory — shown so the save target is never a guess. */
  readonly corpusDir = input<string>('');
  /** True when the snapshot does not match the open PDF; saving is refused. */
  readonly corpusReadOnly = input<boolean>(false);
  readonly thresholds = input<ClassificationThresholds | null>(null);
  readonly baselines = input<CategoryBaselines | null>(null);

  // Regex builder pass-through
  readonly regexMatches = input<RegexMatchPreview[]>([]);
  readonly regexMatchCount = input<number>(0);
  readonly regexEditCriteria = input<RegexCriteria | null>(null);
  readonly regexIsEditing = input<boolean>(false);
  readonly regexExpanded = input<boolean>(false);

  readonly close = output<void>();
  readonly selectCategory = output<{ categoryId: string; additive: boolean }>();
  readonly selectInverse = output<string>();
  readonly selectAll = output<void>();
  readonly deselectAll = output<void>();
  readonly enterSampleMode = output<void>();
  readonly deleteCategory = output<string>();
  /** Delete/restore every block of a class — what decides whether the class
   *  reaches exported.epub, now that no category excludes itself. */
  readonly deleteCategoryBlocks = output<string>();
  readonly restoreCategoryBlocks = output<string>();
  readonly editCategory = output<string>();
  readonly clearCorrections = output<void>();
  readonly showCategoryColorsChange = output<boolean>();
  readonly exportTrainingData = output<void>();
  readonly resetLabels = output<void>();
  /** Put back labels saved before Detect's predictions overwrote them. */
  readonly restoreLabels = output<void>();
  readonly saveCorpusLabels = output<void>();
  readonly alignFromEpub = output<void>();
  readonly assignCategory = output<string>();

  /** True when the viewer has blocks selected — gates click-to-assign. */
  readonly hasSelection = computed(() => this.selectedBlockIds().length > 0);

  /** The exact file Save labels writes, so the user never has to infer it. */
  readonly corpusLabelsPath = computed(() => {
    const dir = this.corpusDir();
    if (!dir) return 'labels.json';
    return `${dir.replace(/[/\\]+$/, '')}/labels.json`;
  });
  readonly thresholdChange = output<{ path: string; value: number }>();
  readonly recategorize = output<void>();
  readonly resetThresholds = output<void>();

  // Regex builder outputs, forwarded to the shell
  readonly regexCriteriaChange = output<RegexCriteria>();
  readonly regexCreate = output<RegexCriteria>();
  readonly regexExpandedChange = output<boolean>();

  readonly customExpanded = signal(false);
  readonly contextMenu = signal<{ x: number; y: number; categoryId: string } | null>(null);

  private readonly thresholdCategories = new Set([
    'header', 'footer', 'footnote_ref', 'footnote', 'caption', 'title', 'heading', 'subheading', 'quote',
  ]);

  /** Categories present in the document that expose tunable thresholds. */
  readonly thresholdCategoriesPresent = computed(() =>
    this.categories().filter(c => this.thresholdCategories.has(c.id))
  );

  /** Per class: how many blocks exist, and how many of those are deleted. */
  private readonly liveCounts = computed(() => {
    const deleted = this.deletedBlockIds();
    const counts = new Map<string, { total: number; deleted: number }>();
    for (const block of this.blocks()) {
      const c = counts.get(block.category_id) ?? { total: 0, deleted: 0 };
      c.total++;
      if (deleted.has(block.id)) c.deleted++;
      counts.set(block.category_id, c);
    }
    return counts;
  });

  getLiveCount(categoryId: string): { total: number; deleted: number } {
    return this.liveCounts().get(categoryId) ?? { total: 0, deleted: 0 };
  }

  /** True when every block of the class is already deleted. */
  isCategoryFullyDeleted(categoryId: string): boolean {
    const c = this.getLiveCount(categoryId);
    return c.total > 0 && c.deleted === c.total;
  }

  private readonly selectionCounts = computed(() => {
    const counts = new Map<string, number>();
    const selected = new Set(this.selectedBlockIds());
    for (const block of this.blocks()) {
      if (selected.has(block.id)) {
        counts.set(block.category_id, (counts.get(block.category_id) || 0) + 1);
      }
    }
    return counts;
  });

  hasBlocks(): boolean {
    return this.blocks().length > 0;
  }

  getSelectedCount(categoryId: string): number {
    return this.selectionCounts().get(categoryId) || 0;
  }

  isCustomCategory(categoryId: string): boolean {
    return categoryId.startsWith('custom_sample_') || categoryId.startsWith('custom_regex_');
  }

  toggleCustomSection(): void {
    this.customExpanded.update(v => !v);
  }

  /** Called by the shell after a custom category is created. */
  collapseCustomSection(): void {
    this.customExpanded.set(false);
  }

  onCategoryClick(event: MouseEvent, categoryId: string): void {
    // While labelling, the category list is the palette: clicking a category
    // applies it to the selection. Highlighting blocks by category is a
    // production-cleanup gesture and would waste the most natural click in
    // the labelling loop.
    if (this.labelMode() && this.hasSelection()) {
      this.assignCategory.emit(categoryId);
      return;
    }
    this.selectCategory.emit({ categoryId, additive: event.metaKey || event.ctrlKey });
  }

  onContextMenuDeleteBlocks(): void {
    const menu = this.contextMenu();
    if (!menu) return;
    this.deleteCategoryBlocks.emit(menu.categoryId);
    this.closeContextMenu();
  }

  onContextMenuRestoreBlocks(): void {
    const menu = this.contextMenu();
    if (!menu) return;
    this.restoreCategoryBlocks.emit(menu.categoryId);
    this.closeContextMenu();
  }

  onCategoryRightClick(event: MouseEvent, categoryId: string): void {
    event.preventDefault();
    this.contextMenu.set({ x: event.clientX, y: event.clientY, categoryId });
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
      // Open the custom-category section so the loaded form is visible.
      this.customExpanded.set(true);
      this.editCategory.emit(menu.categoryId);
      this.closeContextMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.closeContextMenu();
  }

  // --- Threshold controls (raw knobs, shown in the Advanced slot) ---

  getThresholdControls(categoryId: string): ThresholdControl[] {
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
}

import { Component, input, output, computed, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DesktopButtonComponent, DesktopSelectComponent, DesktopSelectItems,
} from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';

export type DetectBackend = 'ollama' | 'service';

/** The palette rows, in the same shape Select mode uses. */
export interface DetectCategory {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface DetectRunState {
  readonly running: boolean;
  /** Pages classified so far, for the progress line. */
  readonly done: number;
  readonly total: number;
  /** Non-empty when the last run failed; shown verbatim, never swallowed. */
  readonly error: string;
  /** Blocks currently predicted (0 = nothing loaded). */
  readonly predicted: number;
  /** Which adapter answered, as reported by the service. */
  readonly adapter: string;
}

/**
 * Detect panel — run the fine-tuned category model over the open book and draw
 * its predictions on the page.
 *
 * Shaped like Select mode on purpose: the settings collapse into a small box at
 * the top and the category list is the body of the panel, so the question you
 * actually ask here — "what did the model call this block?" — is answered the
 * same way it is answered everywhere else. Clicking a block on the page lights
 * up its predicted category in the list; clicking a category selects every
 * block the model gave that label.
 *
 * This is a PREVIEW. Predictions live in memory and are painted with the same
 * colours Label mode uses, but they are never written to `category_corrections`
 * and never touch the project file. That is deliberate while the model is being
 * evaluated: looking at its output must not risk the hand-labelling the model
 * is being trained from.
 */
@Component({
  selector: 'app-detect-panel',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DesktopButtonComponent, DesktopSelectComponent,
    PanelShellComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell title="Detect Categories" [statusLine]="statusLine()" (close)="done.emit()">

      <!-- Settings: small, collapsible, and out of the way once a run lands -->
      <div class="settings-box" [class.open]="settingsOpen()">
        <button type="button" class="settings-head" (click)="toggleSettings()">
          <span class="chevron">{{ settingsOpen() ? '▾' : '▸' }}</span>
          <span class="settings-title">Model</span>
          <span class="settings-summary">{{ settingsSummary() }}</span>
        </button>

        @if (settingsOpen()) {
          <div class="settings-body">
            <div class="field">
              <label class="field-label">Where the model runs</label>
              <div class="backend-toggle">
                <button
                  type="button"
                  class="backend-option"
                  [class.active]="backend() === 'ollama'"
                  [disabled]="state().running"
                  (click)="backendChange.emit('ollama')"
                >Ollama (local)</button>
                <button
                  type="button"
                  class="backend-option"
                  [class.active]="backend() === 'service'"
                  [disabled]="state().running"
                  (click)="backendChange.emit('service')"
                >Remote GPU</button>
              </div>
            </div>

            @if (backend() === 'ollama') {
              <div class="field">
                <label class="field-label" for="detect-model">Ollama model</label>
                <desktop-select
                  id="detect-model"
                  size="sm"
                  placeholder="Choose a model…"
                  [options]="models()"
                  [ngModel]="model()"
                  [disabled]="state().running"
                  (valueChange)="modelChange.emit($event)"
                />
                @if (!isTrainedModel()) {
                  <div class="warn">
                    This model was not fine-tuned for block categories. It will be
                    sent a prompt written for the trained model and is very likely
                    to answer with something unusable.
                  </div>
                }
              </div>
            }

            <div class="field">
              <label class="field-label" for="detect-endpoint">Endpoint</label>
              <input
                id="detect-endpoint"
                class="field-input"
                type="text"
                [ngModel]="endpoint()"
                (ngModelChange)="endpointChange.emit($event)"
                [disabled]="state().running"
                [placeholder]="backend() === 'ollama' ? 'http://localhost:11434' : 'http://owens-pc:8770'"
              />
            </div>

            <div class="intro">
              Predictions are painted on the page but never saved — this is a look
              at the model, not an edit.
            </div>
          </div>
        }

        <div class="actions">
          <desktop-button
            variant="primary"
            size="sm"
            [disabled]="state().running || !endpoint() || (backend() === 'ollama' && !model())"
            (click)="onLoad()"
          >
            {{ state().running ? 'Loading…' : 'Load categories' }}
          </desktop-button>
          @if (state().predicted > 0 && !state().running) {
            <desktop-button variant="secondary" size="sm" (click)="clear.emit()">
              Clear
            </desktop-button>
          }
        </div>
      </div>

      @if (state().running) {
        <div class="status-box info">
          Classifying page {{ state().done }} of {{ state().total }}…
        </div>
      }

      @if (state().error) {
        <div class="status-box error">{{ state().error }}</div>
      }

      <!-- What the click on the page landed on -->
      @if (selectedBlockIds().length > 0) {
        <div class="selection-readout">
          <div class="selection-head">
            {{ selectedBlockIds().length }} block{{ selectedBlockIds().length === 1 ? '' : 's' }} selected
          </div>
          @if (selectedBreakdown().length > 0) {
            <div class="selection-cats">
              @for (row of selectedBreakdown(); track row.id) {
                <span class="selection-chip">
                  <span class="chip-dot" [style.background]="row.color"></span>
                  {{ row.name }}
                  @if (row.count > 1) { <span class="chip-count">×{{ row.count }}</span> }
                </span>
              }
            </div>
          } @else {
            <div class="selection-none">The model gave no label for this block.</div>
          }
        </div>
      }

      <!-- Predicted categories -->
      @if (state().predicted > 0) {
        <div class="list-head">
          <span>Predicted categories</span>
          <span class="list-total">{{ state().predicted | number }} blocks</span>
        </div>
        <div class="categories-list">
          @for (cat of rows(); track cat.id) {
            <div
              class="category-item"
              [class.empty]="cat.count === 0"
              [class.has-selection]="cat.selected > 0"
              [title]="cat.count > 0 ? 'Select every block the model called ' + cat.name : ''"
              (click)="onCategoryClick($event, cat)"
            >
              <div class="category-color" [style.background]="cat.color"></div>
              <div class="category-info">
                <div class="category-name">{{ cat.name }}</div>
                <div class="category-meta">
                  {{ cat.count | number }} block{{ cat.count === 1 ? '' : 's' }}
                  @if (cat.selected > 0) {
                    <span class="selection-count">({{ cat.selected }} selected)</span>
                  }
                </div>
              </div>
            </div>
          }
        </div>
        <div class="hint">
          Click a category to select every block the model put in it. Switch to
          Label mode to correct anything it got wrong — corrections there are
          saved, these are not.
        </div>
      } @else if (!state().running && !state().error) {
        <div class="empty-state">
          Run the model to see what it predicts for this book.
        </div>
      }
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    /* The shell is the flex child of the pane host, not this wrapper. */
    :host { display: contents; }

    .settings-box {
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      background: var(--bg-elevated);
      margin-bottom: var(--ui-spacing-md);
    }

    .settings-head {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      width: 100%;
      background: none;
      border: none;
      cursor: pointer;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      text-align: left;
    }
    .settings-head:hover { color: var(--text-primary); }
    .chevron { color: var(--text-tertiary); }
    .settings-title { font-weight: $font-weight-medium; }
    .settings-summary {
      flex: 1;
      min-width: 0;
      text-align: right;
      color: var(--text-tertiary);
      font-size: var(--ui-font-xs);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .settings-body {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
      padding: 0 var(--ui-spacing-md) var(--ui-spacing-sm);
    }

    .intro {
      font-size: var(--ui-font-xs);
      line-height: 1.5;
      color: var(--text-tertiary);
    }

    .field { display: flex; flex-direction: column; gap: 5px; }
    .field-label {
      font-size: var(--ui-font-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-tertiary);
    }
    .field-input {
      background: var(--bg-input, var(--bg-surface));
      border: 1px solid var(--border-subtle);
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      padding: 6px 8px;
    }
    .field-input:disabled { opacity: 0.5; }

    .actions {
      display: flex;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md) var(--ui-spacing-md);
    }

    .backend-toggle { display: flex; }
    .backend-option {
      flex: 1;
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      border: 1px solid var(--border-subtle);
      font-size: var(--ui-font-xs);
      padding: 5px 8px;
    }
    .backend-option:first-child { border-radius: $radius-sm 0 0 $radius-sm; }
    .backend-option:last-child { border-radius: 0 $radius-sm $radius-sm 0; border-left: none; }
    .backend-option.active {
      background: var(--accent);
      color: var(--accent-contrast, #111);
      font-weight: $font-weight-semibold;
    }
    .backend-option:disabled { opacity: 0.5; cursor: default; }

    .status-box {
      border-radius: $radius-sm;
      font-size: var(--ui-font-sm);
      line-height: 1.45;
      padding: 8px 10px;
      margin-bottom: var(--ui-spacing-md);
    }
    .status-box.info { background: rgba(33,150,243,0.12); color: #64b5f6; }
    .status-box.error {
      background: rgba(244,67,54,0.12);
      color: #e57373;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .selection-readout {
      border: 1px solid var(--accent);
      background: var(--accent-subtle);
      border-radius: $radius-md;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      margin-bottom: var(--ui-spacing-md);
    }
    .selection-head {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      margin-bottom: 4px;
    }
    .selection-cats { display: flex; flex-wrap: wrap; gap: var(--ui-spacing-xs); }
    .selection-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      font-weight: $font-weight-medium;
    }
    .chip-dot { width: 10px; height: 10px; border-radius: 3px; }
    .chip-count { color: var(--text-tertiary); font-weight: $font-weight-regular; }
    .selection-none { font-size: var(--ui-font-sm); color: var(--text-tertiary); }

    .list-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: var(--ui-font-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-tertiary);
      margin-bottom: var(--ui-spacing-sm);
    }
    .list-total { text-transform: none; letter-spacing: 0; }

    .categories-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
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

      &:hover { border-color: var(--border-default); background: var(--hover-bg); }
      &:active { transform: scale(0.98); }

      &.empty { opacity: 0.4; cursor: default; }
      &.empty:active { transform: none; }

      &.has-selection {
        border-color: var(--accent);
        background: var(--accent-subtle);

        .category-color { box-shadow: 0 0 0 2px var(--accent); }
      }
    }

    .category-color {
      width: var(--ui-icon-size-sm);
      height: var(--ui-icon-size-sm);
      border-radius: $radius-sm;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .category-info { flex: 1; min-width: 0; }
    .category-name {
      font-size: var(--ui-font-base);
      font-weight: $font-weight-medium;
      color: var(--text-primary);
      margin-bottom: 2px;
    }
    .category-meta { font-size: var(--ui-font-xs); color: var(--text-tertiary); }
    .selection-count { color: var(--accent); font-weight: $font-weight-medium; }

    .hint {
      font-size: var(--ui-font-xs);
      line-height: 1.5;
      color: var(--text-tertiary);
      margin-top: var(--ui-spacing-md);
    }

    .empty-state {
      font-size: var(--ui-font-sm);
      line-height: 1.5;
      color: var(--text-tertiary);
      text-align: center;
      padding: var(--ui-spacing-lg) 0;
    }
  `],
})
export class DetectPanelComponent {
  readonly state = input.required<DetectRunState>();
  readonly endpoint = input.required<string>();
  readonly backend = input.required<DetectBackend>();
  readonly model = input.required<string>();
  /** Grouped: the trained models first, everything else under a warning label. */
  readonly models = input.required<DesktopSelectItems>();
  /** False when the chosen model is not one of the block-category fine-tunes. */
  readonly isTrainedModel = input.required<boolean>();
  /** The same palette Select and Label use, so a colour means one thing. */
  readonly categories = input<readonly DetectCategory[]>([]);
  /** blockId → predicted categoryId. */
  readonly predictions = input<Map<string, string>>(new Map());
  readonly selectedBlockIds = input<readonly string[]>([]);

  readonly endpointChange = output<string>();
  readonly backendChange = output<DetectBackend>();
  readonly modelChange = output<string>();
  readonly loadCategories = output<void>();
  readonly clear = output<void>();
  readonly selectCategory = output<{ categoryId: string; additive: boolean }>();
  readonly done = output<void>();

  /**
   * Open until the user starts a run, then folded away so the category list
   * gets the room. Folded on the click rather than on the result: the fold is
   * then something the user did, not something that happens to the panel while
   * they are reading it.
   */
  readonly settingsOpen = signal(true);

  toggleSettings(): void {
    this.settingsOpen.update(open => !open);
  }

  onLoad(): void {
    this.settingsOpen.set(false);
    this.loadCategories.emit();
  }

  readonly settingsSummary = computed(() => {
    const where = this.backend() === 'ollama' ? this.model() || 'no model' : this.endpoint();
    return this.backend() === 'ollama' ? `${where} · local` : `${where} · remote`;
  });

  readonly statusLine = computed(() => {
    const s = this.state();
    if (s.running) return `classifying page ${s.done} of ${s.total}`;
    if (s.predicted > 0) return `${s.predicted} blocks predicted · preview only`;
    return 'preview only — nothing is saved';
  });

  /** How many blocks the model put in each category. */
  private readonly counts = computed(() => {
    const out = new Map<string, number>();
    for (const categoryId of this.predictions().values()) {
      out.set(categoryId, (out.get(categoryId) ?? 0) + 1);
    }
    return out;
  });

  /** Of the current selection, how many fall in each predicted category. */
  private readonly selectedCounts = computed(() => {
    const preds = this.predictions();
    const out = new Map<string, number>();
    for (const id of this.selectedBlockIds()) {
      const categoryId = preds.get(id);
      if (categoryId) out.set(categoryId, (out.get(categoryId) ?? 0) + 1);
    }
    return out;
  });

  /**
   * Every category in the palette, biggest first, empties last. The full list
   * stays visible so a class the model never predicts reads as a zero rather
   * than as a row that silently went missing — that absence is a finding.
   */
  readonly rows = computed(() => {
    const counts = this.counts();
    const selected = this.selectedCounts();
    return this.categories()
      .map(cat => ({
        ...cat,
        count: counts.get(cat.id) ?? 0,
        selected: selected.get(cat.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count);
  });

  /** The predicted categories of whatever is selected on the page. */
  readonly selectedBreakdown = computed(() => {
    const selected = this.selectedCounts();
    return this.categories()
      .filter(cat => selected.has(cat.id))
      .map(cat => ({ ...cat, count: selected.get(cat.id)! }))
      .sort((a, b) => b.count - a.count);
  });

  onCategoryClick(event: MouseEvent, cat: { id: string; count: number }): void {
    if (cat.count === 0) return;
    this.selectCategory.emit({
      categoryId: cat.id,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    });
  }
}

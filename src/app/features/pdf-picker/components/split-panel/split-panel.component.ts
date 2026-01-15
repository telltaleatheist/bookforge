import { Component, input, output, signal, computed, effect, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface SplitConfig {
  enabled: boolean;
  oddPageSplit: number;   // 0-1 percentage from left
  evenPageSplit: number;  // 0-1 percentage from left
  pageOverrides: Record<number, number>;  // page number -> split position override
  skippedPages: Set<number>;  // pages to NOT split (user unchecked)
  readingOrder: 'left-to-right' | 'right-to-left';
}

@Component({
  selector: 'app-split-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Split Pages</h3>
      <desktop-button variant="ghost" size="xs" (click)="cancel.emit()">Cancel</desktop-button>
    </div>

    <div class="panel-content">
      <!-- Info Box -->
      <div class="info-box">
        <div class="info-icon">📖</div>
        <div class="info-text">
          For scanned book spreads where each scan contains two pages side-by-side.
          Adjust the split line on each page, then click Apply.
        </div>
      </div>
        <!-- Page Navigation -->
        <div class="nav-section">
          <div class="nav-label">Preview Page</div>
          <div class="nav-controls">
            <desktop-button
              variant="secondary"
              size="sm"
              [disabled]="currentPage() <= 0"
              (click)="prevPage.emit()"
            >
              ← Prev
            </desktop-button>
            <span class="page-indicator">{{ currentPage() + 1 }} / {{ totalPages() }}</span>
            <desktop-button
              variant="secondary"
              size="sm"
              [disabled]="currentPage() >= totalPages() - 1"
              (click)="nextPage.emit()"
            >
              Next →
            </desktop-button>
          </div>
        </div>

        <!-- Split Position Controls -->
        <div class="split-controls">
          <div class="section-label">Global Split Positions</div>

          <div class="slider-group">
            <label class="slider-label">
              <span>Odd pages (1, 3, 5...)</span>
              <span class="slider-value">{{ (config().oddPageSplit * 100).toFixed(0) }}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              [value]="config().oddPageSplit * 100"
              (input)="onOddSliderChange($event)"
            />
          </div>

          <div class="slider-group">
            <label class="slider-label">
              <span>Even pages (2, 4, 6...)</span>
              <span class="slider-value">{{ (config().evenPageSplit * 100).toFixed(0) }}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              [value]="config().evenPageSplit * 100"
              (input)="onEvenSliderChange($event)"
            />
          </div>

          <div class="link-toggle">
            <label class="checkbox-option">
              <input
                type="checkbox"
                [checked]="linkSliders()"
                (change)="linkSliders.set(!linkSliders())"
              />
              <span>Link odd/even positions</span>
            </label>
          </div>
        </div>

        <!-- Current Page Override -->
        <div class="override-section">
          <div class="section-label">Current Page Override</div>
          <div class="override-info">
            @if (hasOverride(currentPage())) {
              <span class="override-badge">Custom: {{ (getOverride(currentPage()) * 100).toFixed(0) }}%</span>
              <desktop-button variant="ghost" size="xs" (click)="clearOverride(currentPage())">
                Reset
              </desktop-button>
            } @else {
              <span class="no-override">Using {{ isOddPage(currentPage()) ? 'odd' : 'even' }} page setting</span>
            }
          </div>
          <div class="override-hint">
            Drag the split line on the page to create an override for this page only.
          </div>
        </div>

        <!-- All Overrides List -->
        @if (hasAnyOverrides()) {
          <div class="overrides-list">
            <div class="section-label">Page Overrides</div>
            @for (pageNum of getOverridePages(); track pageNum) {
              <div class="override-item">
                <span class="override-page">Page {{ pageNum + 1 }}</span>
                <span class="override-value">{{ (getOverride(pageNum) * 100).toFixed(0) }}%</span>
                <desktop-button variant="ghost" size="xs" (click)="clearOverride(pageNum)">×</desktop-button>
              </div>
            }
            <desktop-button
              variant="ghost"
              size="sm"
              (click)="clearAllOverrides()"
              class="clear-all-btn"
            >
              Clear all overrides
            </desktop-button>
          </div>
        }

        <!-- Reading Order -->
        <div class="order-section">
          <div class="section-label">Reading Order</div>
          <div class="order-options">
            <label class="radio-option">
              <input
                type="radio"
                name="readingOrder"
                value="left-to-right"
                [checked]="config().readingOrder === 'left-to-right'"
                (change)="setReadingOrder('left-to-right')"
              />
              <span>Left to Right (Western)</span>
            </label>
            <label class="radio-option">
              <input
                type="radio"
                name="readingOrder"
                value="right-to-left"
                [checked]="config().readingOrder === 'right-to-left'"
                (change)="setReadingOrder('right-to-left')"
              />
              <span>Right to Left (RTL/Manga)</span>
            </label>
          </div>
        </div>

        <!-- Result Preview -->
        <div class="preview-section">
          <div class="section-label">Result Preview</div>
          <div class="preview-info">
            <div class="preview-stat">
              <span class="stat-label">Original pages:</span>
              <span class="stat-value">{{ totalPages() }}</span>
            </div>
            <div class="preview-stat">
              <span class="stat-label">After split:</span>
              <span class="stat-value">{{ totalPages() * 2 }} pages</span>
            </div>
          </div>
          <div class="preview-hint">
            Each original page will become 2 pages (left half, right half).
          </div>
        </div>

        <!-- Apply Button -->
        <div class="apply-section">
          <desktop-button variant="primary" size="md" (click)="apply.emit()">
            Apply Split
          </desktop-button>
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

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-lg);
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .info-box {
      display: flex;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      border: 1px solid var(--border-subtle);
    }

    .info-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .info-text {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .toggle-section {
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
    }

    .toggle-option {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      cursor: pointer;

      input[type="checkbox"] {
        width: 20px;
        height: 20px;
        cursor: pointer;
        accent-color: var(--accent);
      }

      .toggle-label {
        font-size: var(--ui-font-base);
        font-weight: $font-weight-medium;
        color: var(--text-primary);
      }
    }

    .nav-section, .split-controls, .override-section, .order-section, .preview-section, .overrides-list {
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
    }

    .nav-label, .section-label {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--text-secondary);
      margin-bottom: var(--ui-spacing-sm);
    }

    .nav-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ui-spacing-sm);
    }

    .page-indicator {
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      font-weight: $font-weight-medium;
    }

    .slider-group {
      margin-bottom: var(--ui-spacing-md);

      .slider-label {
        display: flex;
        justify-content: space-between;
        font-size: var(--ui-font-sm);
        color: var(--text-primary);
        margin-bottom: var(--ui-spacing-xs);
      }

      .slider-value {
        color: var(--accent);
        font-weight: $font-weight-medium;
      }

      input[type="range"] {
        width: 100%;
        height: 8px;
        -webkit-appearance: none;
        background: var(--bg-surface);
        border-radius: 4px;
        cursor: pointer;

        &::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          background: var(--accent);
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        &::-webkit-slider-runnable-track {
          height: 8px;
          border-radius: 4px;
        }
      }
    }

    .link-toggle {
      padding-top: var(--ui-spacing-sm);
      border-top: 1px solid var(--border-subtle);
    }

    .checkbox-option, .radio-option {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      cursor: pointer;

      input {
        width: 16px;
        height: 16px;
        cursor: pointer;
        accent-color: var(--accent);
      }
    }

    .override-info {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-sm);
    }

    .override-badge {
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--accent-muted);
      color: var(--accent);
      border-radius: $radius-sm;
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
    }

    .no-override {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .override-hint {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .overrides-list {
      .override-item {
        display: flex;
        align-items: center;
        gap: var(--ui-spacing-sm);
        padding: var(--ui-spacing-xs) 0;
        border-bottom: 1px solid var(--border-subtle);

        &:last-of-type {
          border-bottom: none;
        }
      }

      .override-page {
        flex: 1;
        font-size: var(--ui-font-sm);
        color: var(--text-primary);
      }

      .override-value {
        font-size: var(--ui-font-sm);
        color: var(--accent);
        font-weight: $font-weight-medium;
      }

      .clear-all-btn {
        margin-top: var(--ui-spacing-sm);
        width: 100%;
      }
    }

    .order-options {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .preview-section {
      .preview-info {
        display: flex;
        flex-direction: column;
        gap: var(--ui-spacing-xs);
        margin-bottom: var(--ui-spacing-sm);
      }

      .preview-stat {
        display: flex;
        justify-content: space-between;
        font-size: var(--ui-font-sm);
      }

      .stat-label {
        color: var(--text-secondary);
      }

      .stat-value {
        color: var(--text-primary);
        font-weight: $font-weight-medium;
      }

      .preview-hint {
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
        padding-top: var(--ui-spacing-sm);
        border-top: 1px solid var(--border-subtle);
      }
    }

    .apply-section {
      margin-top: auto;
      padding-top: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);

      desktop-button {
        width: 100%;
      }
    }
  `]
})
export class SplitPanelComponent {
  config = input.required<SplitConfig>();
  currentPage = input.required<number>();
  totalPages = input.required<number>();

  prevPage = output<void>();
  nextPage = output<void>();
  cancel = output<void>();
  apply = output<void>();
  configChange = output<SplitConfig>();

  // Local state
  readonly linkSliders = signal(true);

  // Sync linked sliders
  constructor() {
    effect(() => {
      // When config changes externally, nothing special needed
      this.config();
    });
  }

  onOddSliderChange(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber / 100;
    if (this.linkSliders()) {
      this.emitConfigChange({ oddPageSplit: value, evenPageSplit: value });
    } else {
      this.emitConfigChange({ oddPageSplit: value });
    }
  }

  onEvenSliderChange(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber / 100;
    if (this.linkSliders()) {
      this.emitConfigChange({ oddPageSplit: value, evenPageSplit: value });
    } else {
      this.emitConfigChange({ evenPageSplit: value });
    }
  }

  setReadingOrder(order: 'left-to-right' | 'right-to-left'): void {
    this.emitConfigChange({ readingOrder: order });
  }

  isOddPage(pageNum: number): boolean {
    return (pageNum + 1) % 2 === 1;
  }

  hasOverride(pageNum: number): boolean {
    return pageNum in this.config().pageOverrides;
  }

  getOverride(pageNum: number): number {
    return this.config().pageOverrides[pageNum] ??
      (this.isOddPage(pageNum) ? this.config().oddPageSplit : this.config().evenPageSplit);
  }

  clearOverride(pageNum: number): void {
    const newOverrides = { ...this.config().pageOverrides };
    delete newOverrides[pageNum];
    this.emitConfigChange({ pageOverrides: newOverrides });
  }

  clearAllOverrides(): void {
    this.emitConfigChange({ pageOverrides: {} });
  }

  hasAnyOverrides(): boolean {
    return Object.keys(this.config().pageOverrides).length > 0;
  }

  getOverridePages(): number[] {
    return Object.keys(this.config().pageOverrides)
      .map(k => parseInt(k, 10))
      .sort((a, b) => a - b);
  }

  setOverride(pageNum: number, value: number): void {
    const newOverrides = { ...this.config().pageOverrides, [pageNum]: value };
    this.emitConfigChange({ pageOverrides: newOverrides });
  }

  private emitConfigChange(changes: Partial<SplitConfig>): void {
    this.configChange.emit({ ...this.config(), ...changes });
  }
}

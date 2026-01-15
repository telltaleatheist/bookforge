import { Component, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { CropRect } from '../pdf-viewer/pdf-viewer.component';

export interface CropApplyOptions {
  mode: 'all' | 'current' | 'range';
  rangeText: string;
  includeEven: boolean;
  includeOdd: boolean;
}

@Component({
  selector: 'app-crop-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Crop Pages</h3>
      <desktop-button variant="ghost" size="xs" (click)="cancel.emit()">Cancel</desktop-button>
    </div>

    <div class="panel-content">
      <!-- Page Navigation -->
      <div class="nav-section">
        <div class="nav-label">Navigate Pages</div>
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

      <!-- Crop Status -->
      <div class="crop-status">
        @if (cropRect()) {
          <div class="status-box success">
            ✓ Crop region defined
          </div>
        } @else {
          <div class="status-box info">
            Draw a rectangle on the page to define the crop region
          </div>
        }
      </div>

      <!-- Apply To Section -->
      <div class="apply-section">
        <div class="section-label">Apply To</div>

        <div class="option-group">
          <label class="radio-option">
            <input
              type="radio"
              name="applyMode"
              value="all"
              [checked]="applyMode() === 'all'"
              (change)="applyMode.set('all')"
            />
            <span>All pages</span>
          </label>

          <label class="radio-option">
            <input
              type="radio"
              name="applyMode"
              value="current"
              [checked]="applyMode() === 'current'"
              (change)="applyMode.set('current')"
            />
            <span>Current page only</span>
          </label>

          <label class="radio-option">
            <input
              type="radio"
              name="applyMode"
              value="range"
              [checked]="applyMode() === 'range'"
              (change)="applyMode.set('range')"
            />
            <span>Custom range</span>
          </label>
        </div>

        @if (applyMode() === 'range') {
          <div class="range-input">
            <input
              type="text"
              placeholder="e.g., 1-3, 5, 7-10"
              [ngModel]="rangeText()"
              (ngModelChange)="rangeText.set($event)"
            />
            <span class="range-hint">Separate ranges with commas</span>
          </div>
        }

        <div class="modifier-options">
          <label class="checkbox-option">
            <input
              type="checkbox"
              [checked]="evenOnly()"
              (change)="onEvenChange($event)"
            />
            <span>Even pages only</span>
          </label>

          <label class="checkbox-option">
            <input
              type="checkbox"
              [checked]="oddOnly()"
              (change)="onOddChange($event)"
            />
            <span>Odd pages only</span>
          </label>
        </div>

        <div class="pages-preview">
          Will apply to: <strong>{{ previewPages() }}</strong>
        </div>
      </div>
    </div>

    <div class="panel-footer">
      <desktop-button
        variant="primary"
        size="md"
        [disabled]="!cropRect() || targetPageCount() === 0"
        (click)="onApply()"
      >
        Apply Crop to {{ targetPageCount() }} page{{ targetPageCount() !== 1 ? 's' : '' }}
      </desktop-button>
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
    }

    .nav-section {
      margin-bottom: var(--ui-spacing-lg);
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

    .crop-status {
      margin-bottom: var(--ui-spacing-lg);
    }

    .status-box {
      padding: var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);
      text-align: center;

      &.info {
        background: var(--bg-elevated);
        color: var(--text-secondary);
        border: 1px dashed var(--border-default);
      }

      &.success {
        background: rgba(76, 175, 80, 0.1);
        color: #4CAF50;
        border: 1px solid rgba(76, 175, 80, 0.3);
      }
    }

    .apply-section {
      background: var(--bg-elevated);
      border-radius: $radius-md;
      padding: var(--ui-spacing-md);
    }

    .option-group {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-md);
    }

    .radio-option, .checkbox-option {
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
      }
    }

    .range-input {
      margin-bottom: var(--ui-spacing-md);

      input {
        width: 100%;
        padding: var(--ui-spacing-sm) var(--ui-spacing-md);
        border: 1px solid var(--border-default);
        border-radius: $radius-md;
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

      .range-hint {
        display: block;
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
        margin-top: var(--ui-spacing-xs);
      }
    }

    .modifier-options {
      display: flex;
      gap: var(--ui-spacing-lg);
      padding-top: var(--ui-spacing-md);
      border-top: 1px solid var(--border-subtle);
      margin-bottom: var(--ui-spacing-md);
    }

    .pages-preview {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      padding: var(--ui-spacing-sm);
      background: var(--bg-surface);
      border-radius: $radius-sm;

      strong {
        color: var(--text-primary);
      }
    }

    .panel-footer {
      padding: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);

      desktop-button {
        width: 100%;
      }
    }
  `]
})
export class CropPanelComponent {
  currentPage = input.required<number>();
  totalPages = input.required<number>();
  cropRect = input<CropRect | null>(null);

  prevPage = output<void>();
  nextPage = output<void>();
  cancel = output<void>();
  apply = output<{ pages: number[]; cropRect: CropRect }>();

  // State
  readonly applyMode = signal<'all' | 'current' | 'range'>('all');
  readonly rangeText = signal('');
  readonly evenOnly = signal(false);
  readonly oddOnly = signal(false);

  // Compute target pages
  readonly targetPages = computed(() => {
    let pages: number[] = [];
    const total = this.totalPages();

    switch (this.applyMode()) {
      case 'all':
        pages = Array.from({ length: total }, (_, i) => i);
        break;
      case 'current':
        pages = [this.currentPage()];
        break;
      case 'range':
        pages = this.parseRange(this.rangeText(), total);
        break;
    }

    // Apply even/odd filters
    if (this.evenOnly() && !this.oddOnly()) {
      pages = pages.filter(p => (p + 1) % 2 === 0); // Even pages (1-indexed)
    } else if (this.oddOnly() && !this.evenOnly()) {
      pages = pages.filter(p => (p + 1) % 2 === 1); // Odd pages (1-indexed)
    }

    return pages;
  });

  readonly targetPageCount = computed(() => this.targetPages().length);

  readonly previewPages = computed(() => {
    const pages = this.targetPages();
    if (pages.length === 0) return 'no pages';
    if (pages.length === this.totalPages()) return 'all pages';
    if (pages.length <= 10) {
      return pages.map(p => p + 1).join(', ');
    }
    return `${pages.length} pages`;
  });

  onEvenChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.evenOnly.set(checked);
    if (checked) this.oddOnly.set(false);
  }

  onOddChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.oddOnly.set(checked);
    if (checked) this.evenOnly.set(false);
  }

  onApply(): void {
    const rect = this.cropRect();
    if (!rect) return;

    this.apply.emit({
      pages: this.targetPages(),
      cropRect: rect
    });
  }

  private parseRange(text: string, max: number): number[] {
    const pages = new Set<number>();
    const parts = text.split(',').map(s => s.trim()).filter(s => s);

    for (const part of parts) {
      if (part.includes('-')) {
        const [startStr, endStr] = part.split('-').map(s => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.max(1, start); i <= Math.min(max, end); i++) {
            pages.add(i - 1); // Convert to 0-indexed
          }
        }
      } else {
        const num = parseInt(part, 10);
        if (!isNaN(num) && num >= 1 && num <= max) {
          pages.add(num - 1); // Convert to 0-indexed
        }
      }
    }

    return Array.from(pages).sort((a, b) => a - b);
  }
}

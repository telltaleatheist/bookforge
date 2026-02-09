import {
  Component,
  input,
  output,
  computed,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Interface for a workflow tab definition
 */
export interface WorkflowTab {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  finalized?: boolean;    // Gate for articles - tab only accessible after finalization
  hidden?: boolean;       // Don't show in tab bar at all
  warning?: boolean;      // Show warning styling (orange)
  badge?: string | number; // Optional badge text/number
}

/**
 * Reusable workflow tabs component with Skip/Next pattern
 * Used by both Audiobook Producer and Articles features
 */
@Component({
  selector: 'app-workflow-tabs',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="workflow-tabs-container">
      <!-- Tab Bar -->
      <div class="workflow-tabs">
        @for (tab of visibleTabs(); track tab.id) {
          <button
            class="tab"
            [class.active]="tab.id === activeTabId()"
            [class.disabled]="tab.disabled || (requiresFinalization() && !tab.finalized && tab.id !== firstTabId())"
            [class.warning]="tab.warning"
            [disabled]="tab.disabled || (requiresFinalization() && !tab.finalized && tab.id !== firstTabId())"
            (click)="onTabClick(tab)"
          >
            @if (tab.icon) {
              <span class="tab-icon">{{ tab.icon }}</span>
            }
            {{ tab.label }}
            @if (tab.badge) {
              <span class="tab-badge">{{ tab.badge }}</span>
            }
          </button>
        }
      </div>

      <!-- Skip/Next Actions (optional) -->
      @if (showActions()) {
        <div class="workflow-actions">
          @if (canSkip()) {
            <button
              class="btn-skip"
              (click)="onSkip()"
              [disabled]="!canAdvance()"
            >
              Skip
            </button>
          }
          @if (showNext()) {
            <button
              class="btn-next"
              (click)="onNext()"
              [disabled]="!canAdvance()"
            >
              {{ nextLabel() }}
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .workflow-tabs-container {
      display: flex;
      align-items: center;
      border-bottom: 1px solid var(--border-default);
      padding: 0 1rem;
      gap: 0.5rem;
    }

    .workflow-tabs {
      display: flex;
      gap: 0.5rem;
      flex: 1;
      overflow-x: auto;
    }

    .tab {
      padding: 0.75rem 1rem;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 0.375rem;

      &:hover:not(:disabled) {
        color: var(--text-primary);
      }

      &.active {
        color: var(--accent-primary);
        border-bottom-color: var(--accent-primary);
      }

      &.disabled,
      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      &.warning {
        color: var(--warning, #f59e0b);

        &.active {
          color: var(--warning, #f59e0b);
          border-bottom-color: var(--warning, #f59e0b);
        }
      }
    }

    .tab-icon {
      font-size: 1rem;
    }

    .tab-badge {
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
      background: var(--accent-primary);
      color: white;
      border-radius: 10px;
      min-width: 1.25rem;
      text-align: center;
    }

    .workflow-actions {
      display: flex;
      gap: 0.5rem;
      padding-left: 1rem;
      border-left: 1px solid var(--border-default);
      margin-left: auto;
    }

    .btn-skip,
    .btn-next {
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    .btn-skip {
      background: none;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-next {
      background: var(--accent-primary);
      border: none;
      color: white;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }
    }
  `]
})
export class WorkflowTabsComponent {
  // Inputs
  readonly tabs = input.required<WorkflowTab[]>();
  readonly activeTabId = input.required<string>();
  readonly showActions = input<boolean>(false);
  readonly canSkip = input<boolean>(false);
  readonly showNext = input<boolean>(false);
  readonly nextLabel = input<string>('Next');
  readonly canAdvance = input<boolean>(true);
  readonly requiresFinalization = input<boolean>(false); // For articles - gate tabs

  // Outputs
  readonly tabChange = output<string>();
  readonly skip = output<void>();
  readonly next = output<void>();

  // Computed
  readonly visibleTabs = computed(() =>
    this.tabs().filter(tab => !tab.hidden)
  );

  readonly firstTabId = computed(() => {
    const visible = this.visibleTabs();
    return visible.length > 0 ? visible[0].id : '';
  });

  onTabClick(tab: WorkflowTab): void {
    if (!tab.disabled) {
      // Check finalization gate if required
      if (this.requiresFinalization() && !tab.finalized && tab.id !== this.firstTabId()) {
        return;
      }
      this.tabChange.emit(tab.id);
    }
  }

  onSkip(): void {
    this.skip.emit();
  }

  onNext(): void {
    this.next.emit();
  }
}

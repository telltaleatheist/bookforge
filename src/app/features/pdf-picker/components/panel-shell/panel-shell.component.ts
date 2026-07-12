import { Component, input, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

/**
 * Shared chrome for a right-pane task panel: a header with title + factual
 * status line and a close button, a scrollable body (default slot), an
 * optional collapsible "Advanced" section, and an optional footer slot.
 *
 * Content projection slots:
 *   - default          → main panel body
 *   - [advanced]       → collapsed-by-default "Advanced" section
 *   - [footer]         → pinned footer (actions)
 */
@Component({
  selector: 'app-panel-shell',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <div class="panel-heading">
        <h3 class="panel-title">{{ title() }}</h3>
        @if (statusLine()) {
          <span class="panel-status">{{ statusLine() }}</span>
        }
      </div>
      <desktop-button variant="ghost" size="xs" (click)="close.emit()">Close</desktop-button>
    </div>

    <div class="panel-content">
      <ng-content></ng-content>

      @if (hasAdvanced()) {
        <div class="advanced-section">
          <button type="button" class="advanced-toggle" (click)="toggleAdvanced()">
            <span class="advanced-chevron">{{ advancedOpen() ? '▾' : '▸' }}</span>
            <span>Advanced</span>
          </button>
          @if (advancedOpen()) {
            <div class="advanced-body">
              <ng-content select="[advanced]"></ng-content>
            </div>
          }
        </div>
      }
    </div>

    <div class="panel-footer">
      <ng-content select="[footer]"></ng-content>
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
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      min-height: var(--ui-panel-header);
      border-bottom: 1px solid var(--border-subtle);
    }

    .panel-heading {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .panel-title {
      font-size: var(--ui-font-lg);
      font-weight: $font-weight-semibold;
      margin: 0;
      color: var(--text-primary);
    }

    .panel-status {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-lg);
    }

    .advanced-section {
      margin-top: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      padding-top: var(--ui-spacing-md);
    }

    .advanced-toggle {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      background: none;
      border: none;
      padding: var(--ui-spacing-xs) 0;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
    }

    .advanced-toggle:hover {
      color: var(--text-primary);
    }

    .advanced-chevron {
      color: var(--text-tertiary);
    }

    .advanced-body {
      margin-top: var(--ui-spacing-sm);
    }

    .panel-footer:empty {
      display: none;
    }

    .panel-footer {
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
    }
  `]
})
export class PanelShellComponent {
  readonly title = input.required<string>();
  readonly statusLine = input<string>('');
  /** Whether an [advanced] slot is present — parent declares intent explicitly. */
  readonly hasAdvanced = input<boolean>(false);

  readonly close = output<void>();

  readonly advancedOpen = signal(false);

  toggleAdvanced(): void {
    this.advancedOpen.update(open => !open);
  }
}

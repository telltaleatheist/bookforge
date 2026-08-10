import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';

/**
 * Thin panel for merging adjacent blocks. The merge itself is the shell's
 * existing `mergeAdjacentBlocks()`; this panel just surfaces the factual count
 * of merges applied and the trigger.
 */
@Component({
  selector: 'app-merge-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent, PanelShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell
      title="Merge"
      [statusLine]="mergeCount() > 0 ? (mergeCount() + ' merge' + (mergeCount() === 1 ? '' : 's') + ' applied') : ''"
      (close)="close.emit()"
    >
      <div class="merge-body">
        <p class="merge-note">
          Combine adjacent blocks that a scan split apart — a heading stranded from its
          paragraph, or a sentence broken across two boxes. Merging joins them so the text
          reads and reflows as one block.
        </p>
        @if (mergeCount() > 0) {
          <p class="merge-status">{{ mergeCount() }} merge{{ mergeCount() === 1 ? '' : 's' }} applied so far.</p>
        } @else {
          <p class="merge-status muted">No merges applied yet.</p>
        }
        <!-- Why merging cannot run here, or what the last sweep found. Said in
             the panel the user pressed in rather than in a box over the book:
             the answer belongs next to the button that produced it. -->
        @if (notice(); as line) {
          <p class="merge-notice">{{ line }}</p>
        }
      </div>

      <div footer>
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="unavailable()"
          (click)="merge.emit()"
        >
          Merge adjacent blocks
        </desktop-button>
      </div>
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .merge-body {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
    }

    .merge-note {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 0;
    }

    .merge-status {
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      margin: 0;

      &.muted {
        color: var(--text-tertiary);
      }
    }

    .merge-notice {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 0;
      padding: var(--ui-spacing-sm);
      border-left: 2px solid var(--border-default);
    }
  `],
})
export class MergePanelComponent {
  readonly mergeCount = input.required<number>();

  /**
   * One line about merging in THIS document — why it cannot run, or what the
   * last sweep found. Replaces the two "nothing happened" boxes that used to
   * interrupt the book instead.
   */
  readonly notice = input<string | null>(null);

  /** True when this document cannot be merged at all, so the button is off. */
  readonly unavailable = input<boolean>(false);

  readonly close = output<void>();
  readonly merge = output<void>();
}

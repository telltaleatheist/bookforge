import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { TabsService } from '../../core/tabs.service';

/**
 * The one line that says what went wrong out here, rather than inside a tab.
 *
 * A drop this app will not open, a save that failed, a split that cannot
 * happen. Dismissed by hand and never on a timer — a refusal that vanished by
 * itself is a refusal the user gets to wonder about afterwards.
 *
 * IT LIVES AT THE TOP OF THE WORKSPACE, above the columns, because none of the
 * things it says are about a column. It used to hang under the first pane's tab
 * strip, which meant an app with no documents open — exactly the state a person
 * is in when they drop the wrong file on it — had nowhere to put the sentence
 * and said nothing at all.
 */
@Component({
  selector: 'app-notice-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tabs.notice(); as message) {
      <div class="notice" role="status">
        <span>{{ message }}</span>
        <button class="x" (click)="tabs.notice.set(null)" title="Dismiss">✕</button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    .notice {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px;
      background: var(--warn-soft);
      border-bottom: 1px solid var(--border-subtle);
      color: var(--warn);
      font-size: 12px;
    }
    .notice span { flex: 1; min-width: 0; }

    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 2px 3px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class NoticeBarComponent {
  protected readonly tabs = inject(TabsService);
}

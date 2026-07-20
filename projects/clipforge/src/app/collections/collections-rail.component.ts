import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ClipforgeCollectionSummary } from '../models/types';

/**
 * Left rail: the collection list + "New collection" action. Pure presentation —
 * all IO lives in the root App component / API service.
 */
@Component({
  selector: 'cf-collections-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rail-head">
      <span class="brand">ClipForge</span>
      <button type="button" class="new" (click)="create.emit()" [disabled]="!rootSet()">+ New</button>
    </div>

    @if (!rootSet()) {
      <div class="rootless">
        <p>No collections folder chosen yet.</p>
        <button type="button" class="choose" (click)="chooseRoot.emit()">Choose folder…</button>
      </div>
    } @else {
      <div class="root-line" [title]="root()">{{ root() }}</div>
      <button type="button" class="root-change" (click)="chooseRoot.emit()">Change folder</button>

      @if (collections().length === 0) {
        <p class="empty">No collections. Create one to begin.</p>
      } @else {
        <ul class="list">
          @for (c of collections(); track c.name) {
            <li
              class="item"
              [class.active]="c.name === selected()"
              (click)="openCollection.emit(c.name)"
            >
              <span class="name" [title]="c.name">{{ c.name }}</span>
              <span class="counts">
                @if (c.sourceCount < 0) {
                  <span class="bad">manifest error</span>
                } @else {
                  {{ c.sourceCount }} src · {{ c.probeCount }} probe
                }
              </span>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column;
      width: 280px; min-width: 280px; height: 100%;
      background: var(--bg-sidebar); border-right: 1px solid var(--border-default);
      overflow-y: auto;
    }
    .rail-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--ui-spacing-lg, 16px); border-bottom: 1px solid var(--border-subtle);
    }
    .brand { font-weight: 700; color: var(--text-primary); letter-spacing: 0.02em; }
    .new, .choose, .root-change {
      border: 1px solid var(--border-strong); background: var(--bg-elevated);
      color: var(--text-primary); border-radius: 6px; cursor: pointer;
    }
    .new { padding: 4px 10px; font-size: var(--ui-font-sm, 13px); }
    .new:disabled { opacity: 0.5; cursor: default; }
    .rootless { padding: var(--ui-spacing-lg, 16px); color: var(--text-secondary); font-size: var(--ui-font-sm, 13px); }
    .choose { margin-top: 8px; padding: 8px 12px; background: var(--accent); color: var(--text-inverse); border-color: var(--border-strong); }
    .root-line {
      padding: 8px var(--ui-spacing-lg, 16px) 0; color: var(--text-tertiary);
      font-size: var(--ui-font-xs, 11px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .root-change {
      margin: 4px var(--ui-spacing-lg, 16px) 8px; padding: 3px 8px; font-size: var(--ui-font-xs, 11px);
      align-self: flex-start;
    }
    .empty { padding: var(--ui-spacing-lg, 16px); color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .list { list-style: none; margin: 0; padding: 4px 8px; }
    .item {
      padding: 10px 12px; border-radius: 8px; cursor: pointer;
      display: flex; flex-direction: column; gap: 2px;
    }
    .item:hover { background: var(--hover-bg); }
    .item.active { background: var(--accent-subtle); }
    .name { color: var(--text-primary); font-size: var(--ui-font-base, 15px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .counts { color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px); }
    .bad { color: var(--error-text); }
  `],
})
export class CollectionsRailComponent {
  readonly collections = input.required<ClipforgeCollectionSummary[]>();
  readonly selected = input<string | null>(null);
  readonly root = input<string | null>(null);
  readonly rootSet = input.required<boolean>();

  readonly openCollection = output<string>();
  readonly create = output<void>();
  readonly chooseRoot = output<void>();
}

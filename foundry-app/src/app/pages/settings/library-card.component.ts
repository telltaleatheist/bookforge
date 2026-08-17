import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { api } from '../../core/foundry';

/**
 * Library location — the folder this app treats as the user's shelf.
 *
 * `<libraryDir>/workspace` is where every conversion lands, and it is where the
 * Save pickers open. It is a card of its own rather than a field in the
 * settings.json form because it is NOT in settings.json: that file's schema
 * belongs to the engine, and where this app keeps books is nobody's business but
 * this app's (electron/app-settings.ts).
 *
 * Changing it moves NOTHING. Books already written stay where they are and
 * recents keep their absolute paths — the hint says so, because a settings field
 * that silently relocated a hundred files would be the worst kind of surprise.
 */
@Component({
  selector: 'app-library-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card form">
      <div class="card-head"><span class="card-title">Library location</span></div>

      <p class="mono small">{{ dir() || 'reading…' }}</p>
      <p class="hint">
        Conversions are written to <code>workspace</code> inside this folder, and Save opens here.
        Changing it affects new work only — books already written stay where they are, and Home's
        list keeps pointing at them.
      </p>

      <div class="actions">
        <button class="ghost" [disabled]="busy()" (click)="browse()">
          {{ busy() ? 'Working…' : 'Choose folder…' }}
        </button>
        @if (changed()) { <span class="ok-note">Saved</span> }
      </div>

      @if (problem(); as reason) { <p class="warn">{{ reason }}</p> }
    </div>
  `,
  styles: [`
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }

    .mono { font-family: var(--font-mono); word-break: break-all; margin: 0; }
    .small { font-size: 11px; color: var(--text-tertiary); }
    .hint { margin: 0; font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }
    .hint code { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }

    .actions { display: flex; align-items: center; gap: 10px; }
    .ok-note { font-size: 12px; color: var(--ok); }
    .warn { margin: 0; font-size: 12px; color: var(--warn); }

    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class LibraryCardComponent {
  protected readonly dir = signal('');
  protected readonly busy = signal(false);
  protected readonly changed = signal(false);
  protected readonly problem = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    this.dir.set(await api.library.dir());
  }

  /**
   * Pick, then commit — two calls, because a dialog the user dismissed must not
   * write anything, and main is the only thing allowed to decide what a legal
   * library path is (it refuses a relative one).
   */
  protected async browse(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    this.problem.set(null);
    this.changed.set(false);
    try {
      const chosen = await api.library.choose(this.dir());
      if (chosen === null) return;
      this.dir.set(await api.library.set(chosen));
      this.changed.set(true);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * llm-card — the model every language job starts from, and the way back into setup.
 *
 * ── WHY THIS IS A SETTING NOW AND WAS NOT BEFORE ────────────────────────────
 *
 * The translate, simplify and analyse dialogs have always shown a model field
 * seeded from one hardcoded constant, `qwen3.8:27b` — Owen's ruling that 27b is
 * the standard for every task. That is the right standard and the wrong
 * DEFAULT for a machine that cannot hold it: seventeen gigabytes of weights on
 * an eight-gigabyte card is a translation that fails or crawls, and the person
 * it fails for has no way of knowing that the number in that field is the
 * reason. So setup measures the machine and writes what fits here, and the
 * three dialogs open with it.
 *
 * IT IS STILL ONLY A SEED. Each dialog's field remains editable and still sends
 * whatever is in it, so a different model for one book stays a per-run choice
 * and does not quietly become a new default.
 *
 * ── AND THE BUTTON THAT RE-OPENS SETUP ──────────────────────────────────────
 *
 * Every step of the first-run wizard is skippable, which is only a real offer
 * if there is a way back. This card holds it, and names what was skipped —
 * "the analysis worker was skipped" is something a person can act on, and
 * "setup was not completed" is not.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { SetupState } from '@shared/types';
import { api } from '../../core/foundry';
import { UiService } from '../../core/ui.service';

@Component({
  selector: 'app-llm-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Language model</span>
        @if (saved()) { <span class="badge">saved</span> }
      </div>
      <p class="detail">
        What Translate, Simplify and Analyse open with. Each of those still has its own field, so
        a different model for one book stays a choice about that book.
      </p>

      <label class="field">
        <span class="label">Default model</span>
        <input type="text" placeholder="qwen3.5:4b" name="model"
               [ngModel]="model()" (ngModelChange)="model.set($event)">
      </label>
      <p class="small mono">Ollama: {{ ollama() }}</p>

      <div class="actions">
        <button class="primary" [disabled]="saving()" (click)="save()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
        <button class="ghost" (click)="openSetup()">Run first-run setup again</button>
      </div>

      @if (state(); as setup) {
        @if (!setup.completed) {
          <p class="warn">Setup has not been run on this machine yet.</p>
        } @else if (setup.skipped.length > 0) {
          <p class="warn">Skipped during setup: {{ setup.skipped.join(', ') }}.</p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 8px;
    }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
  `],
})
export class LlmCardComponent {
  private readonly ui = inject(UiService);

  protected readonly model = signal('');
  protected readonly ollama = signal('');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly state = signal<SetupState | null>(null);

  constructor() {
    if (!api) return;
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    const [defaults, state] = await Promise.all([api.llm.defaults(), api.setup.state()]);
    this.model.set(defaults.model);
    this.ollama.set(defaults.ollama);
    this.state.set(state);
  }

  /**
   * Answered with what main STORED, never with what was typed. `clampModelTag`
   * refuses a name with whitespace in it and falls back to the standing
   * default, and a field that went on showing the refused text would be a
   * field disagreeing with the next job.
   */
  protected async save(): Promise<void> {
    if (!api) return;
    this.saving.set(true);
    this.saved.set(false);
    try {
      this.model.set(await api.llm.setModel(this.model()));
      this.saved.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  protected openSetup(): void {
    this.ui.openSetup();
  }
}

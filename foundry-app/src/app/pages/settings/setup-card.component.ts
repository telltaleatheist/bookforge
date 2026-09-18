/**
 * setup-card — the way back into first-run setup, and what was skipped.
 *
 * ── IT WAS THE LANGUAGE MODEL CARD, AND THE MODEL WENT ──────────────────────
 *
 * It held three fields: the default model Translate, Simplify and Analyse
 * opened with, the Clean text model, and the line saying where Ollama is. Owen
 * deleted all three on 2026-09-15: *"we dont have any local models. crucible
 * handles all model orchestration. if theres no connected crucible server then
 * tiles should be disabled."* The model a job runs is named by the ENGINE's own
 * capability record at the spawn, so a tag typed here was a choice that was then
 * ignored — and a settings field that cannot affect a run is worse than no field
 * at all, because somebody types in it and believes it.
 *
 * WHERE THAT DECISION LIVES NOW is two cards down: "Where the text work runs"
 * writes the ENGINE's settings through its own door, route and upstream per
 * class. That is a window onto somebody else's store, which is exactly what
 * Foundry is allowed to have; what it may not have is a store of its own.
 *
 * ── AND THE BUTTON LEFT IT, 2026-09-17, WHEN SETTINGS BECAME A TREE ────────
 *
 * Every step of the first-run wizard is skippable, which is only a real offer if
 * there is a way back — and this card used to hold that way back AND the notice
 * saying what was skipped. The way back is now "Run guided setup…" under the
 * section list (settings-page.component.ts argues why an action does not belong
 * among the things you set), so what remains here is the FACT: "the analysis
 * worker was skipped" is something a person can act on, and "setup was not
 * completed" is not.
 *
 * TWO BUTTONS FOR ONE ACTION IS WHAT WENT. It is the duplication the whole
 * reorganisation exists to remove, and it is worse than harmless here: the two
 * would have had to keep the same hosted guard in step forever.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { SetupState } from '@shared/types';
import { api } from '../../core/foundry';

@Component({
  selector: 'app-setup-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">First-run setup</span>
      </div>
      <p class="detail">
        The walk-through that asks for a library folder, a GPU engine, the Python environments
        and the page reader. Every step can be skipped, and every step is also a card in one of
        these sections. Run guided setup, under the section list, opens it again.
      </p>

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
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }

  `],
})
export class SetupCardComponent {
  protected readonly state = signal<SetupState | null>(null);

  constructor() {
    if (!api) return;
    void api.setup.state().then((state) => this.state.set(state));
  }
}

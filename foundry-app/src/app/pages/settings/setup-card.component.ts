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
 * ── AND THE BUTTON THAT RE-OPENS SETUP, WHICH IS WHY THE CARD SURVIVED ──────
 *
 * Every step of the first-run wizard is skippable, which is only a real offer if
 * there is a way back. This card holds it, and names what was skipped — "the
 * analysis worker was skipped" is something a person can act on, and "setup was
 * not completed" is not.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { SetupState } from '@shared/types';
import { api, hosted } from '../../core/foundry';
import { UiService } from '../../core/ui.service';

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
        and the page reader. Every step can be skipped, and every step is also a card on this
        screen.
      </p>

      <div class="actions">
        <!--
          NOT HOSTED. The wizard's first step is the library, which a hosted
          window does not own, and its later steps reconfigure an engine the
          host runs. UiService.openSetup refuses there as well; this hides the
          button so nobody is offered something that will not happen. (No
          backticks in this comment: it lives inside a template literal.)
        -->
        @if (!hosted()) {
          <button class="ghost" (click)="openSetup()">Run first-run setup again</button>
        }
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
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
      background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
  `],
})
export class SetupCardComponent {
  private readonly ui = inject(UiService);

  /** Read in the template: the wizard is not offered inside a host. */
  protected readonly hosted = hosted;
  protected readonly state = signal<SetupState | null>(null);

  constructor() {
    if (!api) return;
    void api.setup.state().then((state) => this.state.set(state));
  }

  protected openSetup(): void {
    this.ui.openSetup();
  }
}

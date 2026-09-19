/**
 * THE OUTCOME READOUT — what happened to the Linux engine on this machine.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.2 and §2.5. It replaces the
 * button that used to say "Set up WSL acceleration", and the difference
 * between the two is the whole of the phase: that button asked a person to
 * want something they have no way to evaluate, and Owen ruled it out on
 * 2026-09-18 — *"we should assume they have no idea how to do it and it should
 * do it automatically."* The move is the tray's, decided at every start (§2.3).
 * This says what came of it.
 *
 * ── FOUR STATES AND WHAT EACH DRAWS ────────────────────────────────────────
 *
 *   no outcome yet → NOTHING. §2.2's file is the one owner of this fact, and a
 *                    screen that filled its silence with "not set up" would be
 *                    inventing the answer rather than reporting it.
 *   done           → NOTHING. §2.5: *"On a `done` machine there is no control
 *                    at all."* The engine is serving through the guest and the
 *                    Servers card already says which backend answered.
 *   reboot-pending → the sentence, and **Restart now** (§2.3).
 *   cannot/failed  → the outcome's OWN sentence, and **Try again** (§2.5).
 *   declined       → NOTHING. `wsl = "never"` is a machine somebody kept
 *                    native on purpose, and offering to retry a decision is
 *                    arguing with its owner.
 *
 * ── WHY IT IS A COMPONENT AND NOT COPIED INTO TWO SCREENS ──────────────────
 *
 * Two screens show it: the first-run wizard's engine card and Settings →
 * Servers. They are the same fact about the same machine, and two copies is
 * how one of them ends up saying something the other does not. The condition
 * that they differ on is the CALLER's — the wizard draws it only for a
 * `llama-windows` engine, because that is the only backend an outcome about a
 * move applies to.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { CrucibleInstallOutcome } from '@shared/crucible-install-wire';
import { api } from '../../core/foundry';

@Component({
  selector: 'app-crucible-install-outcome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (outcome(); as it) {
      @if (it.state === 'reboot-pending') {
        <p class="line">
          Windows needs a restart to finish setting up the Linux engine. Everything else works
          in the meantime.
        </p>
        <div class="actions">
          <button class="primary" type="button" [disabled]="busy()" (click)="restart()">
            Restart now
          </button>
        </div>
      } @else if (it.state === 'cannot' || it.state === 'failed') {
        <p class="line">{{ said(it) }}</p>
        <div class="actions">
          <button class="primary" type="button" [disabled]="busy()" (click)="again()">
            {{ busy() ? 'Trying…' : 'Try again' }}
          </button>
        </div>
      }
    }
    @if (refusal(); as why) { <p class="warn">{{ why }}</p> }
  `,
  styles: [`
    :host { display: block; }
    .line { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; }
    .warn { color: var(--warn); margin: 6px 0 0; font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px; border: none; border-radius: var(--radius-sm);
      background: var(--accent); color: var(--text-inverse);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
    }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class CrucibleInstallOutcomeComponent {
  protected readonly outcome = signal<CrucibleInstallOutcome | null>(null);
  protected readonly busy = signal(false);
  protected readonly refusal = signal<string | null>(null);

  constructor() {
    void this.read();
  }

  /**
   * §2.6's `GET /install`, and the refusal it can answer with.
   *
   * A host that is installed and not running refuses `host_unreachable` by
   * name, and that sentence is drawn rather than dropped: this readout is the
   * only place on either screen that says anything about the tray, so a
   * silent catch here would be the app deciding a machine is fine because it
   * could not ask. The outcome stays null, which draws no control.
   */
  private async read(): Promise<void> {
    if (!api) return;
    try {
      this.outcome.set((await api.crucible.installStatus()).outcome);
    } catch (err) {
      this.outcome.set(null);
      this.refusal.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * THE SENTENCE IS THE OUTCOME'S (§2.2), and this only frames it.
   *
   * `cannot` is a machine that needs something changed — virtualisation in the
   * BIOS, most often — so it is prefixed with what it means; `failed` is a step
   * that died and its message already reads as one.
   */
  protected said(outcome: CrucibleInstallOutcome): string {
    const sentence = outcome.sentence ?? 'Crucible did not say why.';
    return outcome.state === 'cannot'
      ? `This computer can't run the Linux engine: ${sentence}`
      : sentence;
  }

  protected async again(): Promise<void> {
    if (!api || this.busy()) return;
    this.busy.set(true);
    this.refusal.set(null);
    try {
      await api.crucible.installRetry();
      await this.read();
    } catch (err) {
      this.refusal.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async restart(): Promise<void> {
    if (!api || this.busy()) return;
    this.refusal.set(null);
    try {
      await api.crucible.restartWindows();
    } catch (err) {
      this.refusal.set(err instanceof Error ? err.message : String(err));
    }
  }
}

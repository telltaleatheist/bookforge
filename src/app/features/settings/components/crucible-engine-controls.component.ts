import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type { CrucibleConnectionApproval } from '@shared/crucible/engine-controls-wire';
import type { CrucibleInstallOutcome } from '@shared/crucible/install-door-wire';

/**
 * WHAT A ROW CAN DO TO ONE ENGINE — and, since PHASE19, what it can only READ.
 *
 * ── "ENABLE WSL ACCELERATION" IS GONE (crucible PHASE19 §4) ────────────────
 *
 * It was a button on any `llama-windows` engine: *"For faster model
 * processing, optionally add WSL acceleration."* Owen ruled the choice away on
 * 2026-09-18 — *"we should assume they have no idea how to do it and it should
 * do it automatically"* — so on every Windows machine that CAN host WSL2 the
 * orchestrator makes the move by itself, at login, as part of the same
 * install. There is nothing to opt into, and a button offering it would be
 * offering a thing that has already happened.
 *
 * What is left in its place is the OUTCOME, read from the install door
 * (§2.2). Three faces and a silence:
 *
 *   `done`           → nothing at all. The engine is the Linux one; that is
 *                      the whole news, and it is on the row's own facts line.
 *   `reboot-pending` → **Restart now**, which runs `shutdown.exe /r /t 5` as
 *                      the interactive user and only because it was pressed.
 *   `cannot`/`failed`→ the state table's sentence, verbatim, plus **Try
 *                      again**, because the person may have gone and changed
 *                      the thing the sentence named.
 *
 * NO SENTENCE HERE IS COMPOSED. The verdict about somebody's machine has one
 * owner — the state table that probed it — and a second wording of it in a
 * settings row is how a fixable problem becomes an unfixable one.
 */
@Component({
  selector: 'app-crucible-engine-controls', standalone: true,
  imports: [DesktopButtonComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <desktop-button variant="ghost" size="sm" (click)="toggleRequests()">
      {{ showRequests() ? 'Hide connection requests' : 'Connection requests' }}
    </desktop-button>
    @if (showRequests()) {
      <p>Approve only a request you recognize, with the same code shown on the connecting computer.</p>
      <desktop-button variant="ghost" size="sm" [disabled]="requestBusy()" (click)="readRequests()">Refresh requests</desktop-button>
      @for (request of requests(); track request.id) {
        <p><strong>{{ request.clientName }}</strong> from {{ request.address }} — code <strong>{{ request.userCode }}</strong></p>
        <desktop-button variant="primary" size="sm" [disabled]="requestBusy()" (click)="decide(request, true)">Approve matching code</desktop-button>
        <desktop-button variant="ghost" size="sm" [disabled]="requestBusy()" (click)="decide(request, false)">Decline</desktop-button>
      } @empty { <p>No pending connection requests.</p> }
      @if (requestError(); as message) { <p class="error">{{ message }}</p> }
    }
    <!--
      THE OUTCOME READOUT, AND ONLY ON THE ENGINE IT IS ABOUT. "llama-windows"
      is the one backend a WSL outcome can apply to: a Mac's mlx-darwin engine
      and an engine that is already cuda-linux have no move pending, and a row
      that drew this on them would be reporting another machine's news.
    -->
    @if (nativeWindows()) {
      @if (outcome(); as result) {
        @if (result.state === 'reboot-pending') {
          <p>Restart Windows to finish setting up the Linux engine.</p>
          <desktop-button variant="primary" size="sm" [disabled]="busy()" (click)="restartNow()">
            {{ busy() ? 'Restarting…' : 'Restart now' }}
          </desktop-button>
        } @else if (result.state === 'cannot') {
          <p>This computer can't run the Linux engine: {{ result.sentence }}</p>
          <desktop-button variant="ghost" size="sm" [disabled]="busy()" (click)="tryAgain()">
            {{ busy() ? 'Trying…' : 'Try again' }}
          </desktop-button>
        } @else if (result.state === 'failed') {
          <p class="error">Setting up the Linux engine stopped: {{ result.sentence }}</p>
          <desktop-button variant="ghost" size="sm" [disabled]="busy()" (click)="tryAgain()">
            {{ busy() ? 'Trying…' : 'Try again' }}
          </desktop-button>
        }
      }
    }
    @if (error(); as message) { <p class="error">{{ message }}</p> }
  `,
  styles: [`:host { display:block; font-size:12px; } p { margin:8px 0; } .error { color:var(--error, #d05a5a); }`],
})
export class CrucibleEngineControlsComponent {
  readonly server = input.required<string>();
  readonly enabled = input(true);
  private readonly electron = inject(ElectronService);
  /** Is this row's engine the native Windows one? The only row an outcome is about. */
  readonly nativeWindows = signal(false);
  /**
   * WHAT HAPPENED TO THE MOVE ON THIS MACHINE — the install door's fact, not
   * this component's. Null until it has been read, and null for ever on a
   * machine where no move has ever run.
   */
  readonly outcome = signal<CrucibleInstallOutcome | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly showRequests = signal(false);
  readonly requests = signal<CrucibleConnectionApproval[]>([]);
  readonly requestBusy = signal(false);
  readonly requestError = signal<string | null>(null);
  constructor() {
    effect(() => {
      if (this.enabled()) void this.inspect(this.server());
      else this.nativeWindows.set(false);
    });
    void this.readOutcome();
    /*
     * WATCHED, NOT POLLED. The move may finish while this panel is open — it
     * is the tray's, and it started without anybody here — so the row hears
     * the terminal event rather than showing yesterday's verdict until
     * somebody presses Re-check.
     */
    const stopEvents = this.electron.crucible.onInstallEvent((event) => {
      if (event.event === 'done' || event.event === 'error') this.outcome.set(event.outcome);
    });
    inject(DestroyRef).onDestroy(stopEvents);
  }
  private async inspect(server: string): Promise<void> {
    const response = await this.electron.crucible.test(server);
    if (server !== this.server() || !this.enabled()) return;
    this.nativeWindows.set(response.success && response.data?.outcome === 'ok'
      && response.data.facts.backend === 'llama-windows');
  }
  private async readOutcome(): Promise<void> {
    const res = await this.electron.crucible.installStatus();
    if (!res.success || !res.data) {
      // "Nothing has happened" and "the door would not answer" are different
      // facts; only the second one has a fix, and it is said rather than hidden.
      this.error.set(res.error ?? 'How this computer’s setup is going could not be read, and '
        + 'nothing said why.');
      return;
    }
    this.outcome.set(res.data.outcome);
  }
  toggleRequests(): void {
    this.showRequests.update(value => !value);
    if (this.showRequests()) void this.readRequests();
  }
  async readRequests(): Promise<void> {
    if (this.requestBusy()) return;
    this.requestBusy.set(true); this.requestError.set(null);
    const server = this.server();
    try {
      const result = await this.electron.crucible.pairRequests(server);
      if (server !== this.server()) return;
      if (!result.success || !result.data) throw new Error(result.error ?? 'The connection requests could not be read.');
      this.requests.set(result.data);
    } catch (error) { this.requestError.set((error as Error).message); }
    finally { this.requestBusy.set(false); }
  }
  async decide(request: CrucibleConnectionApproval, allow: boolean): Promise<void> {
    if (this.requestBusy()) return;
    this.requestBusy.set(true); this.requestError.set(null);
    try {
      const result = await this.electron.crucible.pairDecide(this.server(), request.id, request.userCode, allow);
      if (!result.success) throw new Error(result.error ?? 'Crucible did not accept the decision.');
      this.requests.update(rows => rows.filter(row => row.id !== request.id));
    } catch (error) { this.requestError.set((error as Error).message); }
    finally { this.requestBusy.set(false); }
  }
  /** `shutdown.exe /r /t 5`, because somebody pressed **Restart now** (§2.3). */
  async restartNow(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const result = await this.electron.crucible.restartWindows();
      if (!result.success) this.error.set(result.error ?? 'Restarting refused and said nothing about why.');
    } finally { this.busy.set(false); }
  }
  /** `POST /install` — the apps' one WSL control (§2.5). */
  async tryAgain(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const result = await this.electron.crucible.installRetry();
      if (!result.success) {
        this.error.set(result.error ?? 'Trying again refused and said nothing about why.');
        return;
      }
      this.outcome.set(null);
    } finally { this.busy.set(false); }
  }
}

import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type { CrucibleConnectionApproval, CrucibleEngineUpgradeProgress } from '@shared/crucible/engine-controls-wire';

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
    @if (nativeWindows()) {
      <p>For faster model processing, optionally add WSL acceleration. Crucible manages its own
        WSL environment. Windows may ask for permission or a restart.</p>
      <desktop-button variant="ghost" size="sm" [disabled]="upgrading()" (click)="upgrade()">
        {{ upgrading() ? 'Preparing WSL acceleration…' : 'Enable WSL acceleration' }}
      </desktop-button>
    }
    @if (progress(); as state) { <p [class.error]="state.state === 'failed'">{{ state.message }}</p> }
    @if (error(); as message) { <p class="error">{{ message }}</p> }
  `,
  styles: [`:host { display:block; font-size:12px; } p { margin:8px 0; } .error { color:var(--error, #d05a5a); }`],
})
export class CrucibleEngineControlsComponent {
  readonly server = input.required<string>();
  readonly enabled = input(true);
  private readonly electron = inject(ElectronService);
  readonly nativeWindows = signal(false);
  readonly upgrading = signal(false);
  readonly progress = signal<CrucibleEngineUpgradeProgress | null>(null);
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
    const stop = this.electron.crucible.onUpgradeProgress(progress => {
      if (progress.server !== this.server()) return;
      this.progress.set(progress);
      this.upgrading.set(progress.state === 'running');
      if (progress.state === 'done') this.nativeWindows.set(false);
    });
    inject(DestroyRef).onDestroy(stop);
  }
  private async inspect(server: string): Promise<void> {
    const response = await this.electron.crucible.test(server);
    if (server !== this.server() || !this.enabled()) return;
    this.nativeWindows.set(response.success && response.data?.outcome === 'ok'
      && response.data.facts.backend === 'llama-windows');
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
  async upgrade(): Promise<void> {
    if (this.upgrading()) return;
    this.upgrading.set(true); this.error.set(null);
    try {
      const result = await this.electron.crucible.upgradeWsl(this.server());
      if (!result.success) this.error.set(result.error ?? 'The WSL upgrade did not finish.');
      else this.nativeWindows.set(false);
    } catch (error) { this.error.set((error as Error).message); }
    finally { this.upgrading.set(false); }
  }
}

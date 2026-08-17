import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { EnvCatalogItem, EnvInstallProgress, EnvTarget, Job, WslFacts } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { api } from '../../core/foundry';

/**
 * Environments — the prebuilt Pythons, and the manual way to get one.
 *
 * The app installs what this machine is missing BY ITSELF at startup, as rows in
 * the queue shelf. This card is deliberately the secondary path: it exists for
 * the three things automation is not allowed to decide for you — a different
 * location, which WSL distro, and "install it again anyway".
 *
 * ── Two feeds, and why ───────────────────────────────────────────────────────
 *
 * The bar comes from `env:install-progress`, which is the installer talking
 * directly and arrives at whatever rate the download does. Whether an install is
 * RUNNING, and how it ended, comes from the queue — main owns that, the shelf
 * shows the same rows, and a card that decided for itself that an install had
 * finished would be a second opinion about a process this window does not own.
 * So: the event animates, the queue adjudicates.
 *
 * Nothing here is remembered. `installed` is measured on every load, because a
 * user who deleted the directory by hand should see this say so.
 */
@Component({
  selector: 'app-env-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Environments</span>
        <button class="ghost tiny" [disabled]="loading()" (click)="load()">
          {{ loading() ? 'Checking…' : 'Re-check' }}
        </button>
      </div>
      <p class="detail">
        The Pythons the conversions were measured with, downloaded from the release rather than
        resolved by pip on this machine. Anything missing is fetched automatically at startup —
        it appears in the shelf, bottom right.
      </p>

      @if (items().length === 0 && !loading()) {
        <p class="detail">There is no prebuilt environment for this platform.</p>
      }

      @for (item of items(); track item.target) {
        <div class="env" [attr.data-ok]="item.installedPath !== null">
          <div class="env-head">
            <span class="dot" [attr.data-ok]="item.installedPath !== null"></span>
            <span class="env-title">{{ item.label }}</span>
            @if (!item.published) {
              <span class="badge warn-badge">not yet published</span>
            } @else if (item.configured) {
              <span class="badge">in use</span>
            }
          </div>

          <p class="detail">{{ item.purpose }}</p>
          <p class="small mono">
            python {{ item.pythonVersion }} · {{ item.packages.join(', ') }}
            @if (item.bytes) { · {{ size(item.bytes) }} download }
            @if (item.partCount > 1) { in {{ item.partCount }} parts }
          </p>
          <p class="detail">{{ item.detail }}</p>

          @if (!item.published) {
            <p class="warn">
              The release has no sha256 for this archive yet, so there is nothing to verify a
              download against. Install stays disabled rather than fetching it unchecked.
            </p>
          }

          <!-- ── Where it goes ──────────────────────────────────────────── -->
          @if (item.inWsl) {
            <label class="field">
              <span class="label">Distro</span>
              @if (wsl()?.available) {
                <select [ngModel]="distro()" (ngModelChange)="distro.set($event)"
                        [disabled]="busy()" [name]="'distro-' + item.target">
                  @for (name of wsl()?.distros ?? []; track name) {
                    <option [value]="name">{{ name }}</option>
                  }
                </select>
              } @else {
                <span class="detail">{{ wsl()?.reason ?? 'Looking for WSL…' }}</span>
              }
            </label>
            <p class="small mono">{{ item.defaultDest }} — inside the distro, not on the Windows drive.</p>
          } @else {
            <label class="field">
              <span class="label">Destination</span>
              <div class="dest">
                <input type="text" class="mono" [ngModel]="destOf(item)"
                       (ngModelChange)="setDest(item.target, $event)"
                       [disabled]="busy()" [name]="'dest-' + item.target">
                <button class="ghost tiny" [disabled]="busy()" (click)="pickDest(item)">Browse…</button>
              </div>
            </label>
          }

          <!-- ── Doing it ───────────────────────────────────────────────── -->
          @if (jobFor(item.target); as job) {
            @if (job.state === 'running' || job.state === 'queued') {
              <div class="bar" [class.indeterminate]="!counting(item.target)">
                <div class="fill" [style.width.%]="percent(item.target)"></div>
              </div>
              <div class="actions">
                <span class="phase">{{ phaseWord(item.target, job) }}</span>
                <span class="spacer"></span>
                <button class="ghost tiny" (click)="cancel()">Cancel</button>
              </div>
              <p class="small">{{ job.message }}</p>
            } @else if (job.state === 'failed') {
              <p class="warn">{{ job.error }}</p>
              <div class="actions">
                <button class="primary" [disabled]="!item.published || busy()" (click)="install(item)">
                  Try again
                </button>
              </div>
            } @else {
              @if (job.state === 'done') { <p class="ok-note">{{ job.message }}</p> }
              <div class="actions">
                <button class="primary" [disabled]="!item.published || busy()" (click)="install(item)">
                  {{ item.installedPath ? 'Reinstall' : 'Install' }}
                </button>
              </div>
            }
          } @else {
            <div class="actions">
              <button class="primary" [disabled]="!item.published || busy()" (click)="install(item)">
                {{ item.installedPath ? 'Reinstall' : 'Install' }}
              </button>
              @if (item.installedPath && !item.configured) {
                <span class="muted">Installed, but settings point somewhere else.</span>
              }
            </div>
          }
        </div>
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
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }

    .env {
      margin-top: 12px; padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
      display: flex; flex-direction: column; gap: 6px;
    }
    .env-head { display: flex; align-items: center; gap: 8px; }
    .env-title { font-weight: 600; font-size: 12px; flex: 1; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex-shrink: 0; }
    .dot[data-ok="true"] { background: var(--ok); }

    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px;
    }
    .badge.warn-badge { color: var(--warn); background: var(--warn-soft); }

    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .muted { color: var(--text-tertiary); font-size: 12px; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; white-space: pre-wrap; }
    .ok-note { color: var(--ok); font-size: 12px; margin: 0; }
    .phase { font-size: 11px; color: var(--text-secondary); }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .dest { display: flex; gap: 6px; align-items: center; }
    .dest input { flex: 1; min-width: 0; height: 26px; padding: 0 10px; font-size: 11px; border-radius: var(--radius-sm); }

    .bar { height: 4px; background: var(--bg-sunken); border-radius: 2px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
    /* No honest percentage for verify/unpack/configure — see env-install.ts. */
    .bar.indeterminate .fill { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(320%); }
    }

    .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .spacer { flex: 1; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost.tiny { height: 22px; padding: 0 8px; font-size: 11px; }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class EnvCardComponent {
  /** Fired when an install finished, so the page re-runs doctor. */
  readonly changed = output<void>();

  private readonly queue = inject(QueueService);

  protected readonly items = signal<EnvCatalogItem[]>([]);
  protected readonly loading = signal(false);
  protected readonly wsl = signal<WslFacts | null>(null);
  protected readonly distro = signal('');

  /** The picker's answer, per target, until the page is left. */
  private readonly dests = signal<Record<string, string>>({});
  /** The last progress event per target — the bar, and nothing else. */
  private readonly live = signal<Record<string, EnvInstallProgress>>({});

  /** Every env row main knows about, whoever started it. */
  private readonly envJobs = computed(() => this.queue.jobs().filter((job) => job.kind === 'env-install'));

  /** One install at a time, so every other button goes flat while one runs. */
  protected readonly busy = computed(() =>
    this.envJobs().some((job) => job.state === 'running' || job.state === 'queued'));

  constructor() {
    if (!api) return;
    api.env.onInstallProgress((progress) => {
      this.live.update((all) => ({ ...all, [progress.target]: progress }));
    });
    void this.load();
    void api.wsl.facts().then((facts) => {
      this.wsl.set(facts);
      if (this.distro().length === 0) this.distro.set(facts.distros[0] ?? '');
    });

    // An install that ENDED — ours or the startup provisioner's — changes what
    // the tier cards say. Re-measure rather than assert: this app does not get
    // to declare a rasteriser available on the strength of having downloaded one.
    let settled = 0;
    effect(() => {
      const finished = this.envJobs().filter((job) => job.state === 'done').length;
      if (finished > settled) {
        settled = finished;
        void this.load();
        this.changed.emit();
      }
    });
  }

  protected async load(): Promise<void> {
    if (!api) return;
    this.loading.set(true);
    try {
      this.items.set(await api.env.catalog());
    } finally {
      this.loading.set(false);
    }
  }

  /** The row for this target, newest first — an old failure must not shadow a retry. */
  protected jobFor(target: EnvTarget): Job | null {
    const mine = this.envJobs().filter((job) => job.inputPath === target);
    return mine[mine.length - 1] ?? null;
  }

  protected destOf(item: EnvCatalogItem): string {
    return this.dests()[item.target] ?? item.defaultDest;
  }

  protected setDest(target: EnvTarget, value: string): void {
    this.dests.update((all) => ({ ...all, [target]: value }));
  }

  protected async pickDest(item: EnvCatalogItem): Promise<void> {
    const chosen = await api?.env.chooseDest(this.destOf(item));
    if (chosen) this.setDest(item.target, chosen);
  }

  protected size(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  /** True only while bytes are moving — the one phase with a real fraction. */
  protected counting(target: EnvTarget): boolean {
    return this.live()[target]?.phase === 'download';
  }

  protected percent(target: EnvTarget): number {
    return this.live()[target]?.percent ?? 0;
  }

  protected phaseWord(target: EnvTarget, job: Job): string {
    const phase = this.live()[target]?.phase ?? job.envProgress?.phase;
    switch (phase) {
      case 'download': return `Downloading ${this.percent(target)}%`;
      case 'verify': return 'Verifying sha256';
      case 'unpack': return 'Unpacking';
      case 'configure': return 'Configuring';
      default: return job.state === 'queued' ? 'Waiting for the queue' : 'Starting…';
    }
  }

  protected async install(item: EnvCatalogItem): Promise<void> {
    if (!api || !item.published) return;
    this.live.update((all) => {
      const next = { ...all };
      delete next[item.target];
      return next;
    });
    await api.env.install({
      target: item.target,
      // A WSL target's destination is a path in the guest; the picker cannot
      // express one, so nothing is sent and the installer uses its default.
      dest: item.inWsl ? undefined : this.destOf(item),
      distro: item.inWsl ? (this.distro() || undefined) : undefined,
    });
  }

  protected async cancel(): Promise<void> {
    await api?.env.cancel();
  }
}

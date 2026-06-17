import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Mirrors electron/update/code-updater.ts CodeUpdateStatus (renderer-side copy). */
interface CodeUpdateStatus {
  state: 'idle' | 'checking' | 'downloading' | 'staged' | 'up-to-date' | 'incompatible' | 'error';
  currentVersion?: string | null;
  launcherVersion?: string;
  availableVersion?: string;
  progressPct?: number;
  pendingVersion?: string;
  requiresLauncher?: string;
  error?: string;
}

/** Mirrors electron/update/component-updater.ts ComponentUpdateStatus (renderer-side copy). */
interface ComponentUpdateStatus {
  id: string;
  state: 'not-installed' | 'up-to-date' | 'update-available' | 'incompatible' | 'unavailable';
  installedVersion: string | null;
  availableVersion: string;
  bytes: number;
  requiresApp?: string;
  progressPct?: number;
  error?: string;
}

/**
 * Floating toast that surfaces app self-updates. The launcher applies a staged update on the
 * NEXT launch (stage-now / boot-next), so the only user action is "Restart". Downloading is shown
 * subtly; "incompatible" tells the user to grab a new BookForge manually (rare, launcher bump).
 *
 * Backed by the update IPC bridged in preload (window.electron.update). Silently inert if the
 * bridge is absent (e.g. running in a browser without Electron).
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible()) {
      <div class="update-toast" role="status" aria-live="polite">
        @switch (status()?.state) {
          @case ('downloading') {
            <div class="update-row">
              <span class="update-spinner"></span>
              <span class="update-text">Downloading update {{ status()?.availableVersion }}…</span>
              <span class="update-pct">{{ status()?.progressPct ?? 0 }}%</span>
            </div>
            <div class="update-track">
              <div class="update-fill" [style.width.%]="status()?.progressPct ?? 0"></div>
            </div>
          }
          @case ('staged') {
            <div class="update-row">
              <span class="update-dot"></span>
              <span class="update-text">
                Update <strong>{{ status()?.pendingVersion }}</strong> is ready — restart to apply.
              </span>
            </div>
            <div class="update-actions">
              <button class="update-btn ghost" (click)="dismiss()">Later</button>
              <button class="update-btn primary" (click)="restart()">Restart now</button>
            </div>
          }
          @case ('incompatible') {
            <div class="update-row">
              <span class="update-dot warn"></span>
              <span class="update-text">
                A newer version needs the latest BookForge
                ({{ status()?.requiresLauncher }}). Please download it to update.
              </span>
            </div>
            <div class="update-actions">
              <button class="update-btn ghost" (click)="dismiss()">Dismiss</button>
            </div>
          }
        }

        @if (actionableComponents().length) {
          @if (showCodeUpdate()) { <div class="update-sep"></div> }
          <div class="update-row">
            <span class="update-dot"></span>
            <span class="update-text">Component updates available</span>
          </div>
          @for (c of actionableComponents(); track c.id) {
            <div class="update-comp">
              <span class="update-comp-name">{{ c.id }}</span>
              <span class="update-comp-ver">{{ c.availableVersion }}</span>
              @if (installing()[c.id] != null) {
                <span class="update-comp-pct">{{ installing()[c.id] }}%</span>
              } @else {
                <button class="update-btn primary small" (click)="installComponent(c.id)">
                  {{ c.installedVersion ? 'Update' : 'Install' }}
                </button>
              }
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
    .update-toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 9500;
      width: 340px;
      max-width: calc(100vw - 32px);
      padding: 14px 16px;
      border-radius: 10px;
      background: var(--bg-elevated, #1e1e1e);
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      color: var(--text-primary, #f0f0f0);
      -webkit-app-region: no-drag;
    }

    .update-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      line-height: 1.4;
    }

    .update-text { flex: 1; color: var(--text-secondary, #c8c8c8); }
    .update-text strong { color: var(--text-primary, #f0f0f0); }
    .update-pct {
      flex: none;
      font-variant-numeric: tabular-nums;
      color: var(--text-tertiary, #888);
    }

    .update-dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent, #29b6f6);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #29b6f6) 25%, transparent);
    }
    .update-dot.warn { background: var(--color-warning, #e0a800); box-shadow: 0 0 0 3px rgba(224, 168, 0, 0.25); }

    .update-track {
      margin-top: 10px;
      height: 4px;
      width: 100%;
      border-radius: 2px;
      background: var(--border-subtle, rgba(255, 255, 255, 0.12));
      overflow: hidden;
    }
    .update-fill {
      height: 100%;
      background: var(--accent, #29b6f6);
      transition: width 0.4s ease;
    }

    .update-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }

    .update-btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .update-btn.ghost {
      background: transparent;
      border-color: var(--border-subtle, rgba(255, 255, 255, 0.2));
      color: var(--text-secondary, #c8c8c8);
    }
    .update-btn.ghost:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.08)); }
    .update-btn.primary {
      background: var(--accent, #29b6f6);
      color: #0a0a0a;
    }
    .update-btn.primary:hover { filter: brightness(1.08); }

    .update-spinner {
      flex: none;
      width: 13px;
      height: 13px;
      border: 2px solid var(--border-subtle, rgba(255, 255, 255, 0.2));
      border-top-color: var(--accent, #29b6f6);
      border-radius: 50%;
      animation: update-spin 0.8s linear infinite;
    }
    @keyframes update-spin { to { transform: rotate(360deg); } }

    .update-sep {
      height: 1px;
      margin: 12px 0;
      background: var(--border-subtle, rgba(255, 255, 255, 0.12));
    }
    .update-comp {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
    }
    .update-comp-name { flex: 1; color: var(--text-primary, #f0f0f0); }
    .update-comp-ver { color: var(--text-tertiary, #888); font-variant-numeric: tabular-nums; }
    .update-comp-pct {
      color: var(--text-tertiary, #888);
      font-variant-numeric: tabular-nums;
    }
    .update-btn.small { padding: 4px 10px; }
  `]
})
export class UpdateBannerComponent implements OnInit, OnDestroy {
  readonly status = signal<CodeUpdateStatus | null>(null);
  readonly components = signal<ComponentUpdateStatus[]>([]);
  /** id -> download percent while a component install is in flight. */
  readonly installing = signal<Record<string, number>>({});
  private readonly dismissedVersion = signal<string | null>(null);
  private readonly unsubs: Array<() => void> = [];

  private get api(): any {
    return (window as any).electron?.update;
  }

  /** Code update is in an actionable state (and not dismissed). */
  readonly showCodeUpdate = computed(() => {
    const s = this.status();
    if (!s) return false;
    if (s.state === 'staged' || s.state === 'incompatible') {
      const v = s.pendingVersion ?? s.availableVersion ?? '';
      return this.dismissedVersion() !== v;
    }
    return s.state === 'downloading';
  });

  /** Managed binaries with a newer/changed compatible build (or not yet installed). */
  readonly actionableComponents = computed(() =>
    this.components().filter((c) => c.state === 'update-available' || c.state === 'not-installed')
  );

  readonly visible = computed(() => this.showCodeUpdate() || this.actionableComponents().length > 0);

  async ngOnInit(): Promise<void> {
    if (!this.api) return;
    try {
      this.status.set(await this.api.getCodeStatus());
    } catch {
      /* bridge present but call failed — stay inert */
    }
    if (this.api.onCodeStatus) this.unsubs.push(this.api.onCodeStatus((s: CodeUpdateStatus) => this.status.set(s)));

    try {
      this.components.set((await this.api.listComponents?.()) ?? []);
    } catch {
      /* stay inert */
    }
    if (this.api.onComponentsAvailable) {
      this.unsubs.push(this.api.onComponentsAvailable((list: ComponentUpdateStatus[]) => this.components.set(list)));
    }
    if (this.api.onComponentStatus) {
      this.unsubs.push(this.api.onComponentStatus((s: ComponentUpdateStatus) => this.onComponentProgress(s)));
    }
  }

  ngOnDestroy(): void {
    this.unsubs.forEach((u) => u());
  }

  restart(): void {
    this.api?.restart?.();
  }

  dismiss(): void {
    const s = this.status();
    this.dismissedVersion.set(s?.pendingVersion ?? s?.availableVersion ?? '');
  }

  async installComponent(id: string): Promise<void> {
    if (!this.api?.installComponent) return;
    this.installing.update((m) => ({ ...m, [id]: 0 }));
    try {
      await this.api.installComponent(id);
    } finally {
      this.installing.update((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
      // Refresh so the now-current component drops out of the actionable list.
      try {
        this.components.set((await this.api.listComponents?.(true)) ?? []);
      } catch {
        /* ignore */
      }
    }
  }

  private onComponentProgress(s: ComponentUpdateStatus): void {
    if (s.progressPct != null && this.installing()[s.id] != null) {
      this.installing.update((m) => ({ ...m, [s.id]: s.progressPct ?? 0 }));
    }
  }
}

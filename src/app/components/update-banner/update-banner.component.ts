import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

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

/** Mirrors electron/update/starter-library.ts StarterStatus (renderer-side copy). */
interface StarterStatus {
  available: boolean;
  alreadyPresent: boolean;
  slug?: string;
  bytes?: number;
  installing?: boolean;
  phase?: 'download' | 'verify' | 'extract';
  progressPct?: number;
  error?: string;
}

/**
 * Floating toast that surfaces available updates for our managed binaries (ffmpeg, yt-dlp, …)
 * and the one-time first-run starter-library download (the finished sample project).
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
        @if (actionableComponents().length) {
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

        @if (showStarter()) {
          @if (actionableComponents().length) { <div class="update-sep"></div> }
          <div class="update-row">
            <span class="update-spinner"></span>
            <span class="update-text">{{ starterLabel() }}</span>
            <span class="update-pct">{{ starter()?.progressPct ?? 0 }}%</span>
          </div>
          <div class="update-track">
            <div class="update-fill" [style.width.%]="starter()?.progressPct ?? 0"></div>
          </div>
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

    .update-btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
    }
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
  readonly components = signal<ComponentUpdateStatus[]>([]);
  readonly starter = signal<StarterStatus | null>(null);
  /** id -> download percent while a component install is in flight. */
  readonly installing = signal<Record<string, number>>({});
  private readonly unsubs: Array<() => void> = [];

  private get api(): any {
    return (window as any).electron?.update;
  }

  /** Managed binaries with a newer/changed compatible build (or not yet installed). */
  readonly actionableComponents = computed(() =>
    this.components().filter((c) => c.state === 'update-available' || c.state === 'not-installed')
  );

  /** The starter library is actively downloading/extracting (not yet finished, no error). */
  readonly showStarter = computed(() => {
    const s = this.starter();
    return !!s?.installing && !s.error && (s.progressPct ?? 0) < 100;
  });

  readonly starterLabel = computed(() => {
    const phase = this.starter()?.phase;
    if (phase === 'verify') return 'Verifying sample audiobook…';
    if (phase === 'extract') return 'Unpacking sample audiobook…';
    return 'Downloading sample audiobook…';
  });

  readonly visible = computed(
    () => this.actionableComponents().length > 0 || this.showStarter()
  );

  async ngOnInit(): Promise<void> {
    if (!this.api) return;
    try {
      this.components.set((await this.api.listComponents?.()) ?? []);
    } catch {
      /* bridge present but call failed — stay inert */
    }
    if (this.api.onComponentsAvailable) {
      this.unsubs.push(this.api.onComponentsAvailable((list: ComponentUpdateStatus[]) => this.components.set(list)));
    }
    if (this.api.onComponentStatus) {
      this.unsubs.push(this.api.onComponentStatus((s: ComponentUpdateStatus) => this.onComponentProgress(s)));
    }
    if (this.api.onStarterProgress) {
      this.unsubs.push(this.api.onStarterProgress((s: StarterStatus) => this.starter.set(s)));
    }
  }

  ngOnDestroy(): void {
    this.unsubs.forEach((u) => u());
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

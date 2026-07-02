import { Component, inject, signal, computed, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService, WhisperModelStatus, WhisperDownloadProgress } from '../../../core/services/electron.service';
import { ComponentService } from '../../../core/services/component.service';

/**
 * Settings → Add-ons → Speech to Text.
 *
 * Manages the downloadable faster-whisper transcription MODELS (the runtime, id
 * 'whisper', installs via the generic add-on card above). Each model shows its
 * size + a Download / Delete action with a live progress bar. Models are used by
 * the Versions page "Generate sentences" button.
 */
@Component({
  selector: 'app-whisper-models-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!runtimeInstalled()) {
      <p class="hint">
        Install the <strong>Speech to Text (Whisper)</strong> runtime above first, then download a model here.
      </p>
    }

    @if (error(); as e) {
      <div class="err">{{ e }}</div>
    }

    <div class="model-list" [class.dimmed]="!runtimeInstalled()">
      @for (m of models(); track m.id) {
        <div class="model-card">
          <div class="model-meta">
            <h4 class="model-name">{{ m.label }}</h4>
            <p class="model-note">{{ m.note }}</p>
          </div>
          <div class="model-side">
            <span class="model-size">{{ formatMB(m.sizeMB) }}</span>

            @if (downloadPct(m.id) !== null) {
              <div class="dl">
                <div class="bar"><div class="fill" [style.width.%]="downloadPct(m.id)"></div></div>
                <span class="dl-label">{{ downloadPct(m.id) }}%</span>
              </div>
            } @else if (m.present) {
              <span class="badge ok">Downloaded ✓</span>
              <desktop-button variant="ghost" size="sm" (click)="remove(m.id)" [disabled]="busy(m.id)">
                Delete
              </desktop-button>
            } @else {
              <desktop-button variant="primary" size="sm" (click)="download(m.id)" [disabled]="busy(m.id) || !runtimeInstalled()">
                Download
              </desktop-button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .hint { margin: 0 0 var(--ui-spacing-md) 0; font-size: var(--ui-font-sm); color: var(--text-secondary); }
    .hint strong { color: var(--text-primary); }
    .err { padding: var(--ui-spacing-sm) var(--ui-spacing-md); background: var(--error-bg); color: var(--error);
      border-radius: $radius-md; font-size: var(--ui-font-sm); margin-bottom: var(--ui-spacing-md); }

    .model-list { display: flex; flex-direction: column; gap: var(--ui-spacing-sm); }
    .model-list.dimmed { opacity: 0.6; }

    .model-card {
      display: flex; align-items: center; justify-content: space-between; gap: var(--ui-spacing-lg);
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: $radius-md;
    }
    .model-meta { flex: 1; min-width: 0; }
    .model-name { margin: 0 0 2px 0; font-size: var(--ui-font-sm); font-weight: $font-weight-semibold; color: var(--text-primary); }
    .model-note { margin: 0; font-size: var(--ui-font-xs); color: var(--text-tertiary); }

    .model-side { display: flex; align-items: center; gap: var(--ui-spacing-md); flex-shrink: 0; }
    .model-size { font-size: var(--ui-font-xs); color: var(--text-tertiary); min-width: 56px; text-align: right; }

    .badge.ok { font-size: var(--ui-font-xs); padding: 2px 8px; border-radius: 4px;
      background: var(--success-bg); color: var(--success); white-space: nowrap; }

    .dl { display: flex; align-items: center; gap: var(--ui-spacing-sm); min-width: 160px; }
    .bar { flex: 1; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width $duration-fast $ease-out; }
    .dl-label { font-size: var(--ui-font-xs); color: var(--text-secondary); min-width: 32px; text-align: right; }
  `],
})
export class WhisperModelsPanelComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly components = inject(ComponentService);

  readonly models = signal<WhisperModelStatus[]>([]);
  readonly error = signal<string | null>(null);
  private readonly progress = signal<Record<string, number>>({});
  private readonly busyIds = signal<Set<string>>(new Set());
  private unsubscribe: (() => void) | null = null;

  readonly runtimeInstalled = computed(() => this.components.isInstalled('whisper'));

  ngOnInit(): void {
    void this.reload();
    this.unsubscribe = this.electron.whisper.onDownloadProgress((p: WhisperDownloadProgress) => {
      this.progress.update((m) => ({ ...m, [p.id]: p.pct }));
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  async reload(): Promise<void> {
    const res = await this.electron.whisper.listModels();
    if (res.success && res.data) {
      this.models.set(res.data);
      this.error.set(null);
    } else {
      this.error.set(res.error || 'Could not load Whisper models.');
    }
  }

  downloadPct(id: string): number | null {
    const p = this.progress()[id];
    return p === undefined ? null : p;
  }

  busy(id: string): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: string, on: boolean): void {
    this.busyIds.update((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  }

  private clearProgress(id: string): void {
    this.progress.update((m) => { const n = { ...m }; delete n[id]; return n; });
  }

  async download(id: string): Promise<void> {
    if (this.busy(id)) return;
    this.setBusy(id, true);
    this.progress.update((m) => ({ ...m, [id]: 0 }));
    this.error.set(null);
    try {
      const res = await this.electron.whisper.downloadModel(id);
      if (!res.ok) this.error.set(res.error || `Failed to download ${id}.`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.clearProgress(id);
      this.setBusy(id, false);
      await this.reload();
    }
  }

  async remove(id: string): Promise<void> {
    if (this.busy(id)) return;
    this.setBusy(id, true);
    try {
      const res = await this.electron.whisper.deleteModel(id);
      if (!res.ok) this.error.set(res.error || `Failed to delete ${id}.`);
    } finally {
      this.setBusy(id, false);
      await this.reload();
    }
  }

  formatMB(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  }
}

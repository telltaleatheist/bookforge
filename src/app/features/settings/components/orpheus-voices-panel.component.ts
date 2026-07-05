import { Component, inject, computed, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';

interface OrpheusCatalogEntry {
  repoId: string; id: string; token: string; label: string;
  sampleRate: number; private: boolean; installed: boolean;
}

/**
 * Orpheus voices panel — used on the first-run setup Orpheus step AND in Settings.
 *
 * Shows the Orpheus ENGINE (the `orpheus` ComponentService component) plus the
 * downloadable VOICE models. Voices are resolved from a user-managed list of
 * HuggingFace source repos (built-in defaults + whatever the user adds), each
 * carrying its prompt token on its model card. Install downloads the repo into
 * runtime/orpheus-models/<token>/ where the engine auto-discovers it — see
 * electron/orpheus-hf-catalog.ts. Voices flow through the orpheusModels IPC, not
 * ComponentService, so this panel drives them directly.
 */
@Component({
  selector: 'app-orpheus-voices-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="enh-panel">
      <div class="explainer">
        <p>
          <strong>Orpheus</strong> is a more natural, GPU-heavy narration engine. Install the engine,
          then download voice models — each is a full fine-tune, so they're large but sound great.
          Voices come from the sources below; add more HuggingFace repos (tagged with an
          <code>orpheus_token</code>) to grow the list.
        </p>
      </div>

      <!-- Engine (the "orpheus model") -->
      <h3 class="group-title">Engine</h3>
      @if (engine(); as e) {
        <div class="component-card">
          <div class="component-head">
            <div class="component-meta">
              <h4 class="component-name">{{ e.component.name }}</h4>
              <p class="component-desc">{{ e.component.description }}</p>
            </div>
            <div class="component-badge">
              <span class="status-badge" [ngClass]="badgeClass(e.state)">{{ badgeLabel(e.state) }}</span>
              @if (e.component.sizeBytes > 0) { <span class="component-size">{{ formatBytes(e.component.sizeBytes) }}</span> }
            </div>
          </div>
          @if (e.state === 'installing' && e.progress; as prog) {
            <div class="install-progress">
              <div class="progress-bar" [class.indeterminate]="prog.phase !== 'download'"><div class="progress-fill" [style.width.%]="prog.phase === 'download' ? prog.pct : 100"></div></div>
              <span class="progress-label">{{ prog.message || 'Installing…' }}</span>
            </div>
          }
          <div class="component-actions">
            @switch (e.state) {
              @case ('installed') { <desktop-button variant="ghost" size="sm" (click)="svc.remove('orpheus')" [disabled]="svc.isBusy('orpheus')">Uninstall</desktop-button> }
              @case ('installing') { <desktop-button variant="ghost" size="sm" (click)="svc.cancel('orpheus')">Cancel</desktop-button> }
              @case ('incompatible') { <span class="action-note">Not available on this machine</span> }
              @default {
                <desktop-button variant="primary" size="sm" (click)="svc.install('orpheus')" [disabled]="svc.isBusy('orpheus')">
                  {{ svc.isBusy('orpheus') ? 'Downloading…' : 'Download & Install' }}
                </desktop-button>
              }
            }
          </div>
        </div>
      }

      <!-- Voices -->
      <h3 class="group-title">Voice models</h3>
      @if (loading()) {
        <p class="muted">Loading voices…</p>
      } @else if (catalog().length === 0) {
        <p class="muted">No voices resolved from the current sources. Add a source below, or check your HuggingFace token in Settings for private repos.</p>
      } @else {
        @for (v of catalog(); track v.repoId) {
          <div class="component-card">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">{{ v.label }} @if (v.private) { <span class="lock" title="Private repo — needs your HuggingFace token">🔒</span> }</h4>
                <p class="component-desc">{{ v.repoId }} · token “{{ v.token }}”</p>
              </div>
              <div class="component-badge">
                <span class="status-badge" [ngClass]="v.installed ? 'installed' : (busy().has(v.repoId) ? 'installing' : 'available')">
                  {{ v.installed ? 'Installed' : (busy().has(v.repoId) ? 'Installing' : 'Available') }}
                </span>
              </div>
            </div>
            <div class="component-actions">
              @if (v.installed) {
                <desktop-button variant="ghost" size="sm" (click)="removeVoice(v)" [disabled]="busy().has(v.repoId)">Uninstall</desktop-button>
              } @else {
                <desktop-button variant="primary" size="sm" (click)="installVoice(v)" [disabled]="busy().has(v.repoId)">
                  {{ busy().has(v.repoId) ? 'Downloading…' : 'Download & Install' }}
                </desktop-button>
              }
            </div>
          </div>
        }
      }

      <!-- Sources -->
      <h3 class="group-title">Voice sources</h3>
      @for (s of sources(); track s) {
        <div class="source-row">
          <span class="source-id">{{ s }}</span>
          <button class="source-del" (click)="removeSource(s)" title="Remove source">✕</button>
        </div>
      }
      <div class="source-add">
        <input class="source-input" type="text" placeholder="owner/name or a HuggingFace URL"
               [value]="newSource()" (input)="newSource.set($any($event.target).value)"
               (keydown.enter)="addSource()" />
        <desktop-button variant="ghost" size="sm" (click)="addSource()" [disabled]="!newSource().trim()">Add source</desktop-button>
      </div>

      @if (error()) { <p class="muted danger">{{ error() }}</p> }
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;
    .enh-panel { display: flex; flex-direction: column; gap: var(--ui-spacing-md); }
    .explainer { padding: var(--ui-spacing-md) var(--ui-spacing-lg); background: color-mix(in srgb, var(--accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); border-radius: $radius-md;
      p { margin: 0; font-size: var(--ui-font-sm); color: var(--text-secondary); line-height: 1.5; } code { font-size: 0.9em; } }
    .group-title { margin: var(--ui-spacing-sm) 0 0; font-size: var(--ui-font-xs); font-weight: $font-weight-semibold; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
    .muted { font-size: var(--ui-font-sm); color: var(--text-tertiary); margin: 0; }
    .muted.danger { color: var(--error); }
    .action-note { font-size: var(--ui-font-xs); color: var(--text-tertiary); }
    .lock { font-size: 0.8em; }
    .component-card { display: flex; flex-direction: column; gap: var(--ui-spacing-md); padding: var(--ui-spacing-lg); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: $radius-md; }
    .component-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--ui-spacing-lg); }
    .component-meta { flex: 1; min-width: 0; }
    .component-name { margin: 0 0 var(--ui-spacing-xs) 0; font-size: var(--ui-font-base); font-weight: $font-weight-semibold; color: var(--text-primary); }
    .component-desc { margin: 0; font-size: var(--ui-font-sm); color: var(--text-tertiary); overflow-wrap: anywhere; }
    .component-badge { display: flex; flex-direction: column; align-items: flex-end; gap: var(--ui-spacing-xs); flex-shrink: 0; }
    .status-badge { font-size: var(--ui-font-xs); padding: 2px 8px; border-radius: 4px; white-space: nowrap;
      &.installed { background: var(--success-bg); color: var(--success); }
      &.available { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
      &.installing { background: var(--bg-elevated); color: var(--text-secondary); } }
    .component-size { font-size: var(--ui-font-xs); color: var(--text-tertiary); }
    .install-progress { display: flex; flex-direction: column; gap: var(--ui-spacing-xs); }
    .progress-bar { width: 100%; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--accent); transition: width $duration-fast $ease-out; }
    .progress-bar.indeterminate .progress-fill { width: 35% !important; animation: indeterminate-slide 1.2s ease-in-out infinite; }
    @keyframes indeterminate-slide { from { margin-left: -35%; } to { margin-left: 100%; } }
    .progress-label { font-size: var(--ui-font-xs); color: var(--text-secondary); }
    .component-actions { display: flex; gap: var(--ui-spacing-sm); justify-content: flex-end; }
    .source-row { display: flex; align-items: center; gap: var(--ui-spacing-sm); padding: var(--ui-spacing-sm) var(--ui-spacing-md); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: $radius-md; }
    .source-id { flex: 1; min-width: 0; font-size: var(--ui-font-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
    .source-del { flex-shrink: 0; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: 6px; }
    .source-del:hover { color: var(--error); }
    .source-add { display: flex; gap: var(--ui-spacing-sm); align-items: center; }
    .source-input { flex: 1; min-width: 0; padding: 8px 10px; font-size: var(--ui-font-sm); color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: $radius-md; outline: none; }
    .source-input:focus { border-color: var(--accent); }
  `],
})
export class OrpheusVoicesPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);

  readonly catalog = signal<OrpheusCatalogEntry[]>([]);
  readonly sources = signal<string[]>([]);
  readonly busy = signal<Set<string>>(new Set());
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly newSource = signal('');

  /** The `orpheus` engine component from ComponentService (the "orpheus model"). */
  readonly engine = computed(() =>
    this.svc.components().find((s) => s.component.id === 'orpheus') ?? null,
  );

  private get api(): any { return (window as any).electron?.orpheusModels; }

  ngOnInit(): void {
    this.svc.ensureLoaded();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.api) { this.loading.set(false); return; }
    this.loading.set(true);
    try {
      const [cat, src] = await Promise.all([this.api.catalogList?.(), this.api.sourcesGet?.()]);
      if (cat?.success) this.catalog.set(cat.data ?? []);
      else if (cat && !cat.success) this.error.set(cat.error ?? null);
      if (src?.success) this.sources.set(src.data ?? []);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private setBusy(key: string, on: boolean): void {
    this.busy.update((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
  }

  async installVoice(v: OrpheusCatalogEntry): Promise<void> {
    this.error.set(null);
    this.setBusy(v.repoId, true);
    try {
      const res = await this.api?.install?.(v.repoId);
      if (res && !res.success) this.error.set(res.error ?? 'Install failed.');
    } finally {
      this.setBusy(v.repoId, false);
      await this.refresh();
    }
  }

  async removeVoice(v: OrpheusCatalogEntry): Promise<void> {
    this.error.set(null);
    this.setBusy(v.repoId, true);
    try {
      const res = await this.api?.remove?.(v.id);
      if (res && !res.success) this.error.set(res.error ?? 'Uninstall failed.');
    } finally {
      this.setBusy(v.repoId, false);
      await this.refresh();
    }
  }

  async addSource(): Promise<void> {
    const input = this.newSource().trim();
    if (!input) return;
    this.error.set(null);
    const res = await this.api?.sourcesAdd?.(input);
    if (res && !res.success) { this.error.set(res.error ?? 'Could not add source.'); return; }
    this.newSource.set('');
    await this.refresh();
  }

  async removeSource(repoId: string): Promise<void> {
    await this.api?.sourcesRemove?.(repoId);
    await this.refresh();
  }

  badgeClass(state: string): string {
    switch (state) {
      case 'installed': return 'installed';
      case 'installing': return 'installing';
      case 'incompatible': return 'incompatible';
      default: return 'available';
    }
  }
  badgeLabel(state: string): string {
    switch (state) {
      case 'installed': return 'Installed';
      case 'installing': return 'Installing';
      case 'incompatible': return 'Incompatible';
      default: return 'Available';
    }
  }
  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '';
    const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

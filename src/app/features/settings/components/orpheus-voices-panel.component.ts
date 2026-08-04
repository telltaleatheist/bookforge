import { Component, inject, computed, signal, ChangeDetectionStrategy, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';

interface OrpheusCatalogEntry {
  repoId: string; id: string; token: string; label: string;
  sampleRate: number; private: boolean; installed: boolean;
  /** Local folder/manifest id when installed (may differ from `id`). Uninstall target. */
  installedId?: string;
  /** 'merged' = a full ~6.6 GB fine-tune; 'adapter' = a ~0.4 GB LoRA on the shared base. */
  artifact: 'merged' | 'adapter';
  base?: { id: string; ref: string; dir?: string };
  /** Adapter voice whose shared base isn't installed yet. NOT a block on Download —
   *  the install runs base-then-voice — just what the size/copy explains. */
  needsBase?: boolean;
  approxSizeBytes: number;
}

/** An INSTALLED voice as `orpheusModels.list` reports it. Read here for one thing:
 *  `baseMissing`, the adapter voice that is installed but can't render. */
interface OrpheusInstalledModel {
  id: string; label: string; voice: string; dir: string;
  artifact: 'merged' | 'adapter';
  baseMissing?: true;
}

interface OrpheusBaseStatus {
  base: { id: string; ref: string; dir?: string };
  installed: boolean;
  verified: boolean;
  dir?: string;
  approxSizeBytes: number;
  /** True when at least one catalogued voice is an adapter, i.e. the base is needed. */
  required: boolean;
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
          then the voices you want. Most voices are small <strong>voice packs</strong> (about
          0.4&nbsp;GB each) that run on top of one shared base model — the first voice pack downloads
          that base model for you, and every voice after it is quick. A few older voices are full
          standalone models and are correspondingly large. Voices come from the sources below; add more
          HuggingFace repos (tagged with an <code>orpheus_token</code>) to grow the list.
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

      <!-- Shared base model: downloaded ONCE, reused by every voice pack. Hidden when
           no catalogued voice needs it (an all-merged source list). -->
      @if (base(); as b) {
        @if (b.required) {
          <h3 class="group-title">Base model</h3>
          <div class="component-card">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">Orpheus base model</h4>
                <p class="component-desc">
                  {{ b.base.ref }} · shared by every voice pack — downloaded once, then each voice is
                  only about 0.4&nbsp;GB.
                </p>
              </div>
              <div class="component-badge">
                <span class="status-badge" [ngClass]="b.installed ? 'installed' : (baseBusy() ? 'installing' : 'available')">
                  {{ b.installed ? 'Installed' : (baseBusy() ? 'Installing' : 'Available') }}
                </span>
                <span class="component-size">{{ formatBytes(b.approxSizeBytes) }}</span>
              </div>
            </div>
            @if (baseBusy()) {
              <div class="install-progress">
                <div class="progress-bar indeterminate"><div class="progress-fill"></div></div>
                <span class="progress-label">Downloading shared base model (one time)…</span>
              </div>
            }
            <div class="component-actions">
              @if (b.installed) {
                <span class="action-note">Ready — voice packs will use this.</span>
              } @else {
                <desktop-button variant="primary" size="sm" (click)="installBase()" [disabled]="baseBusy()">
                  {{ baseBusy() ? 'Downloading…' : 'Download & Install' }}
                </desktop-button>
              }
            </div>
          </div>
        }
      }

      <!-- Voices -->
      <h3 class="group-title">Voice models</h3>
      @if (loading()) {
        <p class="muted">Loading voices…</p>
      } @else if (catalog().length === 0) {
        <p class="muted">No voices resolved from the current sources. Add a source below, or check your HuggingFace token in Settings for private repos.</p>
      } @else {
        @for (v of catalog(); track v.repoId) {
          <div class="component-card" [class.unusable]="isUnusable(v)">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">{{ v.label }} @if (v.private) { <span class="lock" title="Private repo — needs your HuggingFace token">🔒</span> }</h4>
                <p class="component-desc">
                  {{ v.repoId }} · token “{{ v.token }}” ·
                  {{ v.artifact === 'adapter' ? 'voice pack (uses the shared base model)' : 'full standalone model' }}
                </p>
              </div>
              <div class="component-badge">
                @if (isUnusable(v)) {
                  <span class="status-badge unusable">Needs base model</span>
                } @else {
                  <span class="status-badge" [ngClass]="v.installed ? 'installed' : (busy().has(v.repoId) ? 'installing' : 'available')">
                    {{ v.installed ? 'Installed' : (busy().has(v.repoId) ? 'Installing' : 'Available') }}
                  </span>
                }
                <span class="component-size">{{ formatBytes(v.approxSizeBytes) }}</span>
              </div>
            </div>
            @if (busy().has(v.repoId) && installMessage()[v.repoId]; as msg) {
              <div class="install-progress">
                <div class="progress-bar indeterminate"><div class="progress-fill"></div></div>
                <span class="progress-label">{{ msg }}</span>
              </div>
            }
            <div class="component-actions">
              @if (isUnusable(v)) {
                <span class="action-note">
                  Installed, but it can't be used until the shared base model above is installed.
                </span>
                <desktop-button variant="primary" size="sm" (click)="installBase()" [disabled]="baseBusy()">
                  {{ baseBusy() ? 'Downloading…' : 'Install base model' }}
                </desktop-button>
                <desktop-button variant="ghost" size="sm" (click)="removeVoice(v)" [disabled]="busy().has(v.repoId)">Uninstall</desktop-button>
              } @else if (v.installed) {
                <desktop-button variant="ghost" size="sm" (click)="removeVoice(v)" [disabled]="busy().has(v.repoId)">Uninstall</desktop-button>
              } @else {
                <!-- The Download button drives BOTH phases: an adapter voice whose base
                     is missing installs the base first, then the voice. So this is a
                     passive note, never a gate. -->
                @if (v.artifact === 'adapter' && !baseInstalled()) {
                  <span class="action-note">Also downloads the shared base model (once)</span>
                }
                <desktop-button variant="primary" size="sm" (click)="installVoice(v)"
                                [disabled]="busy().has(v.repoId)">
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
      &.installing { background: var(--bg-elevated); color: var(--text-secondary); }
      &.unusable { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); } }
    /* Installed but not renderable (adapter voice, base model missing): dimmed so it
       reads as inert, with the fix offered in its own actions row. */
    .component-card.unusable { border-color: color-mix(in srgb, var(--warning) 40%, var(--border-subtle));
      .component-name, .component-desc { opacity: 0.65; } }
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
export class OrpheusVoicesPanelComponent implements OnInit, OnDestroy {
  readonly svc = inject(ComponentService);

  readonly catalog = signal<OrpheusCatalogEntry[]>([]);
  readonly base = signal<OrpheusBaseStatus | null>(null);
  /** Locally installed voices — read for `baseMissing` (see isUnusable). */
  readonly installed = signal<OrpheusInstalledModel[]>([]);
  readonly sources = signal<string[]>([]);
  readonly busy = signal<Set<string>>(new Set());
  readonly baseBusy = signal(false);
  /** repoId → the current two-phase install message ("Downloading shared base model…"). */
  readonly installMessage = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly newSource = signal('');

  /** The `orpheus` engine component from ComponentService (the "orpheus model"). */
  readonly engine = computed(() =>
    this.svc.components().find((s) => s.component.id === 'orpheus') ?? null,
  );

  /** True once the shared base is on disk. Informational only — it does NOT gate any
   *  Download, because the install itself fetches the base when it's missing. */
  readonly baseInstalled = computed(() => this.base()?.installed === true);

  /** Installed voices that resolved BROKEN — an adapter whose shared base isn't there.
   *  They are installed and visible everywhere, but every render path refuses them, so
   *  this panel is where that gets explained. Keyed by local id. */
  private readonly baseMissingIds = computed(
    () => new Set(this.installed().filter((m) => m.baseMissing).map((m) => m.id)),
  );

  /** This catalogue voice is installed but can't render (its base model is missing). */
  isUnusable(v: OrpheusCatalogEntry): boolean {
    return v.installed && this.baseMissingIds().has(v.installedId ?? v.id);
  }

  private unsubscribeProgress?: () => void;

  private get api(): any { return (window as any).electron?.orpheusModels; }

  ngOnInit(): void {
    this.svc.ensureLoaded();
    this.unsubscribeProgress = this.api?.onInstallProgress?.(
      // 'fuse' is macOS-only (see orpheus-hf-catalog runFuse); the panel shows the
      // message whatever the phase.
      (p: { repoId: string; phase: 'base' | 'voice' | 'fuse'; message: string }) => {
        this.installMessage.update((m) => ({ ...m, [p.repoId]: p.message }));
      },
    );
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
  }

  async refresh(): Promise<void> {
    if (!this.api) { this.loading.set(false); return; }
    this.loading.set(true);
    try {
      // The catalogue is fetched FIRST and then handed to baseStatus: which base this
      // machine needs is a fact about the catalogue, so asking for it in parallel makes
      // the main process fetch every source repo's model card a second time.
      const [cat, src, list] = await Promise.all([
        this.api.catalogList?.(),
        this.api.sourcesGet?.(),
        this.api.list?.(),
      ]);
      if (cat?.success) this.catalog.set(cat.data ?? []);
      else if (cat && !cat.success) this.error.set(cat.error ?? null);
      if (src?.success) this.sources.set(src.data ?? []);
      if (list?.success) this.installed.set(list.data ?? []);
      const base = await this.api.baseStatus?.(cat?.success ? cat.data : undefined);
      if (base?.success) this.base.set(base.data ?? null);
      else if (base && !base.success) this.error.set(base.error ?? null);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private setBusy(key: string, on: boolean): void {
    this.busy.update((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
  }

  /** Install the shared base on its own. Installing an adapter voice does this
   *  implicitly too; this button exists so the one-time cost can be paid up front. */
  async installBase(): Promise<void> {
    this.error.set(null);
    this.baseBusy.set(true);
    try {
      const res = await this.api?.baseInstall?.(this.catalog());
      if (res && !res.success) this.error.set(res.error ?? 'Base model install failed.');
    } finally {
      this.baseBusy.set(false);
      await this.refresh();
    }
  }

  async installVoice(v: OrpheusCatalogEntry): Promise<void> {
    this.error.set(null);
    this.setBusy(v.repoId, true);
    this.installMessage.update((m) => ({
      ...m,
      [v.repoId]: v.artifact === 'adapter' && !this.baseInstalled()
        ? 'Downloading shared base model (one time)…'
        : `Downloading the ${v.label} voice…`,
    }));
    try {
      const res = await this.api?.install?.(v.repoId);
      if (res && !res.success) this.error.set(res.error ?? 'Install failed.');
    } finally {
      this.setBusy(v.repoId, false);
      this.installMessage.update((m) => { const n = { ...m }; delete n[v.repoId]; return n; });
      await this.refresh();
    }
  }

  async removeVoice(v: OrpheusCatalogEntry): Promise<void> {
    this.error.set(null);
    this.setBusy(v.repoId, true);
    try {
      const res = await this.api?.remove?.(v.installedId ?? v.id);
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

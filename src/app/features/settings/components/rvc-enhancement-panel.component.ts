import { Component, inject, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { RvcVoicesService } from '../../../core/services/rvc-voices.service';

/**
 * Settings → Voice Enhancement.
 *
 * A dedicated screen for the OPTIONAL RVC voice-enhancement feature, kept separate
 * from the general Add-ons hub so it reads as its own thing: install the engine,
 * then install voice models. RVC runs AFTER the audiobook is narrated (post-TTS,
 * pre-assembly): it re-renders the finished narration through a matching voice
 * model to smooth out XTTS vocoder artifacts — it does not generate the narration
 * itself.
 *
 * Engine = the `rvc-env` managed component (ComponentService). Voices = the
 * downloadable RVC models (RvcVoicesService), shown only once the engine is in.
 * Both use the same component-card chrome as the rest of Settings.
 */
@Component({
  selector: 'app-rvc-enhancement-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="enh-panel">
      <div class="explainer">
        <p>
          <strong>Voice enhancement</strong> re-renders your finished narration through a matching
          RVC voice model to smooth out the synthetic artifacts XTTS can leave behind. It runs
          <em>after</em> the audiobook is narrated (and before assembly) — it doesn't replace your
          TTS voice, it polishes it. Pick an enhancement voice close to your TTS voice; RVC keeps the
          original's words and pitch.
        </p>
      </div>

      <!-- Engine -->
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
              @if (e.component.sizeBytes > 0) {
                <span class="component-size">{{ formatBytes(e.component.sizeBytes) }}</span>
              }
            </div>
          </div>

          @if (e.state === 'installing' && e.progress; as prog) {
            <div class="install-progress">
              <div class="progress-bar"><div class="progress-fill" [style.width.%]="prog.pct"></div></div>
              <span class="progress-label">{{ prog.message || 'Installing…' }}</span>
            </div>
          }

          @if (e.state === 'incompatible') {
            <ul class="reason-list">
              @for (r of e.compatibility.reasons; track r) { <li>{{ r }}</li> }
            </ul>
          }

          <div class="component-actions">
            @switch (e.state) {
              @case ('installed') {
                <desktop-button variant="ghost" size="sm"
                  (click)="svc.remove('rvc-env')" [disabled]="svc.isBusy('rvc-env')">Uninstall</desktop-button>
              }
              @case ('installing') {
                <desktop-button variant="ghost" size="sm" (click)="svc.cancel('rvc-env')">Cancel</desktop-button>
              }
              @case ('incompatible') {
                <span class="action-note">Not available on this machine</span>
              }
              @default {
                <desktop-button variant="primary" size="sm"
                  (click)="svc.install('rvc-env')" [disabled]="svc.isBusy('rvc-env')">
                  {{ svc.isBusy('rvc-env') ? 'Downloading…' : 'Download & Install' }}
                </desktop-button>
              }
            }
          </div>
        </div>
      } @else {
        <p class="muted">The voice-enhancement engine isn't available on this platform.</p>
      }

      <!-- Voices -->
      <h3 class="group-title">Enhancement Voices</h3>
      @if (!engineInstalled()) {
        <p class="muted">Install the engine above to add enhancement voices.</p>
      } @else {
        @for (v of rvcVoices.voices(); track v.id) {
          <div class="component-card">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">{{ v.label }}</h4>
                <p class="component-desc">Enhances {{ v.matches }}</p>
              </div>
              <div class="component-badge">
                <span class="status-badge"
                      [ngClass]="v.installed ? 'installed' : (rvcVoices.isBusy(v.id) ? 'installing' : 'available')">
                  {{ v.installed ? 'Installed' : (rvcVoices.isBusy(v.id) ? 'Installing' : 'Available') }}
                </span>
                <span class="component-size">{{ formatBytes(v.bytes) }}</span>
              </div>
            </div>

            @if (rvcVoices.isBusy(v.id)) {
              <div class="install-progress">
                <div class="progress-bar"><div class="progress-fill" [style.width.%]="progressPct(v.id)"></div></div>
                <span class="progress-label">{{ rvcVoices.progressOf(v.id) || 'Installing…' }}</span>
              </div>
            }

            <div class="component-actions">
              @if (v.installed) {
                <desktop-button variant="ghost" size="sm"
                  (click)="rvcVoices.remove(v.id)" [disabled]="rvcVoices.isBusy(v.id)">Uninstall</desktop-button>
              } @else {
                <desktop-button variant="primary" size="sm"
                  (click)="rvcVoices.install(v.id)" [disabled]="rvcVoices.isBusy(v.id)">
                  {{ rvcVoices.isBusy(v.id) ? 'Downloading…' : 'Download & Install' }}
                </desktop-button>
              }
            </div>
          </div>
        }
        @if (rvcVoices.error()) { <p class="muted danger">{{ rvcVoices.error() }}</p> }
      }
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .enh-panel { display: flex; flex-direction: column; gap: var(--ui-spacing-md); }

    .explainer {
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-radius: $radius-md;
      p { margin: 0; font-size: var(--ui-font-sm); color: var(--text-secondary); line-height: 1.5; }
    }

    .group-title {
      margin: var(--ui-spacing-sm) 0 0;
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-tertiary);
    }

    .muted { font-size: var(--ui-font-sm); color: var(--text-tertiary); margin: 0; }
    .muted.danger { color: var(--error); }
    .action-note { font-size: var(--ui-font-xs); color: var(--text-tertiary); }

    .component-card {
      display: flex; flex-direction: column; gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
    }
    .component-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--ui-spacing-lg); }
    .component-meta { flex: 1; min-width: 0; }
    .component-name { margin: 0 0 var(--ui-spacing-xs) 0; font-size: var(--ui-font-base); font-weight: $font-weight-semibold; color: var(--text-primary); }
    .component-desc { margin: 0; font-size: var(--ui-font-sm); color: var(--text-tertiary); }
    .component-badge { display: flex; flex-direction: column; align-items: flex-end; gap: var(--ui-spacing-xs); flex-shrink: 0; }
    .status-badge {
      font-size: var(--ui-font-xs); padding: 2px 8px; border-radius: 4px; white-space: nowrap;
      &.installed { background: var(--success-bg); color: var(--success); }
      &.available { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
      &.incompatible { background: var(--error-bg); color: var(--error); }
      &.installing { background: var(--bg-elevated); color: var(--text-secondary); }
    }
    .component-size { font-size: var(--ui-font-xs); color: var(--text-tertiary); }
    .reason-list { margin: 0; padding-left: var(--ui-spacing-lg); font-size: var(--ui-font-sm); color: var(--error); li { margin: 2px 0; } }
    .install-progress { display: flex; flex-direction: column; gap: var(--ui-spacing-xs); }
    .progress-bar { width: 100%; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--accent); transition: width $duration-fast $ease-out; }
    .progress-label { font-size: var(--ui-font-xs); color: var(--text-secondary); }
    .component-actions { display: flex; gap: var(--ui-spacing-sm); justify-content: flex-end; }
  `],
})
export class RvcEnhancementPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);
  readonly rvcVoices = inject(RvcVoicesService);

  /** The rvc-env engine component status (or null if not in the catalog here). */
  readonly engine = computed(() =>
    this.svc.components().find((s) => s.component.id === 'rvc-env') ?? null,
  );
  readonly engineInstalled = computed(() => this.svc.isInstalled('rvc-env'));

  ngOnInit(): void {
    this.svc.ensureLoaded();
    void this.rvcVoices.ensureLoaded();
  }

  /** Parse the percent out of an RVC voice progress message for the bar. */
  progressPct(id: string): number {
    const msg = this.rvcVoices.progressOf(id);
    const m = msg && /(\d+)\s*%/.exec(msg);
    return m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : 0;
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
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

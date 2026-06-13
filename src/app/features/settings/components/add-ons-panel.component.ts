import { Component, inject, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { ComponentStatus, OptionalComponent } from '../../../core/services/electron.service';

/**
 * Settings → Add-ons tab.
 *
 * Renders one card per optional component (Calibre, Tesseract, Orpheus, …) with
 * an honest status badge and mode-appropriate actions:
 *   - external + installed   → resolved path + Remove (forget)
 *   - external + not found   → Locate… + "How to install" link
 *   - managed  + available   → Install / Cancel + live progress bar
 *                              (stub-URL → "install it yourself" via error)
 *   - incompatible           → actions disabled, reasons shown
 *
 * See docs/optional-components-design.md ("UI (Phase 1)").
 */
@Component({
  selector: 'app-add-ons-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="add-ons-section">
      <!-- System info line: helps explain why something is incompatible -->
      @if (svc.profile(); as p) {
        <div class="system-info">
          <span class="sys-item">{{ platformLabel(p.platform) }} · {{ p.arch }}</span>
          @if (p.appleSilicon) {
            <span class="sys-item">Apple Silicon</span>
          }
          @if (p.cuda.available) {
            <span class="sys-item">{{ p.cuda.name || 'NVIDIA GPU' }}@if (p.cuda.vramMB) { · {{ formatBytes(p.cuda.vramMB * 1024 * 1024) }} VRAM }</span>
          } @else {
            <span class="sys-item muted">No CUDA GPU</span>
          }
          <span class="sys-item">{{ formatBytes(p.ramMB * 1024 * 1024) }} RAM</span>
          <span class="sys-item">{{ formatBytes(p.freeDiskMB * 1024 * 1024) }} free</span>
        </div>
      }

      @if (svc.error(); as err) {
        <div class="status-message error">{{ err }}</div>
      }

      @if (svc.loading() && addOns().length === 0) {
        <p class="loading-hint">Loading add-ons…</p>
      }

      <div class="component-list">
        @for (status of addOns(); track status.component.id) {
          <div class="component-card" [class.incompatible]="status.state === 'incompatible'">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">{{ status.component.name }}</h4>
                <p class="component-desc">{{ status.component.description }}</p>
              </div>
              <div class="component-badge">
                <span class="status-badge" [ngClass]="badgeClass(status)">{{ badgeLabel(status) }}</span>
                @if (status.component.sizeBytes > 0) {
                  <span class="component-size">{{ formatBytes(status.component.sizeBytes) }}</span>
                }
              </div>
            </div>

            <!-- Compatibility reasons (incompatible / degraded) -->
            @if (!status.compatibility.compatible || status.compatibility.degraded) {
              @if (status.compatibility.reasons.length > 0) {
                <ul class="reason-list" [class.warn]="status.compatibility.degraded && status.compatibility.compatible">
                  @for (reason of status.compatibility.reasons; track reason) {
                    <li>{{ reason }}</li>
                  }
                </ul>
              }
            }

            <!-- Resolved entry path for installed components -->
            @if (status.state === 'installed' && status.installed?.entryPath) {
              <div class="entry-path">
                <span class="entry-label">{{ status.installed?.source === 'external' ? 'Found at' : 'Installed at' }}</span>
                <code class="entry-value">{{ status.installed?.entryPath }}</code>
              </div>
            }

            <!-- Live install progress -->
            @if (status.state === 'installing' && status.progress; as prog) {
              <div class="install-progress">
                <div class="progress-bar">
                  <div class="progress-fill" [style.width.%]="prog.pct"></div>
                </div>
                <span class="progress-label">{{ phaseLabel(prog.phase) }}{{ prog.message ? ' — ' + prog.message : '' }}</span>
              </div>
            }

            <!-- Actions -->
            <div class="component-actions">
              @switch (status.state) {
                @case ('installed') {
                  <desktop-button
                    variant="ghost"
                    size="sm"
                    (click)="svc.remove(status.component.id)"
                    [disabled]="svc.isBusy(status.component.id)"
                  >
                    {{ status.installed?.source === 'managed' ? 'Uninstall' : 'Remove' }}
                  </desktop-button>
                }

                @case ('installing') {
                  @if (isManaged(status.component)) {
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      (click)="svc.cancel(status.component.id)"
                    >
                      Cancel
                    </desktop-button>
                  }
                }

                @case ('incompatible') {
                  <span class="action-note" [title]="status.compatibility.reasons.join('\n')">
                    Not available on this machine
                  </span>
                }

                @default {
                  <!-- available / error → offer acquisition actions -->
                  @if (canLocate(status.component)) {
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      (click)="svc.locate(status.component.id)"
                      [disabled]="svc.isBusy(status.component.id)"
                    >
                      Locate…
                    </desktop-button>
                    @if (status.component.externalHelpUrl) {
                      <a class="help-link" href="#" (click)="openHelp($event, status.component.externalHelpUrl!)">
                        How to install
                      </a>
                    }
                  }
                  @if (isManaged(status.component)) {
                    <desktop-button
                      variant="primary"
                      size="sm"
                      (click)="svc.install(status.component.id)"
                      [disabled]="svc.isBusy(status.component.id)"
                    >
                      Install
                    </desktop-button>
                  }
                  @if (status.state === 'error' && !canLocate(status.component) && !isManaged(status.component)) {
                    <span class="action-note">Unavailable</span>
                  }
                }
              }
            </div>
          </div>
        }
      </div>

      <div class="section-actions">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
      </div>

      <div class="help-text">
        <p>
          BookForge ships a small core and fetches heavy or platform-specific pieces on demand.
          Components you already installed yourself are auto-detected and shown as <strong>Installed</strong>.
          Use <strong>Locate…</strong> to point at one BookForge could not find.
        </p>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .add-ons-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .system-info {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ui-spacing-sm) var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .sys-item {
      &.muted { color: var(--text-tertiary); }
    }

    .loading-hint {
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
    }

    .component-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
    }

    .component-card {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;

      &.incompatible {
        opacity: 0.7;
      }
    }

    .component-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ui-spacing-lg);
    }

    .component-meta {
      flex: 1;
      min-width: 0;
    }

    .component-name {
      margin: 0 0 var(--ui-spacing-xs) 0;
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .component-desc {
      margin: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .component-badge {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--ui-spacing-xs);
      flex-shrink: 0;
    }

    .status-badge {
      font-size: var(--ui-font-xs);
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;

      &.installed { background: var(--success-bg); color: var(--success); }
      &.available { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
      &.incompatible { background: var(--error-bg); color: var(--error); }
      &.installing { background: var(--bg-elevated); color: var(--text-secondary); }
    }

    .component-size {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .reason-list {
      margin: 0;
      padding-left: var(--ui-spacing-lg);
      font-size: var(--ui-font-sm);
      color: var(--error);

      &.warn { color: var(--text-warning); }

      li { margin: 2px 0; }
    }

    .entry-path {
      display: flex;
      align-items: baseline;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
    }

    .entry-label {
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .entry-value {
      font-family: monospace;
      color: var(--text-secondary);
      word-break: break-all;
    }

    .install-progress {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
    }

    .progress-bar {
      width: 100%;
      height: 6px;
      background: var(--bg-elevated);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width $duration-fast $ease-out;
    }

    .progress-label {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .component-actions {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
    }

    .action-note {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .help-link {
      font-size: var(--ui-font-sm);
      color: var(--accent);
      text-decoration: none;

      &:hover { text-decoration: underline; }
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.error { background: var(--error-bg); color: var(--error); }
    }

    .section-actions {
      padding-top: var(--ui-spacing-sm);
    }

    .help-text {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);

      p { margin: 0; }
    }
  `],
})
export class AddOnsPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);

  /** Tools/runtimes only — TTS voices live in their own Voices panel. */
  readonly addOns = computed(() =>
    this.svc.components().filter(s => s.component.kind !== 'tts-model'),
  );

  /** Components offering managed (download) acquisition. */
  readonly managedIds = computed(() =>
    new Set(this.svc.components()
      .filter(c => c.component.acquisition.includes('managed'))
      .map(c => c.component.id)),
  );

  ngOnInit(): void {
    this.svc.refresh();
  }

  isManaged(component: OptionalComponent): boolean {
    return component.acquisition.includes('managed');
  }

  /** External-mode components can be pointed at via the Locate… picker. */
  canLocate(component: OptionalComponent): boolean {
    return component.acquisition.includes('external');
  }

  badgeClass(status: ComponentStatus): string {
    switch (status.state) {
      case 'installed': return 'installed';
      case 'incompatible': return 'incompatible';
      case 'installing': return 'installing';
      default: return 'available'; // available + error both render as "Available"
    }
  }

  badgeLabel(status: ComponentStatus): string {
    switch (status.state) {
      case 'installed': return 'Installed';
      case 'incompatible': return 'Incompatible';
      case 'installing': return 'Installing';
      case 'error': return 'Available';
      default: return 'Available';
    }
  }

  phaseLabel(phase: string): string {
    switch (phase) {
      case 'resolve': return 'Preparing…';
      case 'download': return 'Downloading…';
      case 'verify': return 'Verifying download…';
      case 'extract': return 'Extracting…';
      case 'postinstall': return 'Finishing install…';
      case 'verify-run': return 'Verifying install…';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      default: return phase;
    }
  }

  platformLabel(platform: string): string {
    switch (platform) {
      case 'darwin': return 'macOS';
      case 'win32': return 'Windows';
      case 'linux': return 'Linux';
      default: return platform;
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  openHelp(event: Event, url: string): void {
    event.preventDefault();
    this.svc.openExternal(url);
  }
}

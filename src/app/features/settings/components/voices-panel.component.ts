import { Component, inject, computed, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { ComponentStatus } from '../../../core/services/electron.service';

interface CustomVoice {
  id: string;
  name: string;
  checkpointDir: string;
  refPath: string;
}

/**
 * Settings → Voices.
 *
 * BookForge bundles one voice (Scarlett Johansson) and offers the rest as
 * one-click downloads. Each voice is a managed `tts-model` component, so this
 * panel reuses the whole component backend (ComponentService + IPC + progress)
 * — it just filters to voices and renders a Download button. Downloaded voices
 * land in the app's data folder (userData/runtime/e2a/models), not the library.
 */
@Component({
  selector: 'app-voices-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="voices-section">
      @if (svc.profile(); as p) {
        <div class="system-info">
          <span class="sys-item">{{ formatBytes(p.freeDiskMB * 1024 * 1024) }} free disk</span>
        </div>
      }

      @if (svc.error(); as err) {
        <div class="status-message error">{{ err }}</div>
      }

      @if (svc.loading() && voices().length === 0) {
        <p class="loading-hint">Loading voices…</p>
      }

      <div class="component-list">
        @for (status of voices(); track status.component.id) {
          <div class="component-card">
            <div class="component-head">
              <div class="component-meta">
                <h4 class="component-name">{{ status.component.name }}</h4>
                <p class="component-desc">{{ status.component.description }}</p>
              </div>
              <div class="component-badge">
                <span class="status-badge" [ngClass]="badgeClass(status)">{{ badgeLabel(status) }}</span>
                @if (status.state !== 'installed' && status.component.sizeBytes > 0) {
                  <span class="component-size">{{ formatBytes(status.component.sizeBytes) }}</span>
                }
              </div>
            </div>

            @if (status.state === 'installing' && status.progress; as prog) {
              <div class="install-progress">
                <div class="progress-bar">
                  <div class="progress-fill" [style.width.%]="prog.pct"></div>
                </div>
                <span class="progress-label">
                  {{ phaseLabel(prog.phase) }}
                  @if (prog.totalBytes) {
                    — {{ formatBytes(prog.receivedBytes || 0) }} / {{ formatBytes(prog.totalBytes) }}
                  } @else if (prog.message) {
                    — {{ prog.message }}
                  }
                </span>
              </div>
            }

            <div class="component-actions">
              @switch (status.state) {
                @case ('installed') {
                  <span class="action-note ok">✓ Ready to use</span>
                }
                @case ('installing') {
                  <desktop-button variant="ghost" size="sm" (click)="svc.cancel(status.component.id)">
                    Cancel
                  </desktop-button>
                }
                @default {
                  <desktop-button
                    variant="primary"
                    size="sm"
                    (click)="svc.install(status.component.id)"
                    [disabled]="svc.isBusy(status.component.id)"
                  >
                    Download
                  </desktop-button>
                }
              }
            </div>
          </div>
        }
      </div>

      <!-- User-added custom voices (own fine-tuned XTTS checkpoints) -->
      <div class="custom-voices">
        <div class="custom-head">
          <h4 class="custom-title">Your Voices</h4>
          <desktop-button variant="ghost" size="sm" (click)="addCustomVoice()" [disabled]="customBusy()">
            {{ customBusy() ? 'Adding…' : 'Add your own voice…' }}
          </desktop-button>
        </div>

        @if (customError(); as err) {
          <div class="status-message error">{{ err }}</div>
        }

        @if (customVoices().length > 0) {
          @for (cv of customVoices(); track cv.id) {
            <div class="component-card">
              <div class="component-head">
                <div class="component-meta">
                  <h4 class="component-name">{{ cv.name }}</h4>
                  <p class="component-desc">{{ cv.checkpointDir }}</p>
                </div>
                <div class="component-badge">
                  <span class="status-badge installed">Ready</span>
                </div>
              </div>
              <div class="component-actions">
                <desktop-button variant="ghost" size="sm" (click)="removeCustomVoice(cv.id)">
                  Remove
                </desktop-button>
              </div>
            </div>
          }
        } @else {
          <p class="help-text">
            Have your own fine-tuned XTTS voice? Add the folder that holds
            <code>config.json</code>, <code>model.pth</code>, <code>vocab.json</code> and a
            reference <code>.wav</code>. It'll appear in the Play tab and the browser extension.
          </p>
        }
      </div>

      <div class="section-actions">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
      </div>

      <div class="help-text">
        <p>
          BookForge ships with the Scarlett Johansson voice. Download any other voice with one
          click — it's saved in the app's data folder and stays available across updates.
          Downloads run in the background; you can keep working.
        </p>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .voices-section {
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
      &.installing { background: var(--bg-elevated); color: var(--text-secondary); }
    }

    .component-size {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
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

      &.ok { color: var(--success); }
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

    .custom-voices {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
      padding-top: var(--ui-spacing-md);
      border-top: 1px solid var(--border-subtle);
    }

    .custom-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ui-spacing-md);
    }

    .custom-title {
      margin: 0;
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .custom-voices code {
      font-family: var(--font-mono, monospace);
      font-size: 0.9em;
      padding: 1px 4px;
      background: var(--bg-elevated);
      border-radius: 3px;
    }

    .help-text {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);

      p { margin: 0; }
    }
  `],
})
export class VoicesPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);

  /** Only the downloadable TTS voices (kind 'tts-model'). */
  readonly voices = computed(() =>
    this.svc.components().filter((s) => s.component.kind === 'tts-model'),
  );

  // User-added custom voices (own fine-tuned XTTS checkpoints).
  readonly customVoices = signal<CustomVoice[]>([]);
  readonly customBusy = signal(false);
  readonly customError = signal<string | null>(null);

  private get customApi() {
    return (window as unknown as { electron?: { customVoices?: {
      list: () => Promise<{ success: boolean; data?: CustomVoice[]; error?: string }>;
      add: () => Promise<{ success: boolean; voice?: CustomVoice; canceled?: boolean; error?: string }>;
      remove: (id: string) => Promise<{ success: boolean; error?: string }>;
    } } }).electron?.customVoices;
  }

  ngOnInit(): void {
    this.svc.ensureLoaded();
    void this.loadCustomVoices();
  }

  async loadCustomVoices(): Promise<void> {
    const api = this.customApi;
    if (!api) return;
    const res = await api.list();
    if (res.success && res.data) this.customVoices.set(res.data);
  }

  async addCustomVoice(): Promise<void> {
    const api = this.customApi;
    if (!api) return;
    this.customError.set(null);
    this.customBusy.set(true);
    try {
      const res = await api.add();
      if (res.canceled) return;
      if (res.success) {
        await this.loadCustomVoices();
      } else {
        this.customError.set(res.error || 'Could not add that voice folder.');
      }
    } finally {
      this.customBusy.set(false);
    }
  }

  async removeCustomVoice(id: string): Promise<void> {
    const api = this.customApi;
    if (!api) return;
    await api.remove(id);
    await this.loadCustomVoices();
  }

  badgeClass(status: ComponentStatus): string {
    switch (status.state) {
      case 'installed': return 'installed';
      case 'installing': return 'installing';
      default: return 'available';
    }
  }

  badgeLabel(status: ComponentStatus): string {
    switch (status.state) {
      case 'installed': return 'Installed';
      case 'installing': return 'Downloading';
      default: return 'Available';
    }
  }

  phaseLabel(phase: string): string {
    switch (phase) {
      case 'resolve': return 'Preparing…';
      case 'download': return 'Downloading…';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      default: return 'Downloading…';
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

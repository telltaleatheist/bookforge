import { Component, inject, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { ComponentStatus } from '../../../core/services/electron.service';

/**
 * Settings → Languages.
 *
 * Each language is a managed `language-pack` component — a Stanza
 * sentence-segmentation model used to split text into sentences for AI cleanup
 * and translation. A handful of common languages ship bundled (en/de/es/ko) and
 * report as Installed; the rest download on demand. This panel reuses the whole
 * component backend (ComponentService + IPC + progress) — it just filters to
 * language packs and renders Download / Cancel / Remove like a managed voice.
 */
@Component({
  selector: 'app-languages-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="languages-section">
      @if (svc.profile(); as p) {
        <div class="system-info">
          <span class="sys-item">{{ formatBytes(p.freeDiskMB * 1024 * 1024) }} free disk</span>
        </div>
      }

      @if (svc.error(); as err) {
        <div class="status-message error">{{ err }}</div>
      }

      @if (svc.loading() && languages().length === 0) {
        <p class="loading-hint">Loading languages…</p>
      }

      <div class="component-list">
        @for (status of languages(); track status.component.id) {
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
                  <desktop-button
                    variant="ghost"
                    size="sm"
                    (click)="svc.remove(status.component.id)"
                    [disabled]="svc.isBusy(status.component.id)"
                  >
                    Remove
                  </desktop-button>
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

      <div class="section-actions">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
      </div>

      <div class="help-text">
        <p>
          These are sentence-segmentation models needed to clean and translate text in each
          language. A few common ones (English, German, Spanish, Korean) ship bundled and show
          as <strong>Installed</strong>; download any other language with one click. Downloads
          run in the background; you can keep working.
        </p>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .languages-section {
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
      /* ~70 languages — keep the list scrollable so it doesn't blow out the page. */
      max-height: 480px;
      overflow-y: auto;
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

    .help-text {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);

      p { margin: 0; }
    }
  `],
})
export class LanguagesPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);

  /**
   * Only the downloadable language packs (kind 'language-pack'), sorted so
   * installed languages appear first, then alphabetically by name.
   */
  readonly languages = computed(() =>
    this.svc.components()
      .filter((s) => s.component.kind === 'language-pack')
      .slice()
      .sort((a, b) => {
        const aInstalled = a.state === 'installed' ? 0 : 1;
        const bInstalled = b.state === 'installed' ? 0 : 1;
        if (aInstalled !== bInstalled) return aInstalled - bInstalled;
        return a.component.name.localeCompare(b.component.name);
      }),
  );

  ngOnInit(): void {
    this.svc.ensureLoaded();
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

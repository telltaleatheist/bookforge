import { Component, inject, computed, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';

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
      <div class="toolbar">
        <input
          type="text"
          class="filter-input"
          placeholder="Search languages…"
          [value]="filter()"
          (input)="filter.set($any($event.target).value)"
        />
        @if (svc.profile(); as p) {
          <span class="free-disk">{{ formatBytes(p.freeDiskMB * 1024 * 1024) }} free</span>
        }
      </div>

      @if (svc.error(); as err) {
        <div class="status-message error">{{ err }}</div>
      }
      @if (svc.loading() && languages().length === 0) {
        <p class="loading-hint">Loading languages…</p>
      }

      <div class="lang-scroll">
        @if (installedLangs().length > 0) {
          <div class="group">
            <div class="group-head">Installed <span class="group-count">{{ installedLangs().length }}</span></div>
            @for (status of installedLangs(); track status.component.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: status }"></ng-container>
            }
          </div>
        }

        <div class="group">
          <div class="group-head">Available <span class="group-count">{{ availableLangs().length }}</span></div>
          @if (availableLangs().length === 0 && filter()) {
            <p class="empty-hint">No languages match “{{ filter() }}”.</p>
          }
          @for (status of availableLangs(); track status.component.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: status }"></ng-container>
          }
        </div>
      </div>

      <ng-template #row let-status>
        <div class="lang-row" [class.is-installed]="status.state === 'installed'">
          <span class="lr-name" [title]="status.component.name">{{ status.component.name }}</span>

          @if (status.state === 'installing' && status.progress; as prog) {
            <div class="lr-progress"><div class="lr-bar" [style.width.%]="prog.pct || 0"></div></div>
            <span class="lr-pct">{{ prog.pct || 0 }}%</span>
            <button class="lr-btn ghost" (click)="svc.cancel(status.component.id)" title="Cancel">✕</button>
          } @else if (status.state === 'installed') {
            <span class="lr-ready">✓</span>
            <button
              class="lr-btn ghost"
              (click)="svc.remove(status.component.id)"
              [disabled]="svc.isBusy(status.component.id)"
              title="Remove"
            >Remove</button>
          } @else {
            <span class="lr-size">{{ formatBytes(status.component.sizeBytes) }}</span>
            <button
              class="lr-btn primary"
              (click)="svc.install(status.component.id)"
              [disabled]="svc.isBusy(status.component.id)"
            >Get</button>
          }
        </div>
      </ng-template>

      <div class="footer">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
        <span class="help-text">
          Sentence-segmentation models for cleanup &amp; translation. Common languages ship bundled; download more anytime.
        </span>
        <span class="spacer"></span>
        @if (removableLangs().length > 0) {
          @if (confirmDeleteAll()) {
            <span class="danger-confirm">
              Delete {{ removableLangs().length }} language{{ removableLangs().length === 1 ? '' : 's' }}? (keeps English)
              <button class="lr-btn danger" (click)="deleteAllLanguages()">Delete</button>
              <button class="lr-btn ghost" (click)="confirmDeleteAll.set(false)">Cancel</button>
            </span>
          } @else {
            <button class="lr-btn ghost danger-text" (click)="confirmDeleteAll.set(true)">Delete all downloads</button>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .languages-section { display: flex; flex-direction: column; gap: var(--ui-spacing-md); }

    .toolbar { display: flex; align-items: center; gap: var(--ui-spacing-md); }

    .filter-input {
      flex: 1; min-width: 0;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-input, var(--bg-elevated));
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      &::placeholder { color: var(--text-tertiary); }
      &:focus { outline: none; border-color: var(--accent); }
    }

    .free-disk { flex-shrink: 0; font-size: var(--ui-font-xs); color: var(--text-tertiary); white-space: nowrap; }

    .loading-hint, .empty-hint { color: var(--text-tertiary); font-size: var(--ui-font-sm); padding: var(--ui-spacing-sm) 0; margin: 0; }

    /* ~70 languages — keep scrollable so it doesn't blow out the page. */
    .lang-scroll { display: flex; flex-direction: column; max-height: 460px; overflow-y: auto; }

    .group { display: flex; flex-direction: column; }

    .group-head {
      display: flex; align-items: center; gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) 0 var(--ui-spacing-xs);
      font-size: var(--ui-font-xs); font-weight: $font-weight-semibold;
      text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary);
      position: sticky; top: 0; background: var(--bg-surface); z-index: 1;
    }
    .group-count {
      font-weight: $font-weight-regular; color: var(--text-tertiary);
      background: var(--bg-elevated); border-radius: 10px; padding: 0 7px;
    }

    .lang-row {
      display: flex; align-items: center; gap: var(--ui-spacing-md);
      padding: 6px var(--ui-spacing-sm);
      border-bottom: 1px solid var(--border-subtle);
      min-height: 32px;
      &:hover { background: var(--bg-elevated); }
      &:last-child { border-bottom: none; }
    }

    .lr-name {
      flex: 1; min-width: 0; font-size: var(--ui-font-sm); color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .lr-size { font-size: var(--ui-font-xs); color: var(--text-tertiary); white-space: nowrap; }
    .lr-ready { font-size: var(--ui-font-sm); color: var(--success); }

    .lr-progress { flex: 0 0 80px; height: 5px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .lr-bar { height: 100%; background: var(--accent); transition: width $duration-fast $ease-out; }
    .lr-pct { font-size: var(--ui-font-xs); color: var(--text-secondary); min-width: 34px; text-align: right; }

    .lr-btn {
      flex-shrink: 0; font-size: var(--ui-font-xs); font-weight: $font-weight-medium;
      padding: 3px 12px; border-radius: $radius-sm; border: 1px solid transparent; cursor: pointer;
      &.primary { background: var(--accent); color: #fff; }
      &.primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent)); }
      &.primary:disabled { opacity: 0.5; cursor: default; }
      &.ghost { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
      &.ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
      &.danger { background: var(--error, #d9534f); color: #fff; }
      &.danger:hover { filter: brightness(1.08); }
    }

    .footer {
      display: flex; align-items: center; gap: var(--ui-spacing-md);
      padding-top: var(--ui-spacing-sm); border-top: 1px solid var(--border-subtle);
    }
    .footer .spacer { flex: 1; }

    .danger-text { color: var(--error, #d9534f) !important; border-color: transparent !important; }
    .danger-text:hover { text-decoration: underline; }
    .danger-confirm {
      display: inline-flex; align-items: center; gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-xs); color: var(--text-secondary);
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md); border-radius: $radius-md; font-size: var(--ui-font-sm);
      &.error { background: var(--error-bg); color: var(--error); }
    }

    .help-text { font-size: var(--ui-font-xs); color: var(--text-tertiary); margin: 0; }
  `],
})
export class LanguagesPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);

  /** Filter text for the language list. */
  readonly filter = signal('');

  /** All downloadable language packs (kind 'language-pack'). */
  readonly languages = computed(() =>
    this.svc.components().filter((s) => s.component.kind === 'language-pack'),
  );

  /** Name-filtered packs. */
  private readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.languages();
    if (!q) return list;
    return list.filter((s) => s.component.name.toLowerCase().includes(q));
  });

  readonly installedLangs = computed(() =>
    this.filtered()
      .filter((s) => s.state === 'installed')
      .slice()
      .sort((a, b) => a.component.name.localeCompare(b.component.name)),
  );

  readonly availableLangs = computed(() =>
    this.filtered()
      .filter((s) => s.state !== 'installed')
      .slice()
      .sort((a, b) => a.component.name.localeCompare(b.component.name)),
  );

  /** Downloaded language packs that "delete all" would remove (keeps bundled English). */
  readonly removableLangs = computed(() =>
    this.languages().filter((s) => s.state === 'installed' && s.component.id !== 'stanza-en'),
  );

  readonly confirmDeleteAll = signal(false);

  /** Remove every downloaded language pack except bundled English. */
  deleteAllLanguages(): void {
    for (const s of this.removableLangs()) {
      void this.svc.remove(s.component.id);
    }
    this.confirmDeleteAll.set(false);
  }

  ngOnInit(): void {
    this.svc.ensureLoaded();
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

import { Component, inject, input, computed, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { SetupDownloadService } from '../../../core/services/setup-download.service';

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

      @if (selectionMode() && selectableLangIds().length > 0) {
        <div class="select-all-bar">
          <button type="button" class="select-all-btn" (click)="toggleSelectAll()">
            {{ sel.allSelectedAmong(selectableLangIds()) ? 'Deselect all' : 'Select all' }}
          </button>
          <span class="select-all-count">{{ selectedHereCount() }} of {{ selectableLangIds().length }} selected</span>
        </div>
      }

      <div class="lang-scroll" [class.no-cap]="selectionMode()">
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
        <div
          class="lang-row"
          [class.is-installed]="status.state === 'installed'"
          [class.selectable]="selectionMode() && status.state !== 'installed'"
          [class.selected]="selectionMode() && status.state !== 'installed' && sel.isSelected(status.component.id)"
          (click)="rowClick(status)"
        >
          <span class="lr-name" [title]="status.component.name">{{ status.component.name }}</span>

          @if (selectionMode()) {
            @if (status.state === 'installed') {
              <span class="lr-ready" title="Already installed">✓ Installed</span>
            } @else {
              <span class="lr-size">{{ formatBytes(status.component.sizeBytes) }}</span>
              @if (sel.isSelected(status.component.id)) {
                <span class="lr-pick" aria-hidden="true">✓</span>
              }
            }
          } @else if (status.state === 'installing' && status.progress; as prog) {
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

      @if (!selectionMode()) {
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
      }
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

    /* ~70 languages — keep scrollable so it doesn't blow out the page.
       scrollbar-gutter + right padding so the scrollbar never sits over the
       checkboxes/controls at the row's right edge. */
    .lang-scroll {
      display: flex; flex-direction: column; max-height: 460px; overflow-y: auto;
      scrollbar-gutter: stable;
      padding-right: var(--ui-spacing-sm);
    }
    /* In first-run setup the panel sits inside the setup card's own scroll area
       (.step-body). The 460px cap there left the list filling only half the panel
       with a redundant inner scrollbar — let it grow to fill and let the card
       scroll instead. */
    .lang-scroll.no-cap { max-height: none; overflow-y: visible; }
    /* In first-run setup the panel scrolls with the card (no inner scroll), so a
       sticky group header would float mid-card on top of the rows. Pin it inline. */
    .lang-scroll.no-cap .group-head { position: static; }

    .select-all-bar {
      display: flex; align-items: center; gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xs) 0;
    }
    .select-all-btn {
      font-size: var(--ui-font-xs); font-weight: $font-weight-medium;
      padding: 3px 12px; border-radius: $radius-sm;
      border: 1px solid var(--border-default); background: transparent;
      color: var(--text-secondary); cursor: pointer;
      &:hover { color: var(--text-primary); border-color: var(--text-secondary); }
    }
    .select-all-count { font-size: var(--ui-font-xs); color: var(--text-tertiary); }

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
      /* Selection mode: each row is its own full box that lights up entirely when
         picked (like the pipeline's source-stage boxes) — the whole card toggles. */
      &.selectable {
        cursor: pointer;
        border: 1px solid var(--border-default);
        border-radius: 8px;
        margin-bottom: 6px;
        transition: all 0.12s ease;
      }
      &.selectable:hover { background: var(--bg-elevated); border-color: var(--text-tertiary); }
      &.selected, &.selected:hover {
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border-color: var(--accent);
      }
      &.selected .lr-name { color: var(--accent); font-weight: $font-weight-medium; }
    }

    .lr-name {
      flex: 1; min-width: 0; font-size: var(--ui-font-sm); color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .lr-size { font-size: var(--ui-font-xs); color: var(--text-tertiary); white-space: nowrap; }
    .lr-ready { font-size: var(--ui-font-sm); color: var(--success); }
    /* Selected indicator (whole box is the toggle — no checkbox). */
    .lr-pick { flex-shrink: 0; color: var(--accent); font-weight: 700; font-size: var(--ui-font-sm); }

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
  readonly sel = inject(SetupDownloadService);

  /** First-run selection mode: render checkboxes instead of Get/Remove and defer
   *  downloads to the batch runner. Settings uses the default (inline) mode. */
  readonly selectionMode = input(false);

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

  /** Not-yet-installed packs currently shown (respects the filter) — the targets
   *  of "Select all" and the whole-row toggle. */
  readonly selectableLangIds = computed(() =>
    this.availableLangs().map((s) => s.component.id),
  );

  /** How many of the selectable packs on this page are currently checked. */
  readonly selectedHereCount = computed(() =>
    this.selectableLangIds().filter((id) => this.sel.isSelected(id)).length,
  );

  /** Select-all / Deselect-all over the packs shown on this page. */
  toggleSelectAll(): void {
    const ids = this.selectableLangIds();
    if (this.sel.allSelectedAmong(ids)) this.sel.deselectMany(ids);
    else this.sel.selectMany(ids);
  }

  /** Whole-row click toggles selection (selection mode, not-installed only). */
  rowClick(status: { component: { id: string }; state: string }): void {
    if (!this.selectionMode() || status.state === 'installed') return;
    this.sel.toggle(status.component.id);
  }

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

import { Component, inject, input, computed, signal, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { SetupDownloadService } from '../../../core/services/setup-download.service';
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
 * — it just filters to voices and renders them as a compact, filterable list.
 * With 30+ voices a card-per-voice layout was unusable; rows + a search box +
 * group headers keep it scannable. Downloaded voices land in the app's data
 * folder (userData/runtime/e2a/models), not the library.
 */
@Component({
  selector: 'app-voices-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="voices-section">
      <div class="toolbar">
        <input
          type="text"
          class="filter-input"
          placeholder="Search voices…"
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
      @if (svc.loading() && voices().length === 0) {
        <div class="loading-state">
          <span class="spinner"></span>
          <span>Loading premium voices…</span>
        </div>
      }

      @if (selectionMode() && selectableVoiceIds().length > 0) {
        <div class="select-all-bar">
          <button type="button" class="select-all-btn" (click)="toggleSelectAll()">
            {{ sel.allSelectedAmong(selectableVoiceIds()) ? 'Deselect all' : 'Select all' }}
          </button>
          <span class="select-all-count">{{ selectedHereCount() }} of {{ selectableVoiceIds().length }} selected</span>
        </div>
      }

      <!-- While the catalog is still loading (empty), show ONLY the loading state
           above — never the "no voices match" empty group, which falsely implies
           there are none. -->
      @if (voices().length > 0 || !svc.loading()) {
        <!-- Default voice pack (base XTTS) — unlocks the stock voice + every
             reference-clip clone, so it's pinned at the top in its own group. -->
        @if (basePack(); as base) {
          <div class="group">
            <div class="group-head">Default</div>
            <ng-container *ngTemplateOutlet="row; context: { $implicit: base, isBase: true }"></ng-container>
          </div>
        }

        <!-- Premium fine-tuned voices -->
        <div class="group">
          <div class="group-head">
            Premium voices
            <span class="group-count">{{ filteredVoices().length }}</span>
          </div>
          <!-- Only when the user has actually typed a filter — never "No voices
               match ''" on an empty/loading list. -->
          @if (filteredVoices().length === 0 && filter()) {
            <p class="empty-hint">No voices match “{{ filter() }}”.</p>
          }
          @for (status of filteredVoices(); track status.component.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: status, isBase: false, isDefault: status.component.id === defaultVoiceId }"></ng-container>
          }
        </div>
      }

      <!-- One compact row, shared by the base pack + every voice. -->
      <ng-template #row let-status let-isBase="isBase" let-isDefault="isDefault">
        <div
          class="voice-row"
          [class.is-installed]="status.state === 'installed'"
          [class.selectable]="selectionMode() && status.state !== 'installed'"
          [class.selected]="selectionMode() && status.state !== 'installed' && sel.isSelected(status.component.id)"
          (click)="rowClick(status)"
        >
          <span class="vr-name" [title]="status.component.name">{{ status.component.name }}</span>

          @if (selectionMode()) {
            @if (status.state === 'installed') {
              <span class="vr-ready" title="Already installed">✓ Installed</span>
            } @else {
              <span class="vr-size">{{ isBase ? '~1.9 GB' : '1.7 GB' }}</span>
              @if (sel.isSelected(status.component.id)) {
                <span class="vr-pick" aria-hidden="true">✓</span>
              }
            }
          } @else if (status.state === 'installing' && status.progress; as prog) {
            <div class="vr-progress">
              <div class="vr-bar" [style.width.%]="prog.pct || 0"></div>
            </div>
            <span class="vr-pct">{{ prog.pct || 0 }}%</span>
            <button class="vr-btn ghost" (click)="svc.cancel(status.component.id)" title="Cancel">✕</button>
          } @else if (status.state === 'installed') {
            @if (isDefault) {
              <!-- The bundled default voice is mandatory — show it as installed
                   but offer no Remove (deleting it would break the default). -->
              <span class="vr-ready" title="Bundled default voice — always available">✓ Default</span>
            } @else {
              <span class="vr-ready" title="Installed">✓</span>
              <button
                class="vr-btn ghost"
                (click)="svc.remove(status.component.id)"
                [disabled]="svc.isBusy(status.component.id)"
                title="Remove download"
              >Remove</button>
            }
          } @else {
            <span class="vr-size">{{ isBase ? '~1.9 GB' : '1.7 GB' }}</span>
            <button
              class="vr-btn primary"
              (click)="svc.install(status.component.id)"
              [disabled]="svc.isBusy(status.component.id)"
            >Get</button>
          }
        </div>
      </ng-template>

      @if (!selectionMode()) {
      <!-- User-added custom voices (own fine-tuned XTTS checkpoints) -->
      <div class="group custom-voices">
        <div class="group-head">
          Your voices
          <desktop-button variant="ghost" size="sm" (click)="addCustomVoice()" [disabled]="customBusy()">
            {{ customBusy() ? 'Adding…' : 'Add your own…' }}
          </desktop-button>
        </div>

        @if (customError(); as err) {
          <div class="status-message error">{{ err }}</div>
        }

        @if (customVoices().length > 0) {
          @for (cv of customVoices(); track cv.id) {
            <div class="voice-row is-installed">
              <span class="vr-name" [title]="cv.checkpointDir">{{ cv.name }}</span>
              <span class="vr-ready">✓ Ready</span>
              <button class="vr-btn ghost" (click)="removeCustomVoice(cv.id)" title="Remove">Remove</button>
            </div>
          }
        } @else {
          <p class="help-text">
            Have your own fine-tuned XTTS voice? Add the folder with
            <code>config.json</code>, <code>model.pth</code>, <code>vocab.json</code> and a
            reference <code>.wav</code>.
          </p>
        }
      </div>

      <div class="footer">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
        <span class="help-text">Downloads run in the background and survive updates.</span>
        <span class="spacer"></span>
        @if (removableVoices().length > 0) {
          @if (confirmDeleteAll()) {
            <span class="danger-confirm">
              Delete {{ removableVoices().length }} downloaded voice{{ removableVoices().length === 1 ? '' : 's' }}? (keeps Scarlett Johansson)
              <button class="vr-btn danger" (click)="deleteAllVoices()">Delete</button>
              <button class="vr-btn ghost" (click)="confirmDeleteAll.set(false)">Cancel</button>
            </span>
          } @else {
            <button class="vr-btn ghost danger-text" (click)="confirmDeleteAll.set(true)">Delete all downloads</button>
          }
        }
      </div>
      }
    </div>
  `,
  styles: [`
    @use '../../../creamsicle-desktop/styles/variables' as *;

    .voices-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
    }

    .filter-input {
      flex: 1;
      min-width: 0;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-input, var(--bg-elevated));
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);

      &::placeholder { color: var(--text-tertiary); }
      &:focus { outline: none; border-color: var(--accent); }
    }

    .free-disk {
      flex-shrink: 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      white-space: nowrap;
    }

    .loading-hint, .empty-hint {
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
      padding: var(--ui-spacing-sm) 0;
      margin: 0;
    }

    /* Prominent loading state — shown while the catalog loads so the page never
       reads as "no voices" before the list arrives. */
    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-sm);
      padding: 28px 0;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
    }
    .spinner {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: vp-spin 0.8s linear infinite;
    }
    @keyframes vp-spin { to { transform: rotate(360deg); } }

    .group {
      display: flex;
      flex-direction: column;
    }

    .group-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) 0 var(--ui-spacing-xs);
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-tertiary);
    }

    .group-count {
      font-weight: $font-weight-regular;
      color: var(--text-tertiary);
      background: var(--bg-elevated);
      border-radius: 10px;
      padding: 0 7px;
    }

    /* Compact row — the whole point of this redesign. */
    .voice-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: 7px var(--ui-spacing-sm);
      border-bottom: 1px solid var(--border-subtle);
      min-height: 34px;

      &:hover { background: var(--bg-elevated); }
      &:last-child { border-bottom: none; }
      /* Selection mode: each row is its own full box that lights up entirely when
         picked (like the pipeline's source-stage boxes), so the whole card is the
         toggle — no separate checkbox. */
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
      &.selected .vr-name { color: var(--accent); font-weight: $font-weight-medium; }
    }

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

    .vr-name {
      flex: 1;
      min-width: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .vr-size {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      white-space: nowrap;
    }

    .vr-ready {
      font-size: var(--ui-font-xs);
      color: var(--success);
      white-space: nowrap;
    }

    /* Selected indicator (whole box is the toggle — no checkbox). */
    .vr-pick { flex-shrink: 0; color: var(--accent); font-weight: 700; font-size: var(--ui-font-sm); }

    .vr-progress {
      flex: 0 0 80px;
      height: 5px;
      background: var(--bg-elevated);
      border-radius: 3px;
      overflow: hidden;
    }
    .vr-bar {
      height: 100%;
      background: var(--accent);
      transition: width $duration-fast $ease-out;
    }
    .vr-pct {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      min-width: 34px;
      text-align: right;
    }

    .vr-btn {
      flex-shrink: 0;
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-medium;
      padding: 3px 12px;
      border-radius: $radius-sm;
      border: 1px solid transparent;
      cursor: pointer;

      &.primary { background: var(--accent); color: #fff; }
      &.primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent)); }
      &.primary:disabled { opacity: 0.5; cursor: default; }
      &.ghost { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
      &.ghost:hover { color: var(--text-primary); border-color: var(--text-secondary); }
      &.danger { background: var(--error, #d9534f); color: #fff; }
      &.danger:hover { filter: brightness(1.08); }
    }

    .custom-voices { padding-top: var(--ui-spacing-sm); }

    .footer {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding-top: var(--ui-spacing-sm);
      border-top: 1px solid var(--border-subtle);
    }
    .footer .spacer { flex: 1; }

    .danger-text {
      color: var(--error, #d9534f) !important;
      border-color: transparent !important;
    }
    .danger-text:hover { text-decoration: underline; }

    .danger-confirm {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);
      &.error { background: var(--error-bg); color: var(--error); }
    }

    .help-text {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      margin: 0;

      code {
        font-family: var(--font-mono, monospace);
        font-size: 0.9em;
        padding: 1px 4px;
        background: var(--bg-elevated);
        border-radius: 3px;
      }
    }
  `],
})
export class VoicesPanelComponent implements OnInit {
  readonly svc = inject(ComponentService);
  readonly sel = inject(SetupDownloadService);

  /** First-run selection mode: render checkboxes instead of Get/Remove and defer
   *  downloads to the batch runner. Settings uses the default (inline) mode. */
  readonly selectionMode = input(false);

  /** Filter text for the premium-voice list. */
  readonly filter = signal('');

  /** All downloadable TTS voices (kind 'tts-model'). */
  readonly voices = computed(() =>
    this.svc.components().filter((s) => s.component.kind === 'tts-model'),
  );

  /** The base XTTS pack ('xtts-base'), pinned in its own group. */
  readonly basePack = computed(() =>
    this.voices().find((s) => s.component.id === 'xtts-base') ?? null,
  );

  /** The bundled default voice (Scarlett). It lives in the component registry so
   *  it's detectable + appears in the narration picker, but it's auto-installed,
   *  not a manual download — so first-run selection mode hides it from the
   *  optional list. Settings still shows it (as installed) for transparency. */
  private static readonly DEFAULT_VOICE_ID = 'ScarlettJohansson';
  /** Same id, exposed for the row template's default-voice special-casing. */
  readonly defaultVoiceId = VoicesPanelComponent.DEFAULT_VOICE_ID;

  /** Premium fine-tuned voices (everything except the base), name-filtered.
   *  In first-run selection mode the auto-installed default voice is hidden — it
   *  isn't an optional pick. In Settings it stays visible (shown as installed). */
  readonly filteredVoices = computed(() => {
    const q = this.filter().trim().toLowerCase();
    let list = this.voices().filter((s) => s.component.id !== 'xtts-base');
    if (this.selectionMode()) {
      list = list.filter((s) => s.component.id !== VoicesPanelComponent.DEFAULT_VOICE_ID);
    }
    if (!q) return list;
    return list.filter((s) => s.component.name.toLowerCase().includes(q));
  });

  /** Not-yet-installed voices currently shown (base + filtered premium) — the
   *  targets of "Select all" and the whole-row toggle. */
  readonly selectableVoiceIds = computed(() => {
    const ids: string[] = [];
    const base = this.basePack();
    if (base && base.state !== 'installed') ids.push(base.component.id);
    for (const s of this.filteredVoices()) {
      if (s.state !== 'installed') ids.push(s.component.id);
    }
    return ids;
  });

  /** How many of the selectable voices on this page are currently checked. */
  readonly selectedHereCount = computed(() =>
    this.selectableVoiceIds().filter((id) => this.sel.isSelected(id)).length,
  );

  /** Select-all / Deselect-all over the voices shown on this page. */
  toggleSelectAll(): void {
    const ids = this.selectableVoiceIds();
    if (this.sel.allSelectedAmong(ids)) this.sel.deselectMany(ids);
    else this.sel.selectMany(ids);
  }

  /** Whole-row click toggles selection (selection mode, not-installed only). */
  rowClick(status: { component: { id: string }; state: string }): void {
    if (!this.selectionMode() || status.state === 'installed') return;
    this.sel.toggle(status.component.id);
  }

  // Bare-bones voices that ship bundled and must survive a "delete all".
  private static readonly KEEP_VOICE_IDS = ['ScarlettJohansson', 'xtts-base'];

  /** Downloaded voices that "delete all" would remove (excludes the bundled core). */
  readonly removableVoices = computed(() =>
    this.voices().filter(
      (s) => s.state === 'installed' && !VoicesPanelComponent.KEEP_VOICE_IDS.includes(s.component.id),
    ),
  );

  readonly confirmDeleteAll = signal(false);

  /** Remove every downloaded voice except the bundled Scarlett + base. */
  deleteAllVoices(): void {
    for (const s of this.removableVoices()) {
      void this.svc.remove(s.component.id);
    }
    this.confirmDeleteAll.set(false);
  }

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

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

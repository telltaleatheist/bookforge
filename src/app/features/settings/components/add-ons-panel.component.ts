import { Component, inject, input, computed, signal, effect, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ComponentService } from '../../../core/services/component.service';
import { SetupDownloadService } from '../../../core/services/setup-download.service';
import { ComponentStatus, OptionalComponent, EnvDiagnosticResult } from '../../../core/services/electron.service';

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

      @if (selectionMode() && selectableAddOnIds().length > 0) {
        <div class="select-all-bar">
          <button type="button" class="select-all-btn" (click)="toggleSelectAll()">
            {{ sel.allSelectedAmong(selectableAddOnIds()) ? 'Deselect all' : 'Select all' }}
          </button>
          <span class="select-all-count">{{ selectedHereCount() }} of {{ selectableAddOnIds().length }} selected</span>
        </div>
      }

      <div class="component-list">
        @for (status of addOns(); track status.component.id) {
          <div
            class="component-card"
            [class.incompatible]="status.state === 'incompatible'"
            [class.selectable]="selectionMode() && isDownloadable(status.component) && status.state !== 'installed'"
            [class.selected]="selectionMode() && isDownloadable(status.component) && sel.isSelected(status.component.id)"
            (click)="onCardSelectClick(status)"
          >
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

            <!-- Detected-GPU explainer for the CUDA acceleration packs -->
            @if (isCudaPack(status.component.id) && status.state !== 'incompatible' && gpuName(); as gpu) {
              <div class="gpu-explainer">
                <span class="gpu-spark">⚡</span>
                We found your <strong>{{ gpu }}</strong> —
                {{ status.component.id === 'cuda-tts'
                   ? 'add GPU acceleration to generate audiobook narration much faster.'
                   : 'add GPU acceleration to run on-device AI cleanup much faster.' }}
              </div>
            }

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

            <!-- Resolved entry path: settings only (hidden during first-run setup to
                 declutter), shown compact + truncated with the full path on hover. -->
            @if (status.state === 'installed' && status.installed?.entryPath && !selectionMode()) {
              <code class="entry-path" [title]="status.installed?.entryPath ?? ''">{{ status.installed?.entryPath }}</code>
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
                  @if (selectionMode()) {
                    <span class="action-note installed-note">Installed ✓</span>
                  } @else {
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      (click)="svc.remove(status.component.id)"
                      [disabled]="svc.isBusy(status.component.id)"
                    >
                      {{ status.installed?.source === 'managed' ? 'Uninstall' : 'Remove' }}
                    </desktop-button>
                  }
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
                    @if (svc.hasInstaller(status.component.id)) {
                      <desktop-button
                        variant="primary"
                        size="sm"
                        (click)="svc.runInstaller(status.component.id)"
                        [disabled]="svc.isBusy(status.component.id)"
                      >
                        {{ svc.isBusy(status.component.id) ? 'Downloading…' : 'Download & Install' }}
                      </desktop-button>
                    }
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      (click)="startLocate(status.component.id)"
                      [disabled]="svc.isBusy(status.component.id)"
                    >
                      {{ svc.isBusy(status.component.id) ? 'Searching…' : 'Locate…' }}
                    </desktop-button>
                    <!-- Only fall back to "how to install" when we can't fetch it. -->
                    @if (status.component.externalHelpUrl && !svc.hasInstaller(status.component.id)) {
                      <a class="help-link" href="#" (click)="openHelp($event, status.component.externalHelpUrl!)">
                        How to install
                      </a>
                    }
                  }
                  @if (isManaged(status.component)) {
                    @if (selectionMode()) {
                      @if (isDownloadable(status.component)) {
                        <span class="select-check">
                          @if (sel.isSelected(status.component.id)) {
                            <span class="sc-pick" aria-hidden="true">✓</span> Added
                          } @else {
                            Add to downloads
                          }
                        </span>
                      }
                    } @else {
                      <desktop-button
                        variant="primary"
                        size="sm"
                        (click)="svc.install(status.component.id)"
                        [disabled]="svc.isBusy(status.component.id)"
                      >
                        Install
                      </desktop-button>
                    }
                  }
                  @if (status.state === 'error' && !canLocate(status.component) && !isManaged(status.component)) {
                    <span class="action-note">Unavailable</span>
                  }
                }
              }
            </div>

            <!-- Test environment: verify a pointed-to engine env is complete + functional. -->
            @if (canTestEnv(status.component) && status.state === 'installed') {
              <div class="test-env">
                <desktop-button
                  variant="ghost" size="sm"
                  (click)="runEnvTest(status.component.id)"
                  [disabled]="envTesting(status.component.id)"
                >{{ envTesting(status.component.id) ? 'Testing…' : 'Test environment' }}</desktop-button>
                @if (envResult(status.component.id); as r) {
                  @if (r.error) {
                    <p class="test-env-error">⚠ {{ r.error }}</p>
                  } @else {
                    <ul class="test-env-checks">
                      @for (chk of r.checks; track chk.name) {
                        <li class="tec tec-{{ chk.status }}">
                          <span class="tec-icon">{{ chk.status === 'ok' ? '✓' : (chk.status === 'warn' ? '!' : '✕') }}</span>
                          <span class="tec-name">{{ chk.name }}</span>
                          <span class="tec-detail">{{ chk.detail }}</span>
                          @if (chk.hint && chk.status !== 'ok') {
                            <span class="tec-hint">{{ chk.hint }}</span>
                          }
                        </li>
                      }
                    </ul>
                  }
                }
              </div>
            }

            <!-- Inline manual-locate form: shown after auto-detect found nothing. -->
            @if (showManual(status.component.id)) {
              <div class="locate-manual">
                <p class="locate-msg">
                  Couldn’t find {{ status.component.name }} in the usual places. Enter the full path to
                  its program, or browse for it (handy if you keep a specific version).
                </p>
                <div class="locate-row">
                  <input
                    type="text"
                    class="locate-input"
                    [value]="manualPath(status.component.id)"
                    (input)="onManualInput(status.component.id, $event)"
                    [placeholder]="locatePlaceholder(status.component)"
                  />
                  <desktop-button
                    variant="primary" size="sm"
                    (click)="useManual(status.component.id)"
                    [disabled]="svc.isBusy(status.component.id) || !manualPath(status.component.id).trim()"
                  >Use this path</desktop-button>
                </div>
                <div class="locate-row">
                  <desktop-button
                    variant="ghost" size="sm"
                    (click)="browseFor(status.component.id)"
                    [disabled]="svc.isBusy(status.component.id)"
                  >Browse…</desktop-button>
                  <button type="button" class="link-btn" (click)="closeManual(status.component.id)">Cancel</button>
                </div>
              </div>
            }
          </div>
        }
      </div>

      <!-- RVC engine + enhancement voices moved to their own Settings → Voice
           Enhancement screen (app-rvc-enhancement-panel). -->


      @if (!selectionMode()) {
      <div class="section-actions">
        <desktop-button variant="ghost" size="sm" (click)="svc.refresh()" [disabled]="svc.loading()">
          Refresh
        </desktop-button>
        <span class="spacer"></span>
        @if (removableAddOns().length > 0) {
          @if (confirmDeleteAll()) {
            <span class="danger-confirm">
              Remove {{ removableAddOns().length }} downloaded add-on{{ removableAddOns().length === 1 ? '' : 's' }}?
              <button class="mini-btn danger" (click)="deleteAllAddOns()">Remove</button>
              <button class="mini-btn ghost" (click)="confirmDeleteAll.set(false)">Cancel</button>
            </span>
          } @else {
            <button class="mini-btn danger-text" (click)="confirmDeleteAll.set(true)">Delete all downloads</button>
          }
        }
      </div>

      <div class="help-text">
        <p>
          BookForge ships a small core and fetches heavy or platform-specific pieces on demand.
          Components you already installed yourself are auto-detected and shown as <strong>Installed</strong>.
          Use <strong>Locate…</strong> to point at one BookForge could not find.
        </p>
      </div>
      }
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
      /* Selection mode: the whole card is the toggle and lights up entirely when
         picked (matches the voices/languages/pipeline boxes). */
      &.selectable { cursor: pointer; transition: all 0.12s ease; }
      &.selectable:hover { border-color: var(--text-tertiary); }
      &.selected, &.selected:hover {
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        border-color: var(--accent);
      }
      &.selected .component-name { color: var(--accent); }
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

    /* Compact, single-line, truncated — full path on hover (title). No "Found at"
       label and not shown in setup, so it never clutters the card. */
    .entry-path {
      display: block;
      max-width: 100%;
      font-family: monospace;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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

      &.installed-note { color: var(--success); }
    }

    /* Label only — the whole card is the click target, so this is non-interactive. */
    .select-check {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      pointer-events: none;
    }
    .sc-pick { color: var(--accent); font-weight: 700; }

    .help-link {
      font-size: var(--ui-font-sm);
      color: var(--accent);
      text-decoration: none;

      &:hover { text-decoration: underline; }
    }

    .locate-manual {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
    }
    .locate-msg { margin: 0; font-size: var(--ui-font-sm); color: var(--text-secondary); }
    .locate-row { display: flex; align-items: center; gap: var(--ui-spacing-sm); }
    .locate-input {
      flex: 1; min-width: 0;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-input, var(--bg-sunken));
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      font-family: var(--font-mono, monospace);
      &::placeholder { color: var(--text-tertiary); font-family: inherit; }
      &:focus { outline: none; border-color: var(--accent); }
    }
    .link-btn {
      background: none; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: var(--ui-font-sm);
      &:hover { color: var(--text-primary); text-decoration: underline; }
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.error { background: var(--error-bg); color: var(--error); }
    }

    /* Plain explainer line — NOT a colored box-in-a-box (the card itself carries
       the selected/colored state). Keeps the card from looking cluttered. */
    .gpu-explainer {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: 0;
      background: transparent;
      border: none;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);

      strong { color: var(--text-primary); }
    }
    .gpu-spark { flex-shrink: 0; }

    .section-actions {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding-top: var(--ui-spacing-sm);

      .spacer { flex: 1; }
    }

    .mini-btn {
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-medium;
      padding: 3px 12px;
      border-radius: $radius-sm;
      border: 1px solid transparent;
      cursor: pointer;

      &.ghost { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
      &.ghost:hover { color: var(--text-primary); border-color: var(--text-secondary); }
      &.danger { background: var(--error, #d9534f); color: #fff; }
      &.danger:hover { filter: brightness(1.08); }
    }

    .danger-text {
      background: transparent;
      color: var(--error, #d9534f);
      border-color: transparent;
    }
    .danger-text:hover { text-decoration: underline; }

    .danger-confirm {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
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
  readonly sel = inject(SetupDownloadService);

  /** First-run selection mode: downloadable add-ons (CUDA) become checkboxes for
   *  the batch runner; external tools keep Locate. Settings uses inline mode. */
  readonly selectionMode = input(false);

  /** When true, show ONLY the GPU/CUDA acceleration packs (for embedding in the
   *  TTS Server settings, where the device choice lives). */
  readonly onlyGpu = input(false);

  /** Tools/runtimes only — TTS voices and language packs live in their own panels.
   *  With onlyGpu, narrow further to the CUDA acceleration packs. */
  readonly addOns = computed(() =>
    this.svc.components().filter(
      s => s.component.kind !== 'tts-model' && s.component.kind !== 'language-pack' &&
        // The RVC engine + its CUDA overlay live on the dedicated Voice Enhancement
        // screen, not in this general hub.
        s.component.id !== 'rvc-env' && s.component.id !== 'cuda-rvc' &&
        (!this.onlyGpu() || this.isCudaPack(s.component.id)),
    ),
  );

  /** Components offering managed (download) acquisition. */
  readonly managedIds = computed(() =>
    new Set(this.svc.components()
      .filter(c => c.component.acquisition.includes('managed'))
      .map(c => c.component.id)),
  );

  /** The CUDA download-on-demand packs (llama LLM + XTTS PyTorch + RVC). Treated
   *  as one "GPU acceleration" group — co-selected at first run and grouped in
   *  the GPU-only view, so the user makes a single GPU choice for every phase. */
  isCudaPack(id: string): boolean {
    return id === 'llama-cuda' || id === 'cuda-tts' || id === 'cuda-rvc';
  }

  // First run: pre-check GPU acceleration when the machine qualifies — the user
  // unchecks it if they don't want it. One-shot (won't fight a manual deselect),
  // selection mode only.
  private autoSelectedGpu = false;
  constructor() {
    effect(() => {
      if (!this.selectionMode() || this.autoSelectedGpu) return;
      const ids = this.addOns()
        .filter((s) => this.isCudaPack(s.component.id)
          && s.state !== 'incompatible' && s.state !== 'installed'
          && this.isDownloadable(s.component))
        .map((s) => s.component.id);
      if (ids.length === 0) return; // not loaded yet, or machine doesn't qualify
      this.autoSelectedGpu = true;
      this.sel.selectMany(ids);
    });
  }

  /** The detected GPU name, for the CUDA pack's explainer line. */
  readonly gpuName = computed(() => {
    const cuda = this.svc.profile()?.cuda;
    return cuda?.available ? (cuda.name || 'NVIDIA GPU') : null;
  });

  /** Downloaded (managed) add-ons that "delete all" would remove. External
   *  installs are left alone — we never delete a user's own software. */
  readonly removableAddOns = computed(() =>
    this.addOns().filter(
      s => s.state === 'installed' && s.installed?.source === 'managed',
    ),
  );

  /** Not-yet-installed, downloadable add-ons — targets of "Select all". */
  readonly selectableAddOnIds = computed(() =>
    this.addOns()
      .filter((s) => s.state !== 'installed' && this.isManaged(s.component) && this.isDownloadable(s.component))
      .map((s) => s.component.id),
  );

  /** How many selectable add-ons on this page are currently checked. */
  readonly selectedHereCount = computed(() =>
    this.selectableAddOnIds().filter((id) => this.sel.isSelected(id)).length,
  );

  /** Whole-card toggle in selection mode (downloadable packs only). */
  onCardSelectClick(status: ComponentStatus): void {
    if (this.selectionMode() && status.state !== 'installed' && this.isDownloadable(status.component)) {
      this.sel.toggle(status.component.id);
    }
  }

  /** Select-all / Deselect-all over the downloadable add-ons shown here. */
  toggleSelectAll(): void {
    const ids = this.selectableAddOnIds();
    if (this.sel.allSelectedAmong(ids)) this.sel.deselectMany(ids);
    else this.sel.selectMany(ids);
  }

  readonly confirmDeleteAll = signal(false);

  /** Uninstall every downloaded managed add-on. */
  deleteAllAddOns(): void {
    for (const s of this.removableAddOns()) {
      void this.svc.remove(s.component.id);
    }
    this.confirmDeleteAll.set(false);
  }

  // Inline manual-locate form state, keyed by component id.
  private readonly manualOpen = signal<Set<string>>(new Set());
  private readonly manualPaths = signal<Record<string, string>>({});

  // "Test environment" — per-component env-diagnostic results + in-flight set.
  private readonly envTests = signal<Record<string, EnvDiagnosticResult | undefined>>({});
  private readonly envTestingIds = signal<Set<string>>(new Set());

  /** Engine components whose env we can diagnose (id is a diagnostic engine). */
  protected canTestEnv(c: OptionalComponent): boolean {
    return ['orpheus', 'voxtral-env', 'f5-env'].includes(c.id);
  }
  protected envTesting(id: string): boolean {
    return this.envTestingIds().has(id);
  }
  protected envResult(id: string): EnvDiagnosticResult | undefined {
    return this.envTests()[id];
  }
  async runEnvTest(id: string): Promise<void> {
    if (this.envTesting(id)) return;
    this.envTestingIds.update(s => new Set(s).add(id));
    try {
      const result = await this.svc.testEnv(id);
      this.envTests.update(m => ({ ...m, [id]: result }));
    } catch (e) {
      this.envTests.update(m => ({
        ...m,
        [id]: { ok: false, checks: [], error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      this.envTestingIds.update(s => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  showManual(id: string): boolean { return this.manualOpen().has(id); }
  manualPath(id: string): string { return this.manualPaths()[id] ?? ''; }

  private openManual(id: string): void {
    this.manualOpen.update(s => new Set(s).add(id));
  }
  closeManual(id: string): void {
    this.manualOpen.update(s => { const n = new Set(s); n.delete(id); return n; });
  }
  onManualInput(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.manualPaths.update(m => ({ ...m, [id]: value }));
  }

  /** Locate… : first auto-search common locations; only reveal the manual form
   *  (type a path / browse) if the tool isn't found automatically. */
  async startLocate(id: string): Promise<void> {
    const found = await this.svc.autoLocate(id);
    if (!found) this.openManual(id);
  }

  async useManual(id: string): Promise<void> {
    const ok = await this.svc.setManualPath(id, this.manualPath(id));
    if (ok) this.closeManual(id);
  }

  async browseFor(id: string): Promise<void> {
    const ok = await this.svc.locate(id);
    if (ok) this.closeManual(id);
  }

  /** A platform-appropriate example path for the manual-entry placeholder,
   *  pulled from the component's own detection candidates when available. */
  locatePlaceholder(component: OptionalComponent): string {
    const plat = this.svc.profile()?.platform;
    const cand = component.detect?.candidates?.find(c => c.platform === plat);
    if (cand) return `e.g. ${cand.path}`;
    return 'Full path to the program';
  }

  ngOnInit(): void {
    this.svc.refresh();
  }

  isManaged(component: OptionalComponent): boolean {
    return component.acquisition.includes('managed');
  }

  /** Managed AND actually fetchable now (has a real artifact URL) — i.e. CUDA,
   *  not a stub-URL placeholder like the Orpheus managed entry. */
  isDownloadable(component: OptionalComponent): boolean {
    return component.acquisition.includes('managed')
      && component.artifacts.some(a => !!a.url && a.url.trim() !== '');
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

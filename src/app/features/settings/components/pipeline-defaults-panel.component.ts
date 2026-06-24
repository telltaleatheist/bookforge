import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { SettingsService, PipelineDefaults } from '../../../core/services/settings.service';
import { ComponentService } from '../../../core/services/component.service';
import { selectableEngines, type TtsEngineCaps } from '../../language-learning/models/tts-engine-registry';
import {
  AIProvider,
  OLLAMA_MODELS,
  CLAUDE_MODELS,
  OPENAI_MODELS,
} from '../../../core/models/ai-config.types';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../creamsicle-desktop';

interface Opt { value: string; label: string; }

/**
 * Settings → Pipeline Defaults. Edits the default selections the processing
 * pipeline (LL wizard) seeds itself from: AI per role, TTS engine/device/voice/
 * speed/temperature/topP, and the assembly output format. Every change persists
 * immediately via SettingsService; the wizard reads them on open.
 */
@Component({
  selector: 'app-pipeline-defaults-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopSelectComponent],
  template: `
    <div class="pd">
      <p class="pd-intro">
        These become the starting selections each time you open the processing
        pipeline. You can still change anything per book; a half-finished run that
        you reopen keeps its own settings.
      </p>

      <!-- AI roles -->
      <section class="pd-group">
        <h4>AI models</h4>
        @for (role of aiRoles; track role.key) {
          <div class="pd-row">
            <label class="pd-label">{{ role.label }}</label>
            <div class="pd-controls">
              <desktop-select class="pd-select" [options]="providerOptions"
                [ngModel]="providerOf(role.key)" (ngModelChange)="setProvider(role.key, $event)"></desktop-select>
              <desktop-select class="pd-select" [options]="modelOptionsFor(role.key)"
                [ngModel]="modelOf(role.key)" (ngModelChange)="setModel(role.key, $event)"
                [disabled]="modelsFor(providerOf(role.key)).length === 0"></desktop-select>
            </div>
          </div>
        }
      </section>

      <!-- TTS -->
      <section class="pd-group">
        <h4>Text-to-speech</h4>

        <div class="pd-row">
          <label class="pd-label">Engine</label>
          <div class="pd-btns">
            @for (eng of availableEngines(); track eng.id) {
              <button class="pd-btn" [class.selected]="d().ttsEngine === eng.id" (click)="set({ ttsEngine: eng.id })">{{ eng.displayName }}</button>
            }
          </div>
        </div>

        <div class="pd-row">
          <label class="pd-label">Processing device</label>
          <div class="pd-controls pd-device">
            <div class="pd-btns">
              <button class="pd-btn" [class.selected]="d().ttsDevice === 'auto'" (click)="set({ ttsDevice: 'auto' })">Auto</button>
              <button class="pd-btn" [class.selected]="d().ttsDevice === 'cpu'" (click)="set({ ttsDevice: 'cpu' })">CPU</button>
              @if (isMac) {
                <button class="pd-btn" [class.selected]="d().ttsDevice === 'mps'" (click)="set({ ttsDevice: 'mps' })">GPU (MPS)</button>
              } @else {
                <button class="pd-btn" [class.selected]="d().ttsDevice === 'gpu'" (click)="set({ ttsDevice: 'gpu' })">GPU (CUDA)</button>
              }
            </div>
            <span class="pd-hint">{{ deviceHint() }}</span>
          </div>
        </div>

        <div class="pd-row">
          <label class="pd-label">Voice</label>
          <div class="pd-controls">
            <desktop-select class="pd-select" [options]="xttsVoiceOptions()"
              [ngModel]="d().ttsVoice" (ngModelChange)="set({ ttsVoice: $event })"></desktop-select>
          </div>
        </div>

        @if (rvcEnvInstalled()) {
          <div class="pd-row">
            <label class="pd-label">Voice enhancement</label>
            <div class="pd-controls">
              <label class="pd-toggle">
                <input type="checkbox" [checked]="d().rvcEnhancementEnabled"
                       (change)="set({ rvcEnhancementEnabled: $any($event.target).checked })" />
                Re-render narration through an RVC voice (after rendering, before assembly)
              </label>
            </div>
          </div>
          @if (d().rvcEnhancementEnabled) {
            <div class="pd-row">
              <label class="pd-label">Enhancement voice</label>
              <div class="pd-controls">
                @if (installedRvcVoices().length > 0) {
                  <desktop-select class="pd-select" [options]="rvcVoiceOptions()" placeholder="Choose a voice…"
                    [ngModel]="d().rvcEnhancementVoiceId" (ngModelChange)="set({ rvcEnhancementVoiceId: $event })"></desktop-select>
                } @else {
                  <span class="pd-hint">No enhancement voices installed — add one in Settings → Voice Enhancement.</span>
                }
              </div>
            </div>
            <span class="pd-hint">Pick a voice close to the original — RVC carries the original's content &amp; pitch.</span>
          }
        }

        <div class="pd-row">
          <label class="pd-label">Speed: {{ d().ttsSpeed.toFixed(2) }}x</label>
          <input type="range" min="0.5" max="2" step="0.05" [value]="d().ttsSpeed" (input)="set({ ttsSpeed: +$any($event.target).value })" />
        </div>

        <div class="pd-row">
          <label class="pd-label">Temperature: {{ d().ttsTemperature.toFixed(2) }}</label>
          <input type="range" min="0.1" max="1" step="0.05" [value]="d().ttsTemperature" (input)="set({ ttsTemperature: +$any($event.target).value })" />
        </div>

        <div class="pd-row">
          <label class="pd-label">Top P: {{ d().ttsTopP.toFixed(2) }}</label>
          <input type="range" min="0.1" max="1" step="0.05" [value]="d().ttsTopP" (input)="set({ ttsTopP: +$any($event.target).value })" />
        </div>
      </section>

      <!-- Output -->
      <section class="pd-group">
        <h4>Assembly output</h4>
        <div class="pd-row">
          <label class="pd-label">Default format</label>
          <div class="pd-btns">
            <button class="pd-btn" [class.selected]="!d().generateVideo" (click)="set({ generateVideo: false })">Audiobook</button>
            <button class="pd-btn" [class.selected]="d().generateVideo" (click)="set({ generateVideo: true })">Video</button>
          </div>
        </div>
      </section>

      <div class="pd-save">
        <button class="pd-save-btn" (click)="save()" [disabled]="!dirty() || saving()">
          {{ saving() ? 'Saving…' : (dirty() ? 'Save changes' : 'Saved') }}
        </button>
        @if (dirty()) { <span class="pd-unsaved">You have unsaved changes</span> }
      </div>
    </div>
  `,
  styles: [`
    .pd { display: flex; flex-direction: column; gap: 20px; max-width: 640px; }
    .pd-save { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
    .pd-save-btn {
      padding: 8px 18px; border-radius: 7px; border: 1px solid transparent;
      background: var(--accent, var(--accent-primary)); color: #1a1a1a;
      font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .pd-save-btn:disabled { opacity: 0.5; cursor: default; }
    .pd-unsaved { font-size: 12px; color: var(--text-secondary); }
    .pd-intro { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
    .pd-group { display: flex; flex-direction: column; gap: 12px; }
    .pd-group h4 { margin: 0; font-size: 13px; font-weight: 700; color: var(--text-primary); }
    .pd-row { display: flex; align-items: center; gap: 12px; }
    .pd-label { flex: 0 0 150px; font-size: 13px; color: var(--text-secondary); }
    .pd-controls { display: flex; gap: 8px; flex: 1; }
    .pd-select {
      flex: 1; min-width: 0; padding: 6px 8px; border-radius: 6px;
      border: 1px solid var(--border-default); background: var(--bg-input, var(--surface-1));
      color: var(--text-primary); font-size: 13px;
    }
    .pd-select:disabled { opacity: 0.5; }
    .pd-device { flex-direction: column; align-items: flex-start; gap: 6px; }
    .pd-hint { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
    .pd-btns { display: flex; gap: 8px; }
    .pd-btn {
      min-width: 64px; padding: 6px 12px; border-radius: 6px;
      border: 1px solid var(--border-default); background: var(--bg-surface, var(--surface-1));
      color: var(--text-secondary); font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 0.15s;
    }
    .pd-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); }
    .pd-btn.selected {
      background: var(--accent, var(--accent-primary)); border-color: var(--accent, var(--accent-primary)); color: #1a1a1a;
    }
    .pd-row input[type="range"] { flex: 1; accent-color: var(--accent, var(--accent-primary)); }
  `]
})
export class PipelineDefaultsPanelComponent {
  private readonly settings = inject(SettingsService);
  private readonly components = inject(ComponentService);

  /** TTS engines selectable as a default — bundled ones always, optional-env ones
   *  (Orpheus/Voxtral/F5) only once their component is installed. */
  readonly availableEngines = computed<TtsEngineCaps[]>(() =>
    selectableEngines((id) => this.components.isInstalled(id)),
  );

  /** The RVC enhancement engine is installed (gates the enhancement controls). */
  readonly rvcEnvInstalled = computed(() => this.components.isInstalled('rvc-env'));
  /** Installed enhancement voices, for the picker. */
  readonly installedRvcVoices = computed(() =>
    this.components.components().filter((c) => c.component.kind === 'rvc-model' && c.state === 'installed'),
  );

  // Draft edits live here and are applied to settings ONLY when the user clicks
  // Save — no auto-save on change. `saved` is the last-persisted snapshot so we
  // can show a dirty state and a working Save button.
  readonly d = signal<PipelineDefaults>(this.settings.getPipelineDefaults());
  private readonly saved = signal<PipelineDefaults>(this.settings.getPipelineDefaults());
  readonly dirty = computed(() => JSON.stringify(this.d()) !== JSON.stringify(this.saved()));
  readonly saving = signal(false);

  // Mac GPU = MPS (Metal); CUDA is Windows/Linux only — show the right one.
  readonly isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  /** What the chosen device actually runs on — surfaces 'auto' transparently and
   *  warns when an explicit GPU choice can't run without the GPU pack. */
  readonly deviceHint = computed(() => {
    const dev = this.d().ttsDevice;
    const gpuPack = this.components.isInstalled('cuda-tts');
    if (dev === 'auto') {
      if (this.isMac) return 'Runs on your Mac’s GPU (Metal/MPS).';
      return gpuPack
        ? 'Runs on your NVIDIA GPU (CUDA) — fastest.'
        : 'Runs on CPU. Install “Faster Voice Narration” in Add-ons to use your GPU.';
    }
    if (dev === 'cpu') return 'Always runs on CPU (slower, no GPU needed).';
    if (dev === 'mps') return 'Runs on your Mac’s GPU (Metal/MPS).';
    // explicit gpu (CUDA)
    return gpuPack
      ? 'Runs on your NVIDIA GPU (CUDA).'
      : '⚠ Requires the “Faster Voice Narration” GPU pack — install it in Add-ons, or conversions will fail.';
  });

  constructor() {
    void this.loadXttsVoices();
    void this.components.ensureLoaded();
  }

  /** Load installed audiobook voices into the default-voice picker. */
  private async loadXttsVoices(): Promise<void> {
    try {
      const api = (window as any).electron?.customVoices;
      if (!api?.listAudiobook) return;
      const res = await api.listAudiobook();
      if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
        this.xttsVoices.set(res.data);
      }
    } catch {
      /* keep the seeded default options */
    }
  }

  readonly providers: { value: AIProvider; label: string }[] = [
    { value: 'ollama', label: 'Ollama' },
    { value: 'claude', label: 'Claude' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'local', label: 'Bundled local' },
  ];

  /** Provider options for the desktop-select (same source as the old <option>s). */
  readonly providerOptions: DesktopSelectItems = this.providers.map((p) => ({ value: p.value, label: p.label }));

  /** Model options for a role's current provider; falls back to a bundled-local entry. */
  modelOptionsFor(role: 'cleanup' | 'simplify' | 'translate'): DesktopSelectItems {
    const models = this.modelsFor(this.providerOf(role));
    if (models.length === 0) return [{ value: '', label: 'Bundled local model' }];
    return models.map((m) => ({ value: m.value, label: m.label }));
  }

  readonly aiRoles: { key: 'cleanup' | 'simplify' | 'translate'; label: string }[] = [
    { key: 'cleanup', label: 'AI cleanup' },
    { key: 'simplify', label: 'AI simplify' },
    { key: 'translate', label: 'Translation' },
  ];

  // Installed audiobook voices, loaded from the main process so the default-voice
  // picker only offers voices that actually work. Seeded with the always-present
  // bundled voice so the select is never empty before the async load resolves.
  readonly xttsVoices = signal<Opt[]>([
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
    { value: 'internal', label: 'Default XTTS' },
  ]);

  /** XTTS voice options for the desktop-select. */
  readonly xttsVoiceOptions = computed<DesktopSelectItems>(() =>
    this.xttsVoices().map((v) => ({ value: v.value, label: v.label })),
  );

  /** Installed RVC enhancement voice options for the desktop-select. */
  readonly rvcVoiceOptions = computed<DesktopSelectItems>(() =>
    this.installedRvcVoices().map((c) => ({ value: c.component.id, label: c.component.name })),
  );

  modelsFor(provider: AIProvider): Opt[] {
    switch (provider) {
      case 'ollama': return OLLAMA_MODELS;
      case 'claude': return CLAUDE_MODELS;
      case 'openai': return OPENAI_MODELS;
      default: return [];  // 'local' uses the bundled model — no model picker
    }
  }

  providerOf(role: 'cleanup' | 'simplify' | 'translate'): AIProvider {
    return this.d()[`${role}Provider`];
  }

  modelOf(role: 'cleanup' | 'simplify' | 'translate'): string {
    return this.d()[`${role}Model`];
  }

  setProvider(role: 'cleanup' | 'simplify' | 'translate', provider: AIProvider): void {
    // Reset the model to the new provider's first option (or '' for local).
    const first = this.modelsFor(provider)[0]?.value ?? '';
    this.d.update((v) => ({ ...v, [`${role}Provider`]: provider, [`${role}Model`]: first }) as PipelineDefaults);
  }

  setModel(role: 'cleanup' | 'simplify' | 'translate', model: string): void {
    this.d.update((v) => ({ ...v, [`${role}Model`]: model }) as PipelineDefaults);
  }

  /** Update the DRAFT only — nothing persists until Save. */
  set(updates: Partial<PipelineDefaults>): void {
    this.d.update((v) => ({ ...v, ...updates }));
  }

  /** Persist the draft as the new Pipeline Defaults. */
  save(): void {
    this.saving.set(true);
    this.settings.setPipelineDefaults(this.d());
    this.saved.set(this.d());
    this.saving.set(false);
  }
}

import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { SettingsService, PipelineDefaults } from '../../../core/services/settings.service';
import {
  AIProvider,
  OLLAMA_MODELS,
  CLAUDE_MODELS,
  OPENAI_MODELS,
} from '../../../core/models/ai-config.types';

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
  imports: [CommonModule],
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
              <select class="pd-select" [value]="providerOf(role.key)" (change)="setProvider(role.key, $any($event.target).value)">
                @for (p of providers; track p.value) {
                  <option [value]="p.value" [selected]="p.value === providerOf(role.key)">{{ p.label }}</option>
                }
              </select>
              <select class="pd-select" [value]="modelOf(role.key)" (change)="setModel(role.key, $any($event.target).value)" [disabled]="modelsFor(providerOf(role.key)).length === 0">
                @for (m of modelsFor(providerOf(role.key)); track m.value) {
                  <option [value]="m.value" [selected]="m.value === modelOf(role.key)">{{ m.label }}</option>
                }
                @if (modelsFor(providerOf(role.key)).length === 0) {
                  <option value="">Bundled local model</option>
                }
              </select>
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
            <button class="pd-btn" [class.selected]="d().ttsEngine === 'xtts'" (click)="set({ ttsEngine: 'xtts' })">XTTS</button>
            <button class="pd-btn" [class.selected]="d().ttsEngine === 'orpheus'" (click)="set({ ttsEngine: 'orpheus' })">Orpheus</button>
          </div>
        </div>

        <div class="pd-row">
          <label class="pd-label">Processing device</label>
          <div class="pd-btns">
            <button class="pd-btn" [class.selected]="d().ttsDevice === 'cpu'" (click)="set({ ttsDevice: 'cpu' })">CPU{{ isMac ? ' (recommended)' : '' }}</button>
            @if (isMac) {
              <button class="pd-btn" [class.selected]="d().ttsDevice === 'mps'" (click)="set({ ttsDevice: 'mps' })">GPU (MPS)</button>
            } @else {
              <button class="pd-btn" [class.selected]="d().ttsDevice === 'gpu'" (click)="set({ ttsDevice: 'gpu' })">GPU (CUDA)</button>
            }
          </div>
        </div>

        <div class="pd-row">
          <label class="pd-label">Voice</label>
          <div class="pd-controls">
            <select class="pd-select" [value]="d().ttsVoice" (change)="set({ ttsVoice: $any($event.target).value })">
              @for (v of xttsVoices(); track v.value) {
                <option [value]="v.value" [selected]="v.value === d().ttsVoice">{{ v.label }}</option>
              }
            </select>
          </div>
        </div>

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
    </div>
  `,
  styles: [`
    .pd { display: flex; flex-direction: column; gap: 20px; max-width: 640px; }
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

  readonly d = computed<PipelineDefaults>(() => this.settings.getPipelineDefaults());

  // Mac GPU = MPS (Metal); CUDA is Windows/Linux only — show the right one.
  readonly isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  constructor() {
    void this.loadXttsVoices();
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
    this.settings.updatePipelineDefaults({
      [`${role}Provider`]: provider,
      [`${role}Model`]: first,
    } as Partial<PipelineDefaults>);
  }

  setModel(role: 'cleanup' | 'simplify' | 'translate', model: string): void {
    this.settings.updatePipelineDefaults({ [`${role}Model`]: model } as Partial<PipelineDefaults>);
  }

  set(updates: Partial<PipelineDefaults>): void {
    this.settings.updatePipelineDefaults(updates);
  }
}

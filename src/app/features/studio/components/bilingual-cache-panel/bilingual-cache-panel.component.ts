/**
 * BilingualCachePanelComponent - Manage sentence cache and audio for bilingual TTS
 *
 * Features:
 * - View cached languages with sentence counts and audio status
 * - Run TTS on selected languages (caches audio to audio/{lang}/)
 * - Assemble cached audio into final audiobook
 * - Clear cache
 */

import { Component, input, output, signal, computed, inject, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SUPPORTED_LANGUAGES } from '../../models/studio.types';
import { CachedLanguageInfo, CachedTtsSettings } from '../../models/sentence-cache.types';
import { ComponentService } from '../../../../core/services/component.service';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';

interface TtsConfig {
  engine: 'xtts' | 'orpheus';
  voice: string;
  speed: number;
  device: 'cpu' | 'mps' | 'gpu';
  workers: number;
}

@Component({
  selector: 'app-bilingual-cache-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopSelectComponent],
  template: `
    <div class="bilingual-panel">
      <div class="panel-header">
        <h3>Bilingual Audio</h3>
        <p class="panel-desc">
          Generate TTS for each language, then assemble into a bilingual audiobook.
        </p>
      </div>

      @if (loading()) {
        <div class="loading-state">
          <div class="spinner"></div>
          <span>Loading cache...</span>
        </div>
      } @else {
        <!-- Cached Languages with Audio Status -->
        <div class="section">
          <h4>Cached Languages</h4>
          @if (cachedLanguages().length === 0) {
            <div class="empty-state">
              <p>No cached sentences yet.</p>
              <p class="hint">Run Translation from the Process tab to cache sentences.</p>
            </div>
          } @else {
            <div class="cached-list">
              @for (lang of cachedLanguages(); track lang.code) {
                <div class="cached-item" [class.has-audio]="lang.hasAudio">
                  <label class="lang-checkbox">
                    <input
                      type="checkbox"
                      [checked]="selectedLanguages().has(lang.code)"
                      (change)="toggleLanguage(lang.code)"
                    />
                    <span class="checkmark"></span>
                  </label>
                  <div class="cached-info">
                    <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                    <span class="lang-name">{{ lang.name }}</span>
                    <span class="sentence-count">{{ lang.sentenceCount }} sentences</span>
                    @if (lang.sourceLanguage) {
                      <span class="source-badge">from {{ lang.sourceLanguage.toUpperCase() }}</span>
                    } @else {
                      <span class="source-badge primary">Source</span>
                    }
                  </div>
                  <div class="audio-status">
                    @if (lang.hasAudio) {
                      <span class="audio-badge ready">Audio Ready</span>
                      @if (lang.ttsSettings) {
                        <span class="tts-info">{{ lang.ttsSettings.engine }} / {{ lang.ttsSettings.voice }}</span>
                      }
                    } @else {
                      <span class="audio-badge pending">No Audio</span>
                    }
                  </div>
                  <button
                    class="btn-icon btn-delete"
                    (click)="deleteCachedLanguage(lang.code)"
                    title="Delete cache"
                  >
                    <span class="icon">×</span>
                  </button>
                </div>
              }
            </div>

            <div class="cache-actions">
              <button class="btn-text" (click)="selectAll()">Select All</button>
              <button class="btn-text" (click)="selectNone()">Select None</button>
              <button
                class="btn-text btn-danger"
                (click)="clearAllCache()"
                [disabled]="clearing()"
              >
                {{ clearing() ? 'Clearing...' : 'Clear All' }}
              </button>
            </div>
          }
        </div>

        <!-- TTS Section -->
        @if (cachedLanguages().length > 0) {
          <div class="section">
            <h4>Text-to-Speech</h4>
            <p class="section-desc">Generate audio for selected languages. Audio is cached for assembly.</p>

            <div class="tts-settings">
              <div class="setting-row">
                <label>Engine</label>
                <desktop-select
                  [options]="engineOptions()"
                  [(ngModel)]="ttsConfig.engine"
                  (ngModelChange)="onEngineChange()"
                />
              </div>

              <div class="setting-row">
                <label>Voice</label>
                <desktop-select
                  [options]="voiceOptions()"
                  [(ngModel)]="ttsConfig.voice"
                />
              </div>

              <div class="setting-row">
                <label>Speed</label>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  [(ngModel)]="ttsConfig.speed"
                />
                <span class="speed-value">{{ ttsConfig.speed }}x</span>
              </div>

              <div class="setting-row">
                <label>Device</label>
                <desktop-select
                  [options]="deviceOptions"
                  [(ngModel)]="ttsConfig.device"
                />
              </div>

              <div class="setting-row">
                <label>Workers</label>
                <desktop-select
                  [options]="workerOptions"
                  [(ngModel)]="ttsConfig.workers"
                />
              </div>
            </div>

            <button
              class="btn-primary btn-large"
              [disabled]="!canRunTts()"
              (click)="runTts()"
            >
              <span class="btn-icon-left">🔊</span>
              Run TTS on {{ selectedLanguages().size }} Language{{ selectedLanguages().size !== 1 ? 's' : '' }}
            </button>

            @if (!canRunTts() && cachedLanguages().length > 0) {
              <p class="hint">Select at least one language to run TTS.</p>
            }
          </div>

          <!-- Assembly Section -->
          <div class="section">
            <h4>Assembly</h4>
            <p class="section-desc">Combine audio from multiple languages into a bilingual audiobook.</p>

            <div class="assembly-settings">
              <div class="setting-row">
                <label>Pattern</label>
                <desktop-select
                  [options]="patternOptions"
                  [(ngModel)]="assemblyPattern"
                />
              </div>

              <div class="setting-row">
                <label>Pause Between Languages</label>
                <desktop-select
                  [options]="pauseOptions"
                  [(ngModel)]="pauseBetweenLanguages"
                />
              </div>

              <div class="setting-row">
                <label>Output Format</label>
                <desktop-select
                  [options]="outputFormatOptions"
                  [(ngModel)]="outputFormat"
                />
              </div>
            </div>

            <button
              class="btn-primary btn-large"
              [disabled]="!canAssemble()"
              (click)="runAssembly()"
            >
              <span class="btn-icon-left">🎧</span>
              Assemble Audiobook
            </button>

            @if (!canAssemble()) {
              <p class="hint">
                @if (languagesWithAudio().length < 2) {
                  Need at least 2 languages with audio to assemble.
                } @else {
                  Select languages with audio (green) to assemble.
                }
              </p>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .bilingual-panel {
      padding: 20px;
      height: 100%;
      overflow-y: auto;
    }

    .panel-header {
      margin-bottom: 24px;

      h3 {
        margin: 0 0 8px;
        font-size: 20px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .panel-desc {
        margin: 0;
        font-size: 14px;
        color: var(--text-secondary);
      }
    }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 40px;
      color: var(--text-secondary);

      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid var(--border-default);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .section {
      margin-bottom: 32px;
      padding: 20px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 12px;

      h4 {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .section-desc {
        margin: 0 0 16px;
        font-size: 13px;
        color: var(--text-secondary);
      }
    }

    .empty-state {
      padding: 32px;
      text-align: center;
      background: var(--bg-base);
      border-radius: 8px;
      border: 1px dashed var(--border-default);

      p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 14px;

        &.hint {
          margin-top: 8px;
          font-size: 13px;
          color: var(--text-muted);
        }
      }
    }

    .cached-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .cached-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      transition: all 0.15s ease;

      &.has-audio {
        border-color: rgba(34, 197, 94, 0.3);
        background: rgba(34, 197, 94, 0.05);
      }

      .lang-checkbox {
        position: relative;
        display: flex;
        align-items: center;
        cursor: pointer;

        input {
          position: absolute;
          opacity: 0;
          cursor: pointer;
        }

        .checkmark {
          width: 20px;
          height: 20px;
          border: 2px solid var(--border-default);
          border-radius: 4px;
          transition: all 0.15s ease;
        }

        input:checked ~ .checkmark {
          background: var(--color-primary);
          border-color: var(--color-primary);
        }

        input:checked ~ .checkmark::after {
          content: '✓';
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 12px;
          font-weight: bold;
        }
      }

      .cached-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        flex-wrap: wrap;
      }

      .lang-code {
        font-weight: 600;
        color: var(--text-primary);
        font-size: 14px;
        min-width: 30px;
      }

      .lang-name {
        color: var(--text-secondary);
        font-size: 13px;
      }

      .sentence-count {
        font-size: 12px;
        color: var(--text-muted);
        padding: 2px 8px;
        background: var(--bg-elevated);
        border-radius: 12px;
      }

      .source-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 12px;
        background: var(--bg-elevated);
        color: var(--text-secondary);

        &.primary {
          background: rgba(6, 182, 212, 0.15);
          color: var(--color-primary);
        }
      }

      .audio-status {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .audio-badge {
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 12px;
        font-weight: 500;

        &.ready {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
        }

        &.pending {
          background: rgba(156, 163, 175, 0.15);
          color: var(--text-muted);
        }
      }

      .tts-info {
        font-size: 11px;
        color: var(--text-muted);
      }

      .btn-delete {
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        color: var(--text-muted);
        font-size: 18px;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
        }
      }
    }

    .cache-actions {
      display: flex;
      gap: 16px;
      padding-top: 8px;
    }

    .btn-text {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      padding: 4px 0;

      &:hover {
        color: var(--text-primary);
      }

      &.btn-danger:hover {
        color: #ef4444;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .tts-settings, .assembly-settings {
      display: grid;
      gap: 12px;
      margin-bottom: 20px;
    }

    .setting-row {
      display: flex;
      align-items: center;
      gap: 12px;

      label {
        min-width: 140px;
        font-size: 13px;
        color: var(--text-secondary);
      }

      select, input[type="range"] {
        flex: 1;
        max-width: 200px;
      }

      select {
        padding: 8px 12px;
        background: var(--bg-base);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;

        &:focus {
          outline: none;
          border-color: var(--color-primary);
        }
      }

      input[type="range"] {
        cursor: pointer;
      }

      .speed-value {
        min-width: 40px;
        font-size: 13px;
        color: var(--text-muted);
      }
    }

    .btn-primary {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 24px;
      background: var(--color-primary);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      width: 100%;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
        transform: translateY(-1px);
      }

      &:active:not(:disabled) {
        transform: translateY(0);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-icon-left {
        font-size: 18px;
      }
    }

    .btn-large {
      padding: 16px 28px;
      font-size: 16px;
    }

    .hint {
      margin: 12px 0 0;
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }
  `]
})
export class BilingualCachePanelComponent implements OnInit, OnChanges {
  // Public for the template: gates optional TTS engines (e.g. Orpheus) on availability.
  protected readonly componentService = inject(ComponentService);

  // Inputs
  readonly audiobookFolder = input.required<string>();

  // Outputs
  readonly ttsRequested = output<{
    languages: string[];
    config: TtsConfig;
  }>();

  readonly assemblyRequested = output<{
    languages: string[];
    pattern: 'interleaved' | 'sequential';
    pauseBetweenLanguages: number;
    outputFormat: 'm4b' | 'mp3';
  }>();

  // State
  readonly loading = signal<boolean>(true);
  readonly clearing = signal<boolean>(false);
  readonly cachedLanguages = signal<CachedLanguageInfo[]>([]);
  readonly selectedLanguages = signal<Set<string>>(new Set());

  // TTS Settings
  ttsConfig: TtsConfig = {
    engine: 'orpheus',
    voice: 'tara',
    speed: 1.0,
    device: 'cpu',
    workers: 2,
  };

  // Select option sources (mirror the former <option> lists / @if guards exactly)
  private readonly orpheusVoiceOptions: DesktopSelectItems = [
    { value: 'tara', label: 'Tara' },
    { value: 'leah', label: 'Leah' },
    { value: 'jess', label: 'Jess' },
    { value: 'leo', label: 'Leo' },
    { value: 'dan', label: 'Dan' },
    { value: 'mia', label: 'Mia' },
    { value: 'zac', label: 'Zac' },
    { value: 'zoe', label: 'Zoe' },
  ];

  private readonly xttsVoiceOptions: DesktopSelectItems = [
    { value: 'en_default', label: 'English Default' },
    { value: 'en_male', label: 'English Male' },
    { value: 'en_female', label: 'English Female' },
    { value: 'de_default', label: 'German Default' },
    { value: 'es_default', label: 'Spanish Default' },
    { value: 'fr_default', label: 'French Default' },
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
    { value: 'MorganFreeman', label: 'Morgan Freeman' },
    { value: 'DavidAttenborough', label: 'David Attenborough' },
    { value: 'NeilGaiman', label: 'Neil Gaiman' },
    { value: 'RayPorter', label: 'Ray Porter' },
    { value: 'RosamundPike', label: 'Rosamund Pike' },
  ];

  /** Engine options — Orpheus only appears when installed (mirrors old @if guard). */
  engineOptions(): DesktopSelectItems {
    const opts: DesktopSelectItems = [{ value: 'xtts', label: 'XTTS (Clone Voice)' }];
    if (this.componentService.isInstalled('orpheus')) {
      opts.push({ value: 'orpheus', label: 'Orpheus (Natural)' });
    }
    return opts;
  }

  /** Voice options depend on the selected engine. */
  voiceOptions(): DesktopSelectItems {
    return this.ttsConfig.engine === 'orpheus' ? this.orpheusVoiceOptions : this.xttsVoiceOptions;
  }

  readonly deviceOptions: DesktopSelectItems = [
    { value: 'cpu', label: 'CPU' },
    { value: 'mps', label: 'MPS (Mac GPU)' },
    { value: 'gpu', label: 'CUDA GPU' },
  ];

  readonly workerOptions: DesktopSelectItems = [
    { value: 1, label: '1 Worker' },
    { value: 2, label: '2 Workers' },
    { value: 3, label: '3 Workers' },
    { value: 4, label: '4 Workers' },
  ];

  readonly patternOptions: DesktopSelectItems = [
    { value: 'interleaved', label: 'Interleaved (EN-DE-EN-DE...)' },
    { value: 'sequential', label: 'Sequential (All EN, then all DE)' },
  ];

  readonly pauseOptions: DesktopSelectItems = [
    { value: 500, label: '0.5 sec' },
    { value: 1000, label: '1 sec' },
    { value: 1500, label: '1.5 sec' },
    { value: 2000, label: '2 sec' },
  ];

  readonly outputFormatOptions: DesktopSelectItems = [
    { value: 'm4b', label: 'M4B (Audiobook)' },
    { value: 'mp3', label: 'MP3' },
  ];

  // Assembly Settings
  assemblyPattern: 'interleaved' | 'sequential' = 'interleaved';
  pauseBetweenLanguages = 1000;
  outputFormat: 'm4b' | 'mp3' = 'm4b';

  // Computed
  readonly languagesWithAudio = computed(() => {
    return this.cachedLanguages().filter(l => l.hasAudio);
  });

  readonly canRunTts = computed(() => {
    return this.selectedLanguages().size > 0;
  });

  readonly canAssemble = computed(() => {
    // Need at least 2 languages with audio selected
    const selected = this.selectedLanguages();
    const withAudio = this.languagesWithAudio().filter(l => selected.has(l.code));
    return withAudio.length >= 2;
  });

  async ngOnInit(): Promise<void> {
    await this.loadCache();
    // Default engine is Orpheus; if it isn't installed, fall back to XTTS so the
    // picker (which now hides the Orpheus option) and the config stay consistent.
    await this.componentService.ensureLoaded();
    if (this.ttsConfig.engine === 'orpheus' && !this.componentService.isInstalled('orpheus')) {
      this.ttsConfig.engine = 'xtts';
      this.onEngineChange();
    }
  }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['audiobookFolder'] && !changes['audiobookFolder'].firstChange) {
      await this.loadCache();
    }
  }

  async loadCache(): Promise<void> {
    const folder = this.audiobookFolder();
    if (!folder) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);

    try {
      const electron = (window as any).electron;
      if (!electron?.sentenceCache) {
        console.error('[BilingualCache] sentenceCache API not available');
        this.loading.set(false);
        return;
      }

      const result = await electron.sentenceCache.list(folder);
      if (result.success) {
        this.cachedLanguages.set(result.languages);
      } else {
        console.error('[BilingualCache] Failed to load cache:', result.error);
      }
    } catch (err) {
      console.error('[BilingualCache] Error loading cache:', err);
    } finally {
      this.loading.set(false);
    }
  }

  toggleLanguage(langCode: string): void {
    const current = new Set(this.selectedLanguages());
    if (current.has(langCode)) {
      current.delete(langCode);
    } else {
      current.add(langCode);
    }
    this.selectedLanguages.set(current);
  }

  selectAll(): void {
    const all = new Set(this.cachedLanguages().map(l => l.code));
    this.selectedLanguages.set(all);
  }

  selectNone(): void {
    this.selectedLanguages.set(new Set());
  }

  onEngineChange(): void {
    // Reset voice when engine changes
    if (this.ttsConfig.engine === 'orpheus') {
      this.ttsConfig.voice = 'tara';
      this.ttsConfig.workers = 1; // Orpheus is single-worker
    } else {
      this.ttsConfig.voice = 'en_default';  // Use built-in XTTS default voice
      this.ttsConfig.workers = 2;
    }
  }

  async deleteCachedLanguage(langCode: string): Promise<void> {
    const folder = this.audiobookFolder();
    if (!folder) return;

    try {
      const electron = (window as any).electron;
      await electron.sentenceCache.clear(folder, [langCode]);
      await this.loadCache();

      // Remove from selection
      const selected = new Set(this.selectedLanguages());
      selected.delete(langCode);
      this.selectedLanguages.set(selected);
    } catch (err) {
      console.error('[BilingualCache] Error deleting cache:', err);
    }
  }

  async clearAllCache(): Promise<void> {
    const folder = this.audiobookFolder();
    if (!folder) return;

    this.clearing.set(true);

    try {
      const electron = (window as any).electron;
      await electron.sentenceCache.clear(folder);
      await this.loadCache();
      this.selectedLanguages.set(new Set());
    } catch (err) {
      console.error('[BilingualCache] Error clearing cache:', err);
    } finally {
      this.clearing.set(false);
    }
  }

  runTts(): void {
    if (!this.canRunTts()) return;

    this.ttsRequested.emit({
      languages: Array.from(this.selectedLanguages()),
      config: { ...this.ttsConfig },
    });
  }

  runAssembly(): void {
    if (!this.canAssemble()) return;

    // Only include selected languages that have audio
    const selected = this.selectedLanguages();
    const langsWithAudio = this.languagesWithAudio()
      .filter(l => selected.has(l.code))
      .map(l => l.code);

    this.assemblyRequested.emit({
      languages: langsWithAudio,
      pattern: this.assemblyPattern,
      pauseBetweenLanguages: this.pauseBetweenLanguages,
      outputFormat: this.outputFormat,
    });
  }
}

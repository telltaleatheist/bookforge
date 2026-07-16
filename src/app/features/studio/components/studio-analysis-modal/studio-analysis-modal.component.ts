import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { QueueService } from '../../../queue/services/queue.service';
import { AIProvider } from '../../../../core/models/ai-config.types';
import { StudioItem } from '../../models/studio.types';
import { AnalysisCategory, DEFAULT_ANALYSIS_CATEGORIES } from '../../analysis-categories';
import { StudioAnalysisTarget, studioManifestProjectId } from '../../analysis-target';

type AnalysisProvider = Exclude<AIProvider, 'local'>;

interface AnalysisAISelection {
  provider: AnalysisProvider;
  models: Partial<Record<AnalysisProvider, string>>;
}

const ANALYSIS_AI_SELECTION_KEY = 'bookforge-analysis-ai-selection';

@Component({
  selector: 'app-studio-analysis-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopSelectComponent],
  template: `
    <div class="backdrop" (click)="close.emit()">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="analysis-modal-title"
               (click)="$event.stopPropagation()">
        <header class="modal-head">
          <div class="head-copy">
            <div class="eyebrow">Content analysis</div>
            <h2 id="analysis-modal-title">Configure analysis</h2>
          </div>
          <button class="close-btn" type="button" (click)="close.emit()" title="Close">✕</button>
        </header>

        <div class="locked-target">
          <span class="target-icon">{{ target().kind === 'audiobook' ? '🎧' : '📖' }}</span>
          <div class="target-copy">
            <span class="target-kicker">{{ target().kind === 'audiobook' ? 'Audiobook transcript' : 'Book text' }}</span>
            <strong>{{ target().versionLabel }}</strong>
          </div>
        </div>

        <div class="modal-body">
          <div class="config-section">
            <label class="field-label">AI provider</label>
            <div class="provider-buttons">
              <button class="provider-btn" [class.selected]="provider() === 'ollama'"
                      [class.connected]="provider() === 'ollama' && ollamaConnected()"
                      (click)="selectProvider('ollama')">
                <span class="provider-icon">🦙</span>
                <span class="provider-name">Ollama</span>
                <span class="provider-status" [class.connected]="ollamaConnected()">
                  {{ ollamaConnected() ? 'Connected' : 'Not connected' }}
                </span>
              </button>
              <button class="provider-btn" [class.selected]="provider() === 'claude'"
                      [class.disabled]="!hasClaudeKey()" (click)="selectProvider('claude')">
                <span class="provider-icon">🧠</span>
                <span class="provider-name">Claude</span>
                @if (!hasClaudeKey()) { <span class="provider-status">No API key</span> }
              </button>
              <button class="provider-btn" [class.selected]="provider() === 'openai'"
                      [class.disabled]="!hasOpenAIKey()" (click)="selectProvider('openai')">
                <span class="provider-icon">🤖</span>
                <span class="provider-name">OpenAI</span>
                @if (!hasOpenAIKey()) { <span class="provider-status">No API key</span> }
              </button>
            </div>
          </div>

          <div class="config-section">
            <label class="field-label">Model</label>
            @if (models().length > 0) {
              <desktop-select class="select-input" [options]="modelOptions()"
                              [ngModel]="model()" (ngModelChange)="selectModel($event)" />
            } @else {
              <div class="hint">
                @if (provider() === 'ollama' && !ollamaConnected()) { Ollama is not running. }
                @else { No models are available for this provider. }
              </div>
            }
          </div>

          <div class="config-section">
            <div class="section-line">
              <label class="field-label">Categories</label>
              <span class="field-count">{{ enabledCount() }} of {{ categories().length }}</span>
            </div>
            <div class="category-grid">
              @for (cat of categories(); track cat.id) {
                <button class="category" [class.enabled]="cat.enabled" (click)="toggleCategory(cat.id)"
                        [title]="cat.description">
                  <span class="cat-dot" [style.background]="cat.color"></span>
                  <span class="cat-name">{{ cat.name }}</span>
                </button>
              }
            </div>
          </div>

          @if (target().kind === 'document') {
            <div class="config-section compact">
              <label class="field-label">Scope</label>
              <div class="scope-options">
                <button [class.selected]="!testMode()" (click)="testMode.set(false)">Full book</button>
                @for (count of [5, 10, 20]; track count) {
                  <button [class.selected]="testMode() && testChunks() === count"
                          (click)="testMode.set(true); testChunks.set(count)">
                    {{ count }} chunks
                  </button>
                }
              </div>
            </div>
          }

          @if (error(); as message) { <div class="error" role="alert">{{ message }}</div> }
        </div>

        <footer class="modal-actions">
          <button class="cancel-btn" type="button" (click)="close.emit()">Cancel</button>
          <button class="queue-btn" type="button" [disabled]="!canRun() || queueing()" (click)="run()">
            {{ queueing() ? 'Adding…' : 'Add analysis to queue' }}
          </button>
        </footer>
      </section>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }
    .backdrop { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px;
      background: rgba(5, 8, 14, 0.72); backdrop-filter: blur(8px); }
    .modal { width: min(720px, 96vw); max-height: min(860px, 92vh); display: flex; flex-direction: column;
      overflow: hidden; color: var(--text-primary); background: var(--bg-surface);
      border: 1px solid color-mix(in srgb, var(--accent-primary, #06b6d4) 34%, var(--border-default));
      border-radius: 16px; box-shadow: 0 28px 90px rgba(0,0,0,0.55); }
    .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 20px 22px 14px; }
    .eyebrow { margin-bottom: 3px; color: var(--accent-primary, #06b6d4); font-size: 0.68rem;
      font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; }
    h2 { margin: 0; font-size: 1.22rem; font-weight: 680; letter-spacing: -0.02em; }
    .close-btn { width: 34px; height: 34px; border: 0; border-radius: 8px; cursor: pointer;
      color: var(--text-secondary); background: var(--bg-elevated); }
    .close-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
    .locked-target { margin: 0 22px 4px; padding: 11px 13px; display: flex; align-items: center; gap: 11px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #06b6d4) 28%, var(--border-default));
      border-radius: 10px; background: color-mix(in srgb, var(--accent-primary, #06b6d4) 7%, var(--bg-elevated)); }
    .target-icon { font-size: 1.22rem; }
    .target-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
    .target-copy strong { overflow: hidden; font-size: 0.86rem; text-overflow: ellipsis; white-space: nowrap; }
    .target-kicker { color: var(--text-secondary); font-size: 0.68rem; }
    .modal-body { min-height: 0; overflow-y: auto; padding: 16px 22px 20px; }
    .config-section { margin-bottom: 20px; }
    .config-section.compact { margin-bottom: 4px; }
    .field-label { display: block; margin-bottom: 8px; color: var(--text-primary); font-size: 0.76rem; font-weight: 650; }
    .section-line { display: flex; align-items: baseline; justify-content: space-between; }
    .field-count { color: var(--text-tertiary); font-size: 0.7rem; }
    .hint { padding: 9px 10px; color: var(--text-secondary); font-size: 0.75rem; background: var(--bg-elevated); border-radius: 7px; }
    .provider-buttons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .provider-btn { min-height: 76px; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
      padding: 10px; border: 1px solid var(--border-default); border-radius: 9px; cursor: pointer;
      color: var(--text-primary); background: var(--bg-elevated); text-align: left; }
    .provider-btn:hover { background: var(--bg-hover); }
    .provider-btn.selected { border-color: var(--accent-primary, #06b6d4);
      background: color-mix(in srgb, var(--accent-primary, #06b6d4) 10%, var(--bg-elevated)); }
    .provider-btn.disabled { opacity: 0.48; cursor: default; }
    .provider-icon { font-size: 1.05rem; }
    .provider-name { font-size: 0.78rem; font-weight: 650; }
    .provider-status { color: var(--text-tertiary); font-size: 0.64rem; }
    .provider-status.connected { color: var(--success, #22c55e); }
    .select-input { width: 100%; }
    .category-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
    .category { min-width: 0; display: flex; align-items: center; gap: 7px; padding: 8px 9px;
      border: 1px solid var(--border-default); border-radius: 7px; cursor: pointer;
      color: var(--text-secondary); background: var(--bg-elevated); opacity: 0.52; text-align: left; }
    .category.enabled { opacity: 1; color: var(--text-primary); border-color: color-mix(in srgb, var(--accent-primary, #06b6d4) 66%, var(--border-default)); }
    .cat-dot { width: 9px; height: 9px; flex-shrink: 0; border-radius: 50%; }
    .cat-name { overflow: hidden; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
    .scope-options { display: flex; flex-wrap: wrap; gap: 7px; }
    .scope-options button { padding: 7px 11px; border: 1px solid var(--border-default); border-radius: 7px;
      cursor: pointer; color: var(--text-secondary); background: var(--bg-elevated); font-size: 0.72rem; }
    .scope-options button.selected { color: #fff; border-color: var(--accent-primary, #06b6d4); background: var(--accent-primary, #06b6d4); }
    .error { margin-top: 14px; padding: 9px 11px; border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
      border-radius: 7px; color: #ef4444; background: color-mix(in srgb, #ef4444 8%, transparent); font-size: 0.74rem; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 9px; padding: 14px 22px calc(14px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-default); background: var(--bg-surface); }
    .cancel-btn, .queue-btn { padding: 9px 15px; border-radius: 8px; cursor: pointer; font-size: 0.78rem; font-weight: 650; }
    .cancel-btn { color: var(--text-secondary); border: 1px solid var(--border-default); background: var(--bg-elevated); }
    .queue-btn { color: #fff; border: 1px solid var(--accent-primary, #06b6d4); background: var(--accent-primary, #06b6d4); }
    .queue-btn:disabled { opacity: 0.48; cursor: default; }
    @media (max-width: 620px) {
      .backdrop { padding: 10px; align-items: end; }
      .modal { width: 100%; max-height: 94vh; border-radius: 16px 16px 8px 8px; }
      .provider-buttons, .category-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (prefers-reduced-motion: no-preference) {
      .modal { animation: modal-in 0.16s ease-out; }
      @keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(0.99); } }
    }
  `],
})
export class StudioAnalysisModalComponent {
  private readonly settings = inject(SettingsService);
  private readonly electron = inject(ElectronService);
  private readonly queue = inject(QueueService);
  private analysisSelection: AnalysisAISelection = { provider: 'ollama', models: {} };

  readonly target = input.required<StudioAnalysisTarget>();
  readonly bfpPath = input.required<string>();
  readonly item = input.required<StudioItem>();
  readonly close = output<void>();
  readonly queued = output<void>();

  readonly provider = signal<Exclude<AIProvider, 'local'>>('ollama');
  readonly model = signal('');
  readonly ollamaConnected = signal(false);
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);
  readonly categories = signal<AnalysisCategory[]>(DEFAULT_ANALYSIS_CATEGORIES.map(category => ({ ...category })));
  readonly testMode = signal(false);
  readonly testChunks = signal(5);
  readonly queueing = signal(false);
  readonly error = signal<string | null>(null);

  readonly hasClaudeKey = computed(() => !!this.settings.getAIConfig().claude.apiKey);
  readonly hasOpenAIKey = computed(() => !!this.settings.getAIConfig().openai.apiKey);
  readonly models = computed(() => this.provider() === 'ollama'
    ? this.ollamaModels()
    : this.provider() === 'claude' ? this.claudeModels() : this.openaiModels());
  readonly modelOptions = computed<DesktopSelectItems>(() =>
    this.models().map(entry => ({ value: entry.value, label: entry.label })));
  readonly enabledCount = computed(() => this.categories().filter(category => category.enabled).length);
  readonly canRun = computed(() => !!this.target() && !!this.model() && this.enabledCount() > 0
    && (this.provider() !== 'ollama' || this.ollamaConnected()));

  constructor() {
    void this.initProviders();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (!this.queueing()) this.close.emit(); }

  private async initProviders(): Promise<void> {
    const config = this.settings.getAIConfig();
    this.model.set(config.ollama.model || 'cogito:14b');
    try {
      const response = await fetch(`${config.ollama.baseUrl || 'http://localhost:11434'}/api/tags`).catch(() => null);
      if (response?.ok) {
        this.ollamaConnected.set(true);
        const data = await response.json();
        const models = (data.models || []).map((entry: { name: string }) => ({ value: entry.name, label: entry.name }));
        this.ollamaModels.set(models);
        if (models.length && !models.some((entry: { value: string }) => entry.value === this.model())) {
          this.model.set(models[0].value);
        }
      }
    } catch { /* status remains disconnected */ }
    if (config.claude.apiKey) {
      const result = await this.electron.getClaudeModels(config.claude.apiKey).catch(() => null);
      this.claudeModels.set(result?.success && result.models?.length
        ? result.models
        : [{ value: config.claude.model, label: config.claude.model }]);
    }
    if (config.openai.apiKey) {
      const result = await this.electron.getOpenAIModels(config.openai.apiKey).catch(() => null);
      this.openaiModels.set(result?.success && result.models?.length
        ? result.models
        : [{ value: config.openai.model, label: config.openai.model }]);
    }
    this.analysisSelection = this.loadAnalysisSelection()
      || this.selectionFromLatestAnalysisJob()
      || {
        provider: config.provider === 'claude' || config.provider === 'openai' ? config.provider : 'ollama',
        models: {},
      };
    this.saveAnalysisSelection();
    const preferred = this.analysisSelection.provider === 'claude' && config.claude.apiKey
      ? 'claude'
      : this.analysisSelection.provider === 'openai' && config.openai.apiKey ? 'openai' : 'ollama';
    this.selectProvider(preferred, false);
  }

  selectProvider(provider: AnalysisProvider, persist = true): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;
    this.provider.set(provider);
    const config = this.settings.getAIConfig();
    const configuredModel = this.analysisSelection.models[provider] || config[provider].model;
    const models = provider === 'ollama' ? this.ollamaModels()
      : provider === 'claude' ? this.claudeModels() : this.openaiModels();
    const selectedModel = models.some(entry => entry.value === configuredModel)
      ? configuredModel
      : models[0]?.value || configuredModel || '';
    this.model.set(selectedModel);
    if (persist) this.persistAISelection(provider, selectedModel);
  }

  selectModel(model: string): void {
    if (!this.models().some(entry => entry.value === model)) return;
    this.model.set(model);
    this.persistAISelection(this.provider(), model);
  }

  /** Analysis remembers its own last provider and one model per provider, so a
   * cleanup/translation choice elsewhere does not unexpectedly reset this modal. */
  private persistAISelection(provider: AnalysisProvider, model: string): void {
    this.analysisSelection = {
      provider,
      models: { ...this.analysisSelection.models, [provider]: model },
    };
    this.saveAnalysisSelection();
  }

  private loadAnalysisSelection(): AnalysisAISelection | null {
    try {
      const raw = localStorage.getItem(ANALYSIS_AI_SELECTION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<AnalysisAISelection>;
      if (!this.isAnalysisProvider(parsed.provider) || !parsed.models || typeof parsed.models !== 'object') {
        return null;
      }
      const models: Partial<Record<AnalysisProvider, string>> = {};
      for (const provider of ['ollama', 'claude', 'openai'] as const) {
        const value = parsed.models[provider];
        if (typeof value === 'string' && value.trim()) models[provider] = value;
      }
      return { provider: parsed.provider, models };
    } catch {
      return null;
    }
  }

  /** Migration for selections made before this preference existed. Queue order
   * is chronological, so the final analysis item is the user's last real choice. */
  private selectionFromLatestAnalysisJob(): AnalysisAISelection | null {
    const latest = [...this.queue.jobs()].reverse().find(job => job.type === 'book-analysis');
    const config = latest?.config as { aiProvider?: AIProvider; aiModel?: string } | undefined;
    if (!this.isAnalysisProvider(config?.aiProvider) || typeof config?.aiModel !== 'string' || !config.aiModel.trim()) {
      return null;
    }
    return { provider: config.aiProvider, models: { [config.aiProvider]: config.aiModel } };
  }

  private saveAnalysisSelection(): void {
    try {
      localStorage.setItem(ANALYSIS_AI_SELECTION_KEY, JSON.stringify(this.analysisSelection));
    } catch { /* preference persistence is non-critical */ }
  }

  private isAnalysisProvider(value: unknown): value is AnalysisProvider {
    return value === 'ollama' || value === 'claude' || value === 'openai';
  }

  toggleCategory(id: string): void {
    this.categories.update(categories => categories.map(category =>
      category.id === id ? { ...category, enabled: !category.enabled } : category));
  }

  async run(): Promise<void> {
    if (!this.canRun() || this.queueing()) return;
    const target = this.target();
    const item = this.item();
    if (target.projectId !== studioManifestProjectId(item)) {
      this.error.set('The selected project changed. Close this window and open analysis again.');
      return;
    }
    this.queueing.set(true);
    this.error.set(null);
    try {
      const aiConfig = this.settings.getAIConfig();
      const source = target.kind === 'audiobook'
        ? { kind: 'audiobook' as const, projectId: target.projectId, variantId: target.variantId }
        : { kind: 'document' as const, epubPath: target.path };
      await this.queue.addJob({
        type: 'book-analysis',
        epubPath: source.kind === 'document' ? source.epubPath : undefined,
        bfpPath: this.bfpPath(),
        metadata: { title: item.title, author: item.author || '', year: item.year, coverPath: item.coverPath },
        config: {
          type: 'book-analysis',
          projectDir: this.bfpPath(),
          source,
          aiProvider: this.provider(),
          aiModel: this.model(),
          ollamaBaseUrl: aiConfig.ollama.baseUrl,
          claudeApiKey: aiConfig.claude.apiKey,
          openaiApiKey: aiConfig.openai.apiKey,
          categories: this.categories().filter(category => category.enabled),
          testMode: target.kind === 'document' && this.testMode(),
          testModeChunks: target.kind === 'document' && this.testMode() ? this.testChunks() : undefined,
          target: target.kind === 'document'
            ? { versionId: target.versionId, versionType: target.versionType, versionLabel: target.versionLabel }
            : undefined,
        },
      });
      this.queued.emit();
      this.close.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Analysis could not be added to the queue.');
    } finally {
      this.queueing.set(false);
    }
  }
}

import { Component, inject, input, output, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';
import { ElectronService } from '../../../../core/services/electron.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { QueueService } from '../../../queue/services/queue.service';
import { AIProvider } from '../../../../core/models/ai-config.types';
import { StudioItem } from '../../models/studio.types';

interface VersionRow {
  id: string; type: string; label: string; description: string;
  path: string; extension: string; language?: string;
  modifiedAt?: string; fileSize?: number; editable: boolean; icon: string;
}

interface AnalysisCategory { id: string; name: string; description: string; color: string; enabled: boolean; }
interface SourceStage { id: string; label: string; completed: boolean; path: string; }

/**
 * StudioInsightsComponent - the "Insights" surface of the book view.
 *
 * Analysis is a different function from cleanup/TTS, so it lives here instead
 * of inside the processing pipeline. Pick a version + AI provider + categories,
 * run the existing book-analysis job, and view the resulting report (the PDF
 * editor highlights the flags when opened on a project with a report).
 * Also hosts the job performance history (TTS/cleanup analytics).
 *
 * Controls intentionally mirror the pipeline wizard's (stage buttons,
 * provider buttons, worker buttons) so the two surfaces feel like one app.
 */
@Component({
  selector: 'app-studio-insights',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopSelectComponent],
  template: `
    <div class="insights">
      <!-- Existing report -->
      @if (report(); as rep) {
        <div class="report-card">
          <div class="report-head">
            <span class="report-icon">🔍</span>
            <div class="report-info">
              <div class="report-title">Analysis report</div>
              <div class="report-desc">{{ rep.description }}{{ rep.modifiedAt ? ' · ' + fmtDate(rep.modifiedAt) : '' }}</div>
            </div>
            <button class="run-btn small" (click)="viewReport.emit()">View in editor</button>
          </div>
        </div>
      }

      <h4 class="section-title">{{ report() ? 'Run again' : 'Run analysis' }}</h4>
      <p class="section-desc">Analyze a version for rhetorical manipulation, propaganda techniques, and problematic patterns.</p>

      <!-- Source version (same stage buttons as the pipeline) -->
      <div class="config-section">
        <label class="field-label">Version to analyze</label>
        <div class="source-stages">
          @for (stage of sourceStages(); track stage.id) {
            <button
              class="stage-btn"
              [class.selected]="isStageSelected(stage)"
              [class.completed]="stage.completed"
              [disabled]="!stage.completed"
              (click)="selectStage(stage)"
            >
              {{ stage.label }}
              @if (stage.completed) {
                <span class="stage-check">&#10003;</span>
              }
            </button>
          }
        </div>
        <span class="hint">"Latest" picks the most recently modified version automatically.</span>
      </div>

      <!-- Provider -->
      <div class="config-section">
        <label class="field-label">AI Provider</label>
        <div class="provider-buttons">
          <button
            class="provider-btn"
            [class.selected]="provider() === 'ollama'"
            [class.connected]="provider() === 'ollama' && ollamaConnected()"
            (click)="selectProvider('ollama')"
          >
            <span class="provider-icon">🦙</span>
            <span class="provider-name">Ollama</span>
            @if (provider() === 'ollama') {
              <span class="provider-status" [class.connected]="ollamaConnected()">
                {{ ollamaConnected() ? 'Connected' : 'Not connected' }}
              </span>
            }
          </button>
          <button
            class="provider-btn"
            [class.selected]="provider() === 'claude'"
            [class.disabled]="!hasClaudeKey()"
            (click)="selectProvider('claude')"
          >
            <span class="provider-icon">🧠</span>
            <span class="provider-name">Claude</span>
            @if (!hasClaudeKey()) {
              <span class="provider-status">No API key</span>
            }
          </button>
          <button
            class="provider-btn"
            [class.selected]="provider() === 'openai'"
            [class.disabled]="!hasOpenAIKey()"
            (click)="selectProvider('openai')"
          >
            <span class="provider-icon">🤖</span>
            <span class="provider-name">OpenAI</span>
            @if (!hasOpenAIKey()) {
              <span class="provider-status">No API key</span>
            }
          </button>
        </div>
      </div>

      <!-- Model -->
      <div class="config-section">
        <label class="field-label">Model</label>
        @if (models().length > 0) {
          <desktop-select
            class="select-input"
            [options]="modelOptions()"
            [ngModel]="model()"
            (ngModelChange)="model.set($event)"
          />
        } @else {
          <div class="hint">
            @if (provider() === 'ollama' && !ollamaConnected()) { Ollama not running. }
            @else { No models available — configure the provider in Settings. }
          </div>
        }
      </div>

      <!-- Categories -->
      <div class="config-section">
        <label class="field-label">Categories ({{ enabledCount() }} of {{ categories().length }})</label>
        <div class="category-grid">
          @for (cat of categories(); track cat.id) {
            <button class="category" [class.enabled]="cat.enabled" (click)="toggleCategory(cat.id)" [title]="cat.description">
              <span class="cat-dot" [style.background]="cat.color"></span>
              <span class="cat-name">{{ cat.name }}</span>
            </button>
          }
        </div>
      </div>

      <!-- Test mode (same worker buttons as the pipeline) -->
      <div class="config-section">
        <label class="field-label">Test Mode</label>
        <div class="worker-options">
          <button class="worker-btn" [class.selected]="!testMode()" (click)="testMode.set(false)">Full</button>
          @for (count of [5, 10, 20]; track count) {
            <button class="worker-btn" [class.selected]="testMode() && testChunks() === count" (click)="testMode.set(true); testChunks.set(count)">
              {{ count }}
            </button>
          }
        </div>
        <span class="hint">Test mode analyzes only the first N chunks</span>
      </div>

      <button
        class="run-btn"
        [class.added]="queuedOk()"
        [disabled]="!canRun() || queueing() || queuedOk()"
        (click)="run()"
      >
        @if (queueing()) { Adding… }
        @else if (queuedOk()) { ✓ Added to queue }
        @else { Run analysis }
      </button>

    </div>
  `,
  styles: [`
    .insights { padding: 4px 2px 28px; max-width: 760px; }
    .report-card {
      border: 1px solid var(--border-default, rgba(255,255,255,0.1));
      background: var(--bg-elevated); border-radius: 8px;
      padding: 12px 14px; margin-bottom: 20px;
    }
    .report-head { display: flex; align-items: center; gap: 12px; }
    .report-icon { font-size: 1.4rem; }
    .report-info { flex: 1; min-width: 0; }
    .report-title { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); }
    .report-desc { font-size: 0.76rem; color: var(--text-secondary); margin-top: 2px; }
    .section-title { margin: 0 0 4px; font-size: 0.95rem; color: var(--text-primary); }
    .section-title.perf { margin-top: 32px; }
    .section-desc { margin: 0 0 16px; font-size: 0.8rem; color: var(--text-secondary); }
    .config-section { margin-bottom: 16px; }
    .field-label {
      display: block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px;
    }
    .hint { display: block; margin-top: 6px; font-size: 0.74rem; color: var(--text-secondary); }

    /* Stage buttons — same look as the pipeline wizard */
    .source-stages { display: flex; gap: 6px; flex-wrap: wrap; }
    .stage-btn {
      padding: 6px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex; align-items: center; gap: 4px;
    }
    .stage-btn .stage-check { color: #22c55e; font-size: 11px; }
    .stage-btn:hover:not(:disabled) { background: var(--bg-hover); }
    .stage-btn.selected {
      background: rgba(6, 182, 212, 0.15);
      border-color: #06b6d4;
      color: #06b6d4;
    }
    .stage-btn.selected .stage-check { color: #06b6d4; }
    .stage-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* Provider buttons — same look as the pipeline wizard */
    .provider-buttons { display: flex; gap: 8px; max-width: 480px; }
    .provider-btn {
      flex: 1;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      color: var(--text-primary);
    }
    .provider-btn .provider-icon { font-size: 1.5rem; }
    .provider-btn .provider-name { font-size: 12px; font-weight: 500; color: var(--text-primary); }
    .provider-btn .provider-status { font-size: 10px; color: var(--text-muted); }
    .provider-btn .provider-status.connected { color: #22c55e; }
    .provider-btn:hover:not(.disabled) { background: var(--bg-hover); border-color: var(--border-default); }
    .provider-btn.selected { background: rgba(6, 182, 212, 0.15); border-color: #06b6d4; }
    .provider-btn.selected .provider-name { color: #06b6d4; }
    .provider-btn.disabled { opacity: 0.5; cursor: not-allowed; }

    /* Worker buttons — same look as the pipeline wizard */
    .worker-options { display: flex; gap: 8px; }
    .worker-btn {
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .worker-btn:hover { background: var(--bg-hover); }
    .worker-btn.selected { background: rgba(6, 182, 212, 0.15); border-color: #06b6d4; color: #06b6d4; }

    .select-input {
      width: 100%; max-width: 420px; padding: 8px 10px;
      background: var(--bg-elevated); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12)); border-radius: 6px;
      font-size: 0.84rem;
    }
    .category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
    .category {
      display: flex; align-items: center; gap: 8px; padding: 7px 10px;
      background: var(--bg-elevated); border: 1px solid var(--border-default, rgba(255,255,255,0.1));
      border-radius: 6px; cursor: pointer; color: var(--text-secondary); opacity: 0.55;
      font-size: 0.78rem; text-align: left;
      transition: all 0.15s ease;
    }
    .category.enabled { opacity: 1; color: var(--text-primary); border-color: #06b6d4; background: rgba(6, 182, 212, 0.08); }
    .cat-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-btn {
      margin-top: 6px; padding: 10px 22px; border: none; border-radius: 7px;
      background: var(--accent-primary, #06b6d4); color: #fff;
      font-size: 0.88rem; font-weight: 600; cursor: pointer;
    }
    .run-btn.small { padding: 7px 14px; font-size: 0.8rem; margin-top: 0; }
    .run-btn:disabled { opacity: 0.55; cursor: default; }
    .run-btn.added { background: var(--success, #22c55e); }
  `]
})
export class StudioInsightsComponent {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly queue = inject(QueueService);

  readonly bfpPath = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);

  readonly viewReport = output<void>();   // open the editor (it highlights the report's flags)
  readonly queued = output<void>();

  readonly versions = signal<VersionRow[]>([]);
  readonly sourcePath = signal<string>('latest');
  readonly provider = signal<AIProvider>('ollama');
  readonly model = signal<string>('');
  readonly ollamaConnected = signal(false);
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);
  readonly testMode = signal(false);
  readonly testChunks = signal(5);
  readonly queueing = signal(false);
  readonly queuedOk = signal(false);

  readonly categories = signal<AnalysisCategory[]>([
    { id: 'thought_control', name: 'Thought Control', color: '#E53935', enabled: true, description: 'Discouraging critical thinking, independent thought, or questioning authority; demanding blind obedience' },
    { id: 'information_control', name: 'Information Control', color: '#1565C0', enabled: true, description: 'Discouraging outside sources; labeling criticism as persecution; controlling what members read/watch' },
    { id: 'us_vs_them', name: 'Us vs. Them', color: '#FB8C00', enabled: true, description: 'In-group/out-group divisions; dehumanizing outsiders; framing the world as hostile' },
    { id: 'fear_manipulation', name: 'Fear & Doom', color: '#7B1FA2', enabled: true, description: 'Apocalyptic fearmongering; divine punishment threats; urgency through fear' },
    { id: 'loaded_language', name: 'Loaded Language', color: '#00838F', enabled: true, description: 'Thought-terminating cliches; euphemisms masking harmful practices; jargon replacing critical thinking' },
    { id: 'emotional_manipulation', name: 'Emotional Manipulation', color: '#C62828', enabled: true, description: 'Guilt-tripping; love-bombing; shaming; exploiting grief or vulnerability' },
    { id: 'authority_claims', name: 'Authority Claims', color: '#4527A0', enabled: true, description: 'Claiming divine mandate; unquestionable leadership; special revelation' },
    { id: 'historical_revisionism', name: 'Historical Revisionism', color: '#2E7D32', enabled: true, description: 'Rewriting history; false narratives; cherry-picking facts; pseudohistory' },
    { id: 'scapegoating', name: 'Scapegoating', color: '#D84315', enabled: true, description: 'Blaming specific groups; conspiracy theories about minorities; racial/ethnic targeting' },
    { id: 'violence_glorification', name: 'Violence & Extremism', color: '#B71C1C', enabled: true, description: 'Justifying violence; martyrdom ideology; eliminationist rhetoric' },
    { id: 'false_prophecy', name: 'False Prophecy', color: '#8E24AA', enabled: true, description: 'Failed predictions presented as divine truth; date-setting; unfalsifiable claims' },
    { id: 'shunning', name: 'Shunning & Isolation', color: '#6D4C41', enabled: true, description: 'Social isolation tactics; cutting off family/friends; punishment for leaving' },
  ]);

  readonly report = computed(() => this.versions().find(v => v.type === 'analysis') ?? null);

  /** Whole-book EPUB versions (per-language bilingual EPUBs excluded) */
  readonly wholeBookVersions = computed(() =>
    this.versions().filter(v =>
      v.type !== 'analysis' && (v.extension || '').toLowerCase() === 'epub' && !v.language));

  /** Stage buttons mirroring the pipeline wizard's Source EPUB row */
  readonly sourceStages = computed<SourceStage[]>(() => {
    const find = (type: string) => this.wholeBookVersions().find(v => v.type === type);
    return [
      { id: 'original', label: 'Original', completed: !!find('original'), path: find('original')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported'), path: find('exported')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned'), path: find('cleaned')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified'), path: find('simplified')?.path ?? '' },
      { id: 'translated', label: 'Translated', completed: !!find('translated'), path: find('translated')?.path ?? '' },
    ];
  });

  /** "Latest" = most recently modified whole-book EPUB */
  readonly latestVersion = computed(() => {
    const candidates = this.wholeBookVersions();
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) =>
      new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime())[0];
  });

  readonly hasClaudeKey = computed(() => !!this.settings.getAIConfig().claude.apiKey);
  readonly hasOpenAIKey = computed(() => !!this.settings.getAIConfig().openai.apiKey);

  readonly models = computed(() => {
    const p = this.provider();
    if (p === 'ollama') return this.ollamaModels();
    if (p === 'claude') return this.claudeModels();
    return this.openaiModels();
  });

  readonly modelOptions = computed<DesktopSelectItems>(() =>
    this.models().map(m => ({ value: m.value, label: m.label })));

  readonly enabledCount = computed(() => this.categories().filter(c => c.enabled).length);

  readonly canRun = computed(() =>
    this.enabledCount() > 0 && !!this.model() && !!this.resolveSource() &&
    (this.provider() !== 'ollama' || this.ollamaConnected()));

  constructor() {
    effect(() => { this.bfpPath(); this.refreshTrigger(); void this.load(); });
    void this.initProviders();
  }

  private async load(): Promise<void> {
    const bfp = this.bfpPath();
    this.queuedOk.set(false);
    this.sourcePath.set('latest');
    if (!bfp) { this.versions.set([]); return; }
    const res = await this.electron.editorGetVersions(bfp);
    this.versions.set(res.success && res.versions ? res.versions as VersionRow[] : []);
    // Job performance history now lives in the dedicated Analytics tab
    // (studio.component → app-analytics-panel), not here. Insights = content analysis.
  }

  private async initProviders(): Promise<void> {
    const config = this.settings.getAIConfig();
    this.model.set(config.ollama.model || 'cogito:14b');

    try {
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      if (response?.ok) {
        this.ollamaConnected.set(true);
        const data = await response.json();
        const models = (data.models || []).map((m: { name: string }) => ({ value: m.name, label: m.name }));
        this.ollamaModels.set(models);
        if (models.length && !models.some((m: any) => m.value === this.model())) {
          this.model.set(models.find((m: any) => m.value === 'cogito:14b')?.value ?? models[0].value);
        }
      }
    } catch { /* ollama not running */ }

    if (config.claude.apiKey) {
      const result = await this.electron.getClaudeModels(config.claude.apiKey).catch(() => null);
      if (result?.success && result.models) this.claudeModels.set(result.models);
    }
    if (config.openai.apiKey) {
      const result = await this.electron.getOpenAIModels(config.openai.apiKey).catch(() => null);
      if (result?.success && result.models) this.openaiModels.set(result.models);
    }
  }

  isStageSelected(stage: SourceStage): boolean {
    const source = this.sourcePath();
    if (source === 'latest') {
      return stage.id === (this.latestVersion()?.type ?? '');
    }
    return source === stage.path;
  }

  /** Clicking the auto-selected stage returns to 'latest', like the wizard */
  selectStage(stage: SourceStage): void {
    const current = this.sourcePath();
    if (current === stage.path || (current === 'latest' && stage.id === (this.latestVersion()?.type ?? ''))) {
      this.sourcePath.set('latest');
    } else {
      this.sourcePath.set(stage.path);
    }
  }

  selectProvider(p: AIProvider): void {
    if (p === 'claude' && !this.hasClaudeKey()) return;
    if (p === 'openai' && !this.hasOpenAIKey()) return;
    if (p === this.provider()) return;
    this.provider.set(p);
    const models = p === 'ollama' ? this.ollamaModels() : p === 'claude' ? this.claudeModels() : this.openaiModels();
    const saved = (this.settings.getAIConfig() as any)[p]?.model;
    this.model.set(models.some(m => m.value === saved) ? saved : (models[0]?.value ?? ''));
  }

  toggleCategory(id: string): void {
    this.categories.update(cats => cats.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));
  }

  private resolveSource(): string {
    const picked = this.sourcePath();
    if (picked !== 'latest') return picked;
    return this.latestVersion()?.path ?? '';
  }

  async run(): Promise<void> {
    if (!this.canRun()) return;
    this.queueing.set(true);
    try {
      const aiConfig = this.settings.getAIConfig();
      await this.queue.addJob({
        type: 'book-analysis',
        epubPath: this.resolveSource(),
        bfpPath: this.bfpPath(),
        metadata: { title: 'Content Analysis' },
        config: {
          type: 'book-analysis',
          projectDir: this.bfpPath(),
          aiProvider: this.provider(),
          aiModel: this.model(),
          ollamaBaseUrl: aiConfig.ollama?.baseUrl,
          claudeApiKey: aiConfig.claude?.apiKey,
          openaiApiKey: aiConfig.openai?.apiKey,
          categories: this.categories().filter(c => c.enabled),
          testMode: this.testMode(),
          testModeChunks: this.testMode() ? this.testChunks() : undefined,
        },
      });
      this.queuedOk.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[Insights] Failed to queue analysis:', err);
    } finally {
      this.queueing.set(false);
    }
  }

  fmtDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleString();
  }
}

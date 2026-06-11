import { Component, inject, input, output, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
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

/**
 * StudioInsightsComponent - the "Insights" surface of the book view.
 *
 * Analysis is a different function from cleanup/TTS, so it lives here instead
 * of inside the processing pipeline. Pick a version + AI provider + categories,
 * run the existing book-analysis job, and view the resulting report (the PDF
 * editor highlights the flags when opened on a project with a report).
 */
@Component({
  selector: 'app-studio-insights',
  standalone: true,
  imports: [CommonModule],
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
            <button class="act primary" (click)="viewReport.emit()">View in editor</button>
          </div>
        </div>
      }

      <h4 class="section-title">{{ report() ? 'Run again' : 'Run analysis' }}</h4>
      <p class="section-desc">Analyze a version for rhetorical manipulation, propaganda techniques, and problematic patterns.</p>

      <!-- Source version -->
      <div class="config-section">
        <label class="field-label">Version to analyze</label>
        <select class="select-input" [value]="sourcePath()" (change)="sourcePath.set($any($event.target).value)">
          <option value="latest">Latest ({{ latestLabel() }})</option>
          @for (v of epubVersions(); track v.id) {
            <option [value]="v.path">{{ v.label }}</option>
          }
        </select>
      </div>

      <!-- Provider -->
      <div class="config-section">
        <label class="field-label">AI Provider</label>
        <div class="provider-row">
          <button class="pill" [class.selected]="provider() === 'ollama'" (click)="selectProvider('ollama')">
            Ollama {{ provider() === 'ollama' ? (ollamaConnected() ? '· connected' : '· not running') : '' }}
          </button>
          <button class="pill" [class.selected]="provider() === 'claude'" [disabled]="!hasClaudeKey()" (click)="selectProvider('claude')">
            Claude {{ hasClaudeKey() ? '' : '· no key' }}
          </button>
          <button class="pill" [class.selected]="provider() === 'openai'" [disabled]="!hasOpenAIKey()" (click)="selectProvider('openai')">
            OpenAI {{ hasOpenAIKey() ? '' : '· no key' }}
          </button>
        </div>
      </div>

      <!-- Model -->
      <div class="config-section">
        <label class="field-label">Model</label>
        @if (models().length > 0) {
          <select class="select-input" [value]="model()" (change)="model.set($any($event.target).value)">
            @for (m of models(); track m.value) {
              <option [value]="m.value" [selected]="m.value === model()">{{ m.label }}</option>
            }
          </select>
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

      <!-- Test mode -->
      <div class="config-section">
        <label class="field-label">Scope</label>
        <div class="provider-row">
          <button class="pill" [class.selected]="!testMode()" (click)="testMode.set(false)">Full book</button>
          @for (count of [5, 10, 20]; track count) {
            <button class="pill" [class.selected]="testMode() && testChunks() === count" (click)="testMode.set(true); testChunks.set(count)">
              First {{ count }} chunks
            </button>
          }
        </div>
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
    .section-desc { margin: 0 0 16px; font-size: 0.8rem; color: var(--text-secondary); }
    .config-section { margin-bottom: 16px; }
    .field-label {
      display: block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px;
    }
    .select-input {
      width: 100%; max-width: 420px; padding: 8px 10px;
      background: var(--bg-elevated); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12)); border-radius: 6px;
      font-size: 0.84rem;
    }
    .provider-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill {
      padding: 7px 14px; border-radius: 6px; font-size: 0.8rem; cursor: pointer;
      background: var(--bg-elevated); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
    }
    .pill.selected { background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff; }
    .pill:disabled { opacity: 0.45; cursor: default; }
    .category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
    .category {
      display: flex; align-items: center; gap: 8px; padding: 7px 10px;
      background: var(--bg-elevated); border: 1px solid var(--border-default, rgba(255,255,255,0.1));
      border-radius: 6px; cursor: pointer; color: var(--text-secondary); opacity: 0.55;
      font-size: 0.78rem; text-align: left;
    }
    .category.enabled { opacity: 1; color: var(--text-primary); border-color: rgba(255,255,255,0.25); }
    .cat-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { font-size: 0.78rem; color: var(--text-secondary); }
    .run-btn {
      margin-top: 6px; padding: 10px 22px; border: none; border-radius: 7px;
      background: var(--accent-primary, #06b6d4); color: #fff;
      font-size: 0.88rem; font-weight: 600; cursor: pointer;
    }
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
  readonly epubVersions = computed(() =>
    this.versions().filter(v => v.type !== 'analysis' && (v.extension || '').toLowerCase() === 'epub'));

  /** "Latest" = most recently modified non-per-language EPUB (whole-book versions only) */
  readonly latestVersion = computed(() => {
    const candidates = this.epubVersions().filter(v => !v.language);
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) =>
      new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime())[0];
  });
  readonly latestLabel = computed(() => this.latestVersion()?.label ?? 'no EPUB found');

  readonly hasClaudeKey = computed(() => !!this.settings.getAIConfig().claude.apiKey);
  readonly hasOpenAIKey = computed(() => !!this.settings.getAIConfig().openai.apiKey);

  readonly models = computed(() => {
    const p = this.provider();
    if (p === 'ollama') return this.ollamaModels();
    if (p === 'claude') return this.claudeModels();
    return this.openaiModels();
  });

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
    if (!bfp) { this.versions.set([]); return; }
    const res = await this.electron.editorGetVersions(bfp);
    this.versions.set(res.success && res.versions ? res.versions as VersionRow[] : []);
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

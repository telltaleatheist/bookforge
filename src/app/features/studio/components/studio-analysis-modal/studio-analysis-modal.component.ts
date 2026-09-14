import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { QueueService } from '../../../queue/services/queue.service';
import { AIProvider, isAIProvider } from '../../../../core/models/ai-config.types';
import { capabilityWords } from '../../../settings/components/crucible-words';
import type { CrucibleCapabilityView } from '@shared/crucible/settings-wire';
import { StudioItem } from '../../models/studio.types';
import { AnalysisCategory, DEFAULT_ANALYSIS_CATEGORIES } from '../../analysis-categories';
import { StudioAnalysisTarget, studioManifestProjectId } from '../../analysis-target';

/*
 * `AnalysisProvider` IS DELETED (2026-09-14).
 *
 * It named the three this modal had a model list and a credential for —
 * Ollama, Claude and OpenAI — and all three left BookForge the same day. What
 * is left is `AIProvider` itself: the modal supports both of the two, so a
 * narrowing of it would only be a list to forget to update.
 */

/**
 * Which provider analysis last ran on. The MODEL is no longer remembered
 * beside it: neither survivor's model is this modal's to name, so there is
 * nothing per-provider left to carry.
 */
interface AnalysisAISelection {
  provider: AIProvider;
}

const ANALYSIS_AI_SELECTION_KEY = 'bookforge-analysis-ai-selection';

@Component({
  selector: 'app-studio-analysis-modal',
  standalone: true,
  imports: [CommonModule],
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
              <button class="provider-btn" [class.selected]="provider() === 'crucible'"
                      [class.disabled]="!crucibleServer()" (click)="selectProvider('crucible')">
                <span class="provider-icon">📡</span>
                <span class="provider-name">GPU engine (Crucible)</span>
                <span class="provider-status">{{ crucibleServer() || 'No engine chosen' }}</span>
              </button>
              <button class="provider-btn" [class.selected]="provider() === 'local'"
                      (click)="selectProvider('local')">
                <span class="provider-icon">💻</span>
                <span class="provider-name">Bundled local</span>
                <span class="provider-status">Runs on this machine</span>
              </button>
            </div>
          </div>

          <div class="config-section">
            <label class="field-label">Model</label>
            <div class="hint">{{ modelLine() }}</div>
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
    .provider-buttons { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
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
  private analysisSelection: AnalysisAISelection = { provider: 'local' };

  readonly target = input.required<StudioAnalysisTarget>();
  readonly projectDir = input.required<string>();
  readonly item = input.required<StudioItem>();
  readonly close = output<void>();
  readonly queued = output<void>();

  readonly provider = signal<AIProvider>('local');
  readonly categories = signal<AnalysisCategory[]>(DEFAULT_ANALYSIS_CATEGORIES.map(category => ({ ...category })));
  readonly testMode = signal(false);
  readonly testChunks = signal(5);
  readonly queueing = signal(false);
  readonly error = signal<string | null>(null);

  /*
   * `model`, `ollamaConnected`, `ollamaModels`, `claudeModels`,
   * `openaiModels`, `hasClaudeKey`, `hasOpenAIKey`, `models`, `modelOptions`
   * and `selectModel` ARE DELETED (2026-09-14) — with the two fetches that
   * filled the cloud lists using keys this app no longer holds. Neither
   * surviving provider has a model for this modal to pick.
   */

  /** The engine's capability record, or null before it has been asked for. */
  readonly capability = signal<CrucibleCapabilityView | null>(null);

  /** The engine this app is pointed at, or '' when none has been chosen. */
  readonly crucibleServer = computed(() => this.settings.getAIConfig().crucible?.server ?? '');

  /** THE MODEL, as its owner states it. Never a control. */
  readonly modelLine = computed(() => {
    if (this.provider() === 'local') return 'The bundled local model.';
    if (!this.crucibleServer()) return 'No engine chosen yet — pick one in Settings → AI.';
    return capabilityWords(this.capability(), 'analysis');
  });

  readonly enabledCount = computed(() => this.categories().filter(category => category.enabled).length);
  readonly canRun = computed(() => !!this.target() && this.enabledCount() > 0
    && (this.provider() === 'local' || !!this.crucibleServer()));

  constructor() {
    void this.initProviders();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (!this.queueing()) this.close.emit(); }

  private async initProviders(): Promise<void> {
    const config = this.settings.getAIConfig();
    this.analysisSelection = this.loadAnalysisSelection()
      || this.selectionFromLatestAnalysisJob()
      || { provider: config.provider };
    this.saveAnalysisSelection();
    // An engine remembered from last time that nobody has chosen since is not
    // a runnable choice, so the modal opens on the one that always runs.
    const preferred: AIProvider =
      this.analysisSelection.provider === 'crucible' && this.crucibleServer() ? 'crucible' : 'local';
    this.selectProvider(preferred, false);
    await this.loadCapability();
  }

  private async loadCapability(): Promise<void> {
    const server = this.crucibleServer();
    if (!server) return;
    const res = await this.electron.crucible.capability(server);
    // Never an empty record on failure — an empty class list reads as "this
    // engine serves nothing", which is a different and false claim.
    if (res.success && res.data) this.capability.set(res.data);
  }

  selectProvider(provider: AIProvider, persist = true): void {
    if (provider === 'crucible' && !this.crucibleServer()) return;
    this.provider.set(provider);
    if (persist) this.persistAISelection(provider);
  }

  /** Analysis remembers its own last provider, so a cleanup/translation choice
   * elsewhere does not unexpectedly reset this modal. */
  private persistAISelection(provider: AIProvider): void {
    this.analysisSelection = { provider };
    this.saveAnalysisSelection();
  }

  /**
   * The stored preference, or null when there is none to read.
   *
   * A blob written before 2026-09-14 names one of the three retired providers
   * and carries a `models` map beside it. It is REFUSED rather than migrated:
   * this is a modal's convenience preference, not a setting anybody typed, so
   * the honest answer is that there is no remembered choice and the next one
   * the user makes becomes it.
   */
  private loadAnalysisSelection(): AnalysisAISelection | null {
    try {
      const raw = localStorage.getItem(ANALYSIS_AI_SELECTION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<AnalysisAISelection>;
      if (!isAIProvider(parsed.provider)) return null;
      return { provider: parsed.provider };
    } catch {
      return null;
    }
  }

  /** Migration for selections made before this preference existed. Queue order
   * is chronological, so the final analysis item is the user's last real choice. */
  private selectionFromLatestAnalysisJob(): AnalysisAISelection | null {
    const latest = [...this.queue.jobs()].reverse().find(job => job.type === 'book-analysis');
    const config = latest?.config as { aiProvider?: AIProvider } | undefined;
    if (!isAIProvider(config?.aiProvider)) return null;
    return { provider: config.aiProvider };
  }

  private saveAnalysisSelection(): void {
    try {
      localStorage.setItem(ANALYSIS_AI_SELECTION_KEY, JSON.stringify(this.analysisSelection));
    } catch { /* preference persistence is non-critical */ }
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
      const source = target.kind === 'audiobook'
        ? { kind: 'audiobook' as const, projectId: target.projectId, variantId: target.variantId }
        : { kind: 'document' as const, epubPath: target.path };
      await this.queue.addJob({
        type: 'book-analysis',
        epubPath: source.kind === 'document' ? source.epubPath : undefined,
        bfpPath: this.projectDir(),
        metadata: { title: item.title, author: item.author || '', year: item.year, coverPath: item.coverPath },
        config: {
          type: 'book-analysis',
          projectDir: this.projectDir(),
          source,
          aiProvider: this.provider(),
          // Empty because neither provider's model is this modal's to name:
          // the engine's is its capability record and the bundled one is the
          // active local model.
          aiModel: '',
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

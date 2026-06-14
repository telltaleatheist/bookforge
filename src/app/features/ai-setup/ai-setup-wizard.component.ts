import { Component, OnInit, OnDestroy, inject, signal, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { AiService, LocalModel, LocalSystemInfo, LocalModelProgress } from '../../core/services/ai.service';
import { SettingsService } from '../../core/services/settings.service';
import { ElectronService } from '../../core/services/electron.service';

/**
 * AI Setup wizard (WS2). One page, three sources of AI for OCR cleanup:
 *   • Bundled local AI (llama.cpp) — download a Cogito model, hardware-recommended.
 *   • Ollama — detected if running; configured in Settings → AI.
 *   • API key (Claude / OpenAI) — entered inline, saved to settings.
 *
 * Reachable from the nav rail (/ai-setup) and surfaced on first run by
 * onboarding. AI is optional — cleanup can always be skipped.
 */
@Component({
  selector: 'app-ai-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="wizard" [class.embedded]="embedded()">
      @if (!embedded()) {
        <header class="wizard-head">
          <div class="head-icon">&#129302;</div>
          <div>
            <h1>Set up AI</h1>
            <p class="sub">
              AI cleanup is optional — it tidies OCR text before narration. Pick one
              source below. You can always skip cleanup entirely.
            </p>
          </div>
        </header>
      }

      <!-- Availability banner -->
      <div class="status-banner" [class.ok]="ai.available()">
        @if (ai.available()) {
          <span class="dot ok"></span>
          <span>AI is ready. {{ activeSummary() }}</span>
        } @else {
          <span class="dot"></span>
          <span>No AI configured yet. Set up one of the options below.</span>
        }
      </div>

      <!-- ── Bundled local AI ── -->
      <section class="card">
        <div class="card-head">
          <h2>&#128187; Bundled local AI</h2>
          <span class="tag">Runs offline · free · private</span>
        </div>

        @if (localStatus()?.binaryPresent === false) {
          <p class="muted">
            The local AI engine isn't included in this build. Use Ollama or an API
            key below, or install a build that bundles the engine.
          </p>
        } @else {
          @if (sysInfo(); as info) {
            <p class="muted hw">
              This machine: {{ info.totalRamGB }} GB RAM<!--
              -->@if (info.cuda) {, {{ info.cudaName || 'GPU' }} ({{ info.vramGB }} GB VRAM)}.
              Recommended: <strong>{{ modelName(info.recommendedModelId) }}</strong>.
            </p>
          }

          <div class="models">
            @for (m of models(); track m.id) {
              <div class="model" [class.active]="m.isActive" [class.too-big]="!m.fits">
                <div class="model-info">
                  <div class="model-name">
                    {{ m.name }}
                    @if (m.recommended) { <span class="badge rec">Recommended</span> }
                    @if (m.isActive) { <span class="badge active">In use</span> }
                    @if (!m.fits) { <span class="badge warn">Large for your hardware</span> }
                  </div>
                  <div class="model-meta">{{ m.sizeGB }} GB · needs ~{{ m.minRAM }} GB RAM · {{ m.description }}</div>
                  @if (!m.fits) {
                    <div class="model-warn">⚠ Bigger than this machine can fully fit — it’ll run partly on the CPU and be slow. You can still use it.</div>
                  }

                  @if (progressFor(m.id); as p) {
                    <div class="progress">
                      <div class="bar"><div class="fill" [style.width.%]="p.pct"></div></div>
                      <div class="progress-meta">
                        {{ p.pct }}%@if (p.speed) { · {{ p.speed }}}@if (p.eta) { · {{ p.eta }} left}
                      </div>
                    </div>
                  }
                </div>

                <div class="model-actions">
                  @if (progressFor(m.id)) {
                    <desktop-button variant="ghost" size="sm" (click)="cancel(m.id)">Cancel</desktop-button>
                  } @else if (m.downloaded) {
                    @if (!m.isActive) {
                      <desktop-button variant="primary" size="sm" (click)="useModel(m.id)">Use</desktop-button>
                    }
                    <desktop-button variant="ghost" size="sm" (click)="remove(m.id)">Delete</desktop-button>
                  } @else {
                    <desktop-button variant="primary" size="sm" [disabled]="anyDownloading()" (click)="download(m.id)">
                      Download
                    </desktop-button>
                  }
                </div>
              </div>
            }
          </div>

          @if (localStatus()?.anyModelDownloaded && !usingLocal()) {
            <div class="use-row">
              <desktop-button variant="primary" (click)="setProvider('local')">Use local AI for cleanup</desktop-button>
            </div>
          }

          @if (downloadedModels().length > 0) {
            <div class="danger-row">
              @if (confirmDeleteModels()) {
                <span class="danger-confirm">
                  Delete {{ downloadedModels().length }} downloaded model{{ downloadedModels().length === 1 ? '' : 's' }}?
                  <desktop-button variant="ghost" size="sm" (click)="deleteAllModels()">Delete</desktop-button>
                  <desktop-button variant="ghost" size="sm" (click)="confirmDeleteModels.set(false)">Cancel</desktop-button>
                </span>
              } @else {
                <button class="link-danger" (click)="confirmDeleteModels.set(true)">Delete all downloaded models</button>
              }
            </div>
          }
        }
      </section>

      <!-- ── Ollama ── -->
      <section class="card">
        <div class="card-head">
          <h2>&#129422; Ollama</h2>
          <span class="tag">Bring your own local models</span>
        </div>
        @if (ai.ollamaConnected()) {
          <p class="muted">
            Ollama is running@if (ai.ollamaHasModels()) {  with models installed}@else {, but no models are pulled yet}.
            Its models appear in the model picker on the cleanup/translate steps.
          </p>
        } @else {
          <p class="muted">Ollama isn't running. Install it, then pull a model (e.g. <code>ollama pull cogito</code>).</p>
        }
        <div class="ollama-url-row">
          <label class="ollama-url-label">Server URL</label>
          <input
            class="key-input"
            type="text"
            [value]="ollamaUrl()"
            (change)="setOllamaUrl($any($event.target).value)"
            placeholder="http://localhost:11434"
          />
          <desktop-button variant="ghost" size="sm" (click)="testOllama()">Test</desktop-button>
        </div>
        <div class="card-actions">
          <desktop-button variant="ghost" size="sm" (click)="openExternal('https://ollama.com/download')">Get Ollama</desktop-button>
        </div>
      </section>

      <!-- ── API keys ── -->
      <section class="card">
        <div class="card-head">
          <h2>&#128273; API keys</h2>
          <span class="tag">Claude or OpenAI · highest quality</span>
        </div>
        @for (p of apiProviders; track p.id) {
          <div class="key-item">
            <span class="key-provider">{{ p.label }}</span>
            @if (hasKey(p.id)) {
              <span class="key-mask" title="A key is saved (hidden)">••••••••••••</span>
              <span class="key-saved-tag">Saved</span>
              <desktop-button variant="ghost" size="sm" (click)="deleteKey(p.id)">Delete</desktop-button>
            } @else {
              <input
                class="key-input"
                type="password"
                [(ngModel)]="keyDrafts[p.id]"
                [placeholder]="p.placeholder"
                autocomplete="off"
              />
              <desktop-button variant="primary" size="sm" [disabled]="!keyDrafts[p.id].trim()" (click)="saveKey(p.id)">Save</desktop-button>
            }
          </div>
        }

        @if (anyKeySaved()) {
          <div class="danger-row">
            @if (confirmClearKeys()) {
              <span class="danger-confirm">
                Clear all saved API keys?
                <desktop-button variant="ghost" size="sm" (click)="clearAllKeys()">Clear</desktop-button>
                <desktop-button variant="ghost" size="sm" (click)="confirmClearKeys.set(false)">Cancel</desktop-button>
              </span>
            } @else {
              <button class="link-danger" (click)="confirmClearKeys.set(true)">Clear all keys</button>
            }
          </div>
        }
      </section>

      @if (!embedded()) {
        <footer class="wizard-foot">
          <desktop-button variant="ghost" (click)="close()">Done</desktop-button>
        </footer>
      }
    </div>
  `,
  styles: [`
    .wizard { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 3rem; overflow-y: auto; height: 100%; }
    .wizard.embedded { padding: 0; max-width: none; height: auto; overflow: visible; }
    .ollama-url-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0 0.75rem; }
    .ollama-url-label { flex: none; color: var(--text-secondary); font-size: 0.85rem; }
    .wizard-head { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 1.5rem; }
    .head-icon { font-size: 2.5rem; }
    h1 { font-size: 1.5rem; font-weight: 600; color: var(--text-primary); margin: 0 0 0.25rem; }
    .sub { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin: 0; }

    .status-banner {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem;
      background: var(--bg-subtle); border: 1px solid var(--border-default);
      font-size: 0.875rem; color: var(--text-secondary);
    }
    .status-banner.ok { border-color: var(--success); }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-tertiary, #888); flex: none; }
    .dot.ok { background: var(--success); }

    .card {
      background: var(--bg-elevated); border: 1px solid var(--border-default);
      border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem;
    }
    .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
    .card-head h2 { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); margin: 0; }
    .tag { font-size: 0.75rem; color: var(--text-tertiary, #888); }
    .muted { color: var(--text-secondary); font-size: 0.85rem; line-height: 1.5; margin: 0 0 0.75rem; }
    .muted.hw { background: var(--bg-subtle); border-radius: 6px; padding: 0.5rem 0.75rem; }
    code { font-family: var(--font-mono, monospace); background: var(--bg-subtle); padding: 0.1rem 0.35rem; border-radius: 4px; }

    .models { display: flex; flex-direction: column; gap: 0.6rem; }
    .model {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      padding: 0.75rem; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-subtle);
    }
    .model.active { border-color: var(--accent); }
    /* Models too big for this machine: dimmed but still usable. */
    .model.too-big { opacity: 0.6; }
    .model.too-big:hover { opacity: 0.85; }
    .model-warn { color: #f59e0b; font-size: 0.74rem; margin-top: 0.25rem; }
    .badge.warn { background: color-mix(in srgb, #f59e0b 20%, transparent); color: #f59e0b; }
    .model-info { flex: 1; min-width: 0; }
    .model-name { color: var(--text-primary); font-weight: 600; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem; }
    .model-meta { color: var(--text-secondary); font-size: 0.78rem; margin-top: 0.2rem; }
    .badge { font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .badge.rec { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
    .badge.active { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
    .model-actions { display: flex; gap: 0.4rem; flex: none; }

    .progress { margin-top: 0.5rem; }
    .bar { height: 6px; border-radius: 3px; background: var(--border-default); overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    .progress-meta { font-size: 0.72rem; color: var(--text-secondary); margin-top: 0.2rem; }

    .use-row { margin-top: 1rem; }
    .card-actions { display: flex; gap: 0.5rem; }

    .key-item { display: flex; gap: 0.5rem; align-items: center; padding: 0.4rem 0; }
    .key-item + .key-item { border-top: 1px solid var(--border-subtle, var(--border-default)); }
    .key-provider { flex: none; min-width: 9.5rem; color: var(--text-primary); font-size: 0.875rem; font-weight: 500; }
    .key-input {
      flex: 1; padding: 0.5rem 0.6rem; border: 1px solid var(--border-default); border-radius: 6px;
      background: var(--bg-base); color: var(--text-primary); font-size: 0.85rem;
    }
    .key-mask { flex: 1; color: var(--text-secondary); letter-spacing: 2px; font-size: 0.9rem; }
    .key-saved-tag { flex: none; color: var(--success); font-size: 0.75rem; font-weight: 600; }

    .wizard-foot { display: flex; justify-content: flex-end; margin-top: 0.5rem; }

    .danger-row { display: flex; justify-content: flex-end; margin-top: 0.75rem; }
    .danger-confirm { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-secondary); }
    .link-danger {
      background: none; border: none; cursor: pointer; padding: 0.2rem 0;
      font-size: 0.8rem; color: var(--error, #d9534f);
    }
    .link-danger:hover { text-decoration: underline; }
  `]
})
export class AiSetupWizardComponent implements OnInit, OnDestroy {
  readonly ai = inject(AiService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly electron = inject(ElectronService);

  readonly models = signal<LocalModel[]>([]);
  readonly sysInfo = signal<LocalSystemInfo | null>(null);
  readonly localStatus = this.ai.localStatus;
  private readonly _progress = signal<Record<string, LocalModelProgress>>({});

  /** Embedded mode (rendered inside Settings → AI): hide the page header/footer. */
  readonly embedded = input(false);

  readonly apiProviders = [
    { id: 'claude' as const, label: 'Claude (Anthropic)', placeholder: 'sk-ant-…' },
    { id: 'openai' as const, label: 'OpenAI', placeholder: 'sk-…' },
  ];
  keyDrafts: Record<'claude' | 'openai', string> = { claude: '', openai: '' };

  private unsub?: () => void;

  readonly usingLocal = computed(() => this.settings.getAIConfig().provider === 'local');
  readonly anyDownloading = computed(() =>
    Object.values(this._progress()).some((p) => p.phase === 'download')
  );

  readonly activeSummary = computed(() => {
    const parts: string[] = [];
    if (this.ai.localUsable()) parts.push('local model');
    if (this.ai.ollamaHasModels()) parts.push('Ollama');
    const cfg = this.settings.getAIConfig();
    if (cfg.claude?.apiKey?.trim()) parts.push('Claude key');
    if (cfg.openai?.apiKey?.trim()) parts.push('OpenAI key');
    return parts.length ? `Detected: ${parts.join(', ')}.` : '';
  });

  // ── "Delete all" actions (per the bare-bones reset model) ──
  /** Downloaded local models a "delete all" would remove (Ollama is untouched). */
  readonly downloadedModels = computed(() => this.models().filter((m) => m.downloaded));
  readonly confirmDeleteModels = signal(false);

  /** Whether any API key is saved (drives the "Clear all keys" affordance). */
  readonly anyKeySaved = computed(() => this.hasKey('claude') || this.hasKey('openai'));
  readonly confirmClearKeys = signal(false);

  /** Remove every downloaded local LLM. Leaves Ollama config + API keys alone. */
  async deleteAllModels(): Promise<void> {
    for (const m of this.downloadedModels()) {
      await this.ai.deleteModel(m.id);
    }
    this.confirmDeleteModels.set(false);
    await this.reload();
  }

  /** Clear every saved API key (both providers). */
  clearAllKeys(): void {
    if (this.hasKey('claude')) this.deleteKey('claude');
    if (this.hasKey('openai')) this.deleteKey('openai');
    this.confirmClearKeys.set(false);
  }

  async ngOnInit(): Promise<void> {
    this.unsub = this.ai.onModelProgress((p) => {
      this._progress.update((map) => {
        const next = { ...map };
        if (p.phase === 'download') {
          next[p.modelId] = p;
        } else {
          delete next[p.modelId];
        }
        return next;
      });
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
        void this.reload();
      }
    });
    await this.reload();
    this.sysInfo.set(await this.ai.systemInfo());
  }

  ngOnDestroy(): void {
    this.unsub?.();
  }

  private async reload(): Promise<void> {
    this.models.set(await this.ai.listLocalModels());
    await this.ai.refresh();
  }

  progressFor(id: string): LocalModelProgress | undefined {
    return this._progress()[id];
  }

  modelName(id: string): string {
    return this.models().find((m) => m.id === id)?.name ?? id;
  }

  /** Warn (but don't block) before committing to a model too big for this machine. */
  private async confirmIfTooBig(id: string, verb: string): Promise<boolean> {
    const m = this.models().find((x) => x.id === id);
    if (!m || m.fits) return true;
    const { confirmed } = await this.electron.showConfirmDialog({
      type: 'warning',
      title: `${m.name} is large for your hardware`,
      message: `${m.name} needs about ${m.minRAM} GB but this machine has less to spare.`,
      detail: 'It will still work, but it runs partly on the CPU and will be noticeably slower. The model marked "Recommended" fits your hardware and runs fast.',
      confirmLabel: `${verb} anyway`,
      cancelLabel: 'Cancel',
    });
    return confirmed;
  }

  async download(id: string): Promise<void> {
    if (!(await this.confirmIfTooBig(id, 'Download'))) return;
    // Seed an immediate 0% bar so the UI reacts before the first progress tick.
    this._progress.update((m) => ({ ...m, [id]: { modelId: id, pct: 0, receivedBytes: 0, totalBytes: 0, phase: 'download' } }));
    await this.ai.downloadModel(id);
  }

  async cancel(id: string): Promise<void> {
    await this.ai.cancelDownload(id);
  }

  async useModel(id: string): Promise<void> {
    if (!(await this.confirmIfTooBig(id, 'Use'))) return;
    await this.ai.setActiveModel(id);
    this.setProvider('local');
    await this.reload();
  }

  async remove(id: string): Promise<void> {
    await this.ai.deleteModel(id);
    await this.reload();
  }

  setProvider(provider: 'local'): void {
    this.settings.updateAIConfig({ provider });
  }

  /** True when a non-empty key is saved for the provider. Reads the settings
   *  signal so it re-evaluates after save/delete. */
  hasKey(provider: 'claude' | 'openai'): boolean {
    const cfg = this.settings.getAIConfig();
    return !!cfg[provider]?.apiKey?.trim();
  }

  saveKey(provider: 'claude' | 'openai'): void {
    const key = (this.keyDrafts[provider] || '').trim();
    if (!key) return;
    const cfg = this.settings.getAIConfig();
    if (provider === 'claude') {
      this.settings.updateAIConfig({ provider: 'claude', claude: { ...cfg.claude, apiKey: key } });
    } else {
      this.settings.updateAIConfig({ provider: 'openai', openai: { ...cfg.openai, apiKey: key } });
    }
    this.keyDrafts[provider] = '';
    void this.ai.refresh();
  }

  // ── Ollama server URL (config used by cleanup/translate jobs at runtime) ──
  ollamaUrl(): string {
    return this.settings.getAIConfig().ollama?.baseUrl || 'http://localhost:11434';
  }
  setOllamaUrl(url: string): void {
    const cfg = this.settings.getAIConfig();
    this.settings.updateAIConfig({ ollama: { ...cfg.ollama, baseUrl: url.trim() } });
    void this.ai.refresh();
  }
  testOllama(): void {
    void this.ai.refresh();
  }

  /** Remove a saved API key. Leaves the provider selection to the unified picker. */
  deleteKey(provider: 'claude' | 'openai'): void {
    const cfg = this.settings.getAIConfig();
    if (provider === 'claude') {
      this.settings.updateAIConfig({ claude: { ...cfg.claude, apiKey: '' } });
    } else {
      this.settings.updateAIConfig({ openai: { ...cfg.openai, apiKey: '' } });
    }
    void this.ai.refresh();
  }

  openExternal(url: string): void {
    (window as unknown as { electron?: { shell?: { openExternal: (u: string) => void } } })
      .electron?.shell?.openExternal(url);
  }

  goSettings(): void {
    void this.router.navigate(['/settings']);
  }

  close(): void {
    void this.router.navigate(['/studio']);
  }
}

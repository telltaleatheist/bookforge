/**
 * Translation Panel - Component for adding EPUBs to the translation queue
 *
 * Translates EPUBs to English (auto-detects source language).
 * Recommended workflow: Translate -> AI Cleanup -> TTS
 */

import { Component, input, output, signal, computed, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { AIProvider } from '../../../../core/models/ai-config.types';

@Component({
  selector: 'app-translation-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="translation-panel">
      <div class="panel-header">
        <h4>Translation</h4>
        <p>Translate to English (auto-detects source language).</p>
      </div>

      <!-- Workflow Note -->
      <div class="workflow-note">
        <span class="note-icon">i</span>
        <span class="note-text">
          <strong>Recommended workflow:</strong> Translate -> AI Cleanup -> TTS
        </span>
      </div>

      <!-- AI Provider Selection -->
      <div class="provider-section">
        <label class="field-label">AI Provider</label>
        <div class="provider-buttons">
          <button
            class="provider-btn"
            [class.selected]="selectedProvider() === 'ollama'"
            [class.connected]="selectedProvider() === 'ollama' && ollamaConnected()"
            (click)="selectProvider('ollama')"
          >
            <span class="provider-icon">&#129433;</span>
            <span class="provider-name">Ollama</span>
            @if (selectedProvider() === 'ollama') {
              <span class="provider-status" [class.connected]="ollamaConnected()">
                {{ ollamaConnected() ? 'Connected' : 'Not connected' }}
              </span>
            }
          </button>
          <button
            class="provider-btn"
            [class.selected]="selectedProvider() === 'claude'"
            [class.disabled]="!hasClaudeKey()"
            (click)="selectProvider('claude')"
          >
            <span class="provider-icon">&#129504;</span>
            <span class="provider-name">Claude</span>
            @if (!hasClaudeKey()) {
              <span class="provider-status">No API key</span>
            }
          </button>
          <button
            class="provider-btn"
            [class.selected]="selectedProvider() === 'openai'"
            [class.disabled]="!hasOpenAIKey()"
            (click)="selectProvider('openai')"
          >
            <span class="provider-icon">&#129302;</span>
            <span class="provider-name">OpenAI</span>
            @if (!hasOpenAIKey()) {
              <span class="provider-status">No API key</span>
            }
          </button>
        </div>
        @if (selectedProvider() !== 'ollama' && !hasApiKeyForProvider()) {
          <div class="api-key-warning">
            API key not configured. <a (click)="goToSettings()">Add in Settings</a>
          </div>
        }
      </div>

      <!-- Model Selection -->
      <div class="model-section">
        <label class="field-label">Model</label>
        @if (availableModels().length > 0) {
          <select
            class="model-select"
            [value]="selectedModel()"
            (change)="selectModel($any($event.target).value)"
            [disabled]="loadingClaudeModels()"
          >
            @for (model of availableModels(); track model.value) {
              <option [value]="model.value" [selected]="model.value === selectedModel()">{{ model.label }}</option>
            }
          </select>
          @if (loadingClaudeModels()) {
            <div class="loading-indicator">Fetching available models...</div>
          }
        } @else {
          <div class="no-models">
            @if (selectedProvider() === 'ollama') {
              @if (checkingConnection()) {
                Checking connection...
              } @else if (!ollamaConnected()) {
                <span class="error-text">Ollama not running.</span>
                <a href="https://ollama.ai" target="_blank">Install Ollama</a> and run <code>ollama pull llama3.2</code>
              } @else {
                No models found. Run <code>ollama pull llama3.2</code>
              }
            } @else if (selectedProvider() === 'claude' && loadingClaudeModels()) {
              Fetching available models...
            } @else {
              Configure API key in Settings
            }
          </div>
        }
      </div>

      <!-- Actions -->
      <div class="actions">
        <desktop-button
          [variant]="addedToQueue() ? 'ghost' : 'primary'"
          size="md"
          [disabled]="!canAddToQueue() || addingToQueue() || addedToQueue()"
          (click)="addToQueue()"
        >
          @if (addingToQueue()) {
            Adding to Queue...
          } @else if (addedToQueue()) {
            Added to Queue
          } @else {
            Add Translation to Queue
          }
        </desktop-button>
      </div>
    </div>
  `,
  styles: [`
    .translation-panel {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .panel-header {
      h4 {
        margin: 0 0 0.25rem 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--text-secondary);
      }
    }

    .workflow-note {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.75rem;
      background: color-mix(in srgb, var(--info) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--info) 30%, transparent);
      border-radius: 6px;
    }

    .note-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      background: var(--info);
      color: white;
      border-radius: 50%;
      font-size: 0.75rem;
      font-weight: 600;
      flex-shrink: 0;
    }

    .note-text {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      line-height: 1.4;

      strong {
        color: var(--text-primary);
      }
    }

    .field-label {
      display: block;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 0.5rem;
    }

    .provider-section {
      margin-bottom: 0.25rem;
    }

    .provider-buttons {
      display: flex;
      gap: 0.5rem;
    }

    .provider-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
      padding: 0.75rem 0.5rem;
      background: var(--bg-subtle);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;

      .provider-icon {
        font-size: 1.5rem;
      }

      .provider-name {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
      }

      .provider-status {
        font-size: 0.625rem;
        color: var(--text-muted);

        &.connected {
          color: var(--success);
        }
      }

      &:hover:not(.disabled) {
        border-color: var(--border-default);
        background: var(--bg-hover);
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, transparent);

        .provider-name {
          color: var(--accent);
        }
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .api-key-warning {
      margin-top: 0.5rem;
      font-size: 0.75rem;
      color: var(--warning);

      a {
        color: var(--accent);
        cursor: pointer;
        text-decoration: underline;
      }
    }

    .model-section {
      margin-bottom: 0.25rem;
    }

    .model-select {
      width: 100%;
      padding: 0.625rem 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 0.875rem;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      option {
        background: var(--bg-surface);
      }
    }

    .no-models {
      padding: 0.75rem;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border-radius: 6px;
      line-height: 1.5;

      .error-text {
        color: var(--error);
      }

      a {
        color: var(--accent);
      }

      code {
        background: var(--bg-elevated);
        padding: 0.125rem 0.375rem;
        border-radius: 4px;
        font-size: 0.75rem;
      }
    }

    .loading-indicator {
      margin-top: 0.375rem;
      font-size: 0.75rem;
      color: var(--text-tertiary);
    }

    .actions {
      display: flex;
      gap: 0.75rem;
    }
  `]
})
export class TranslationPanelComponent implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly settingsService = inject(SettingsService);
  private readonly electronService = inject(ElectronService);
  private readonly router = inject(Router);

  // Inputs
  readonly epubPath = input<string>('');
  readonly metadata = input<{ title?: string; author?: string } | undefined>(undefined);

  // Outputs
  readonly translationQueued = output<void>();

  // State
  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // AI Provider state
  readonly selectedProvider = signal<AIProvider>('ollama');
  readonly selectedModel = signal<string>('');
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly loadingClaudeModels = signal(false);

  // Computed: check if API keys are configured
  readonly hasClaudeKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.claude.apiKey;
  });

  readonly hasOpenAIKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.openai.apiKey;
  });

  readonly hasApiKeyForProvider = computed(() => {
    const provider = this.selectedProvider();
    if (provider === 'ollama') return true;
    if (provider === 'claude') return this.hasClaudeKey();
    if (provider === 'openai') return this.hasOpenAIKey();
    return false;
  });

  // Computed: available models based on provider
  readonly availableModels = computed(() => {
    const provider = this.selectedProvider();

    if (provider === 'ollama') {
      return this.ollamaModels();
    } else if (provider === 'claude' && this.hasClaudeKey()) {
      const models = this.claudeModels();
      if (models.length > 0) {
        return models;
      }
      return [
        { value: 'claude-sonnet-4-20250514', label: 'Loading models...' }
      ];
    } else if (provider === 'openai' && this.hasOpenAIKey()) {
      return [
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
      ];
    }
    return [];
  });

  // Computed: can add to queue
  readonly canAddToQueue = computed(() => {
    const provider = this.selectedProvider();
    const model = this.selectedModel();
    const path = this.epubPath();
    if (!model || !path) return false;
    if (provider === 'ollama') return this.ollamaConnected();
    return this.hasApiKeyForProvider();
  });

  ngOnInit(): void {
    this.checkConnection();
    this.initializeFromSettings();
  }

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();
    this.selectedProvider.set(config.provider);

    if (config.provider === 'ollama') {
      this.selectedModel.set(config.ollama.model);
    } else if (config.provider === 'claude') {
      this.selectedModel.set(config.claude.model);
      if (config.claude.apiKey) {
        this.fetchClaudeModels(config.claude.apiKey);
      }
    } else if (config.provider === 'openai') {
      this.selectedModel.set(config.openai.model);
    }
  }

  async checkConnection(): Promise<void> {
    this.checkingConnection.set(true);
    try {
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      if (response?.ok) {
        this.ollamaConnected.set(true);
        const data = await response.json();
        const models = (data.models || []).map((m: { name: string }) => ({
          value: m.name,
          label: m.name
        }));
        this.ollamaModels.set(models);

        const currentModel = this.selectedModel();
        const modelExists = models.some((m: { value: string }) => m.value === currentModel);
        if ((!currentModel || !modelExists) && models.length > 0) {
          this.selectedModel.set(models[0].value);
        }
      } else {
        this.ollamaConnected.set(false);
      }
    } catch {
      this.ollamaConnected.set(false);
    } finally {
      this.checkingConnection.set(false);
    }
  }

  selectProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.selectedProvider.set(provider);

    const config = this.settingsService.getAIConfig();
    if (provider === 'ollama') {
      const models = this.ollamaModels();
      this.selectedModel.set(models.length > 0 ? models[0].value : config.ollama.model);
    } else if (provider === 'claude') {
      this.fetchClaudeModels(config.claude.apiKey);
      const currentModels = this.claudeModels();
      if (currentModels.length > 0) {
        this.selectedModel.set(currentModels[0].value);
      } else {
        this.selectedModel.set(config.claude.model || 'claude-sonnet-4-20250514');
      }
    } else if (provider === 'openai') {
      this.selectedModel.set(config.openai.model || 'gpt-4o');
    }
  }

  async fetchClaudeModels(apiKey: string): Promise<void> {
    if (!apiKey) return;

    this.loadingClaudeModels.set(true);
    try {
      const result = await this.electronService.getClaudeModels(apiKey);
      if (result.success && result.models) {
        this.claudeModels.set(result.models);
        const currentModel = this.selectedModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!modelExists && result.models.length > 0) {
          this.selectedModel.set(result.models[0].value);
        }
      }
    } catch (err) {
      console.error('Failed to fetch Claude models:', err);
    } finally {
      this.loadingClaudeModels.set(false);
    }
  }

  selectModel(model: string): void {
    this.selectedModel.set(model);
  }

  goToSettings(): void {
    this.router.navigate(['/settings']);
  }

  async addToQueue(): Promise<void> {
    const path = this.epubPath();
    if (!path) return;

    const provider = this.selectedProvider();
    const model = this.selectedModel();
    if (!model) return;

    this.addingToQueue.set(true);

    try {
      const config = this.settingsService.getAIConfig();

      await this.queueService.addJob({
        type: 'translation',
        epubPath: path,
        metadata: this.metadata(),
        config: {
          type: 'translation',
          aiProvider: provider,
          aiModel: model,
          ollamaBaseUrl: provider === 'ollama' ? config.ollama.baseUrl : undefined,
          claudeApiKey: provider === 'claude' ? config.claude.apiKey : undefined,
          openaiApiKey: provider === 'openai' ? config.openai.apiKey : undefined
        }
      });
      this.addedToQueue.set(true);
      this.translationQueued.emit();
      setTimeout(() => this.addedToQueue.set(false), 3000);
    } catch (err) {
      console.error('Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }
}

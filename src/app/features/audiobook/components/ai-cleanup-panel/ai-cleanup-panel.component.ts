/**
 * AI Cleanup Panel - Simplified component for adding EPUBs to the OCR cleanup queue
 */

import { Component, input, output, signal, computed, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { AIProvider } from '../../../../core/models/ai-config.types';

@Component({
  selector: 'app-ai-cleanup-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="ai-cleanup-panel">
      <div class="panel-header">
        <h4>AI Text Cleanup</h4>
        <p>Clean up OCR artifacts and formatting issues using AI.</p>
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
            <span class="provider-icon">🦙</span>
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
            <span class="provider-icon">🧠</span>
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
            <span class="provider-icon">🤖</span>
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
          >
            @for (model of availableModels(); track model.value) {
              <option [value]="model.value">{{ model.label }}</option>
            }
          </select>
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
            } @else {
              Configure API key in Settings
            }
          </div>
        }
      </div>

      <!-- What it does -->
      <div class="info-section">
        <h5>What AI cleanup does:</h5>
        <ul>
          <li>Fixes broken hyphenation (tradi-tional → traditional)</li>
          <li>Corrects OCR mistakes (rn→m, cl→d, li→h)</li>
          <li>Fixes number/letter confusion (0/O, 1/l/I)</li>
          <li>Expands era abbreviations for TTS (BCE → B C E)</li>
        </ul>
      </div>

      <!-- Actions -->
      <div class="actions">
        <desktop-button
          variant="primary"
          size="md"
          [disabled]="!canAddToQueue() || addingToQueue()"
          (click)="addToQueue()"
        >
          @if (addingToQueue()) {
            Adding to Queue...
          } @else {
            Add to Queue
          }
        </desktop-button>
      </div>
    </div>

    <!-- Success Modal -->
    @if (showSuccessModal()) {
      <div class="modal-backdrop" (click)="closeSuccessModal()">
        <div class="success-modal" (click)="$event.stopPropagation()">
          <div class="success-icon">
            <span>&#10003;</span>
          </div>
          <div class="success-content">
            <h3>Added to Queue</h3>
            <p>Your EPUB has been added to the processing queue.</p>
          </div>
          <div class="success-actions">
            <button class="action-btn primary" (click)="goToQueue()">
              View Queue
            </button>
            <button class="action-btn secondary" (click)="closeSuccessModal()">
              Continue Editing
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .ai-cleanup-panel {
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

    .info-section {
      background: var(--bg-subtle);
      padding: 0.75rem 1rem;
      border-radius: 6px;
      border: 1px solid var(--border-subtle);

      h5 {
        margin: 0 0 0.5rem 0;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      ul {
        margin: 0;
        padding-left: 1.25rem;

        li {
          font-size: 0.75rem;
          color: var(--text-secondary);
          margin-bottom: 0.25rem;

          &:last-child {
            margin-bottom: 0;
          }
        }
      }
    }

    .actions {
      display: flex;
      gap: 0.75rem;
    }

    /* Success Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes modalPop {
      from {
        opacity: 0;
        transform: scale(0.95) translateY(10px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .success-modal {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 16px;
      width: 340px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      animation: modalPop 0.2s ease;
    }

    .success-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem 2rem 1rem;

      span {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2rem;
        background: color-mix(in srgb, var(--success) 15%, transparent);
        color: var(--success);
      }
    }

    .success-content {
      padding: 0 2rem 1.5rem;
      text-align: center;

      h3 {
        margin: 0 0 0.5rem 0;
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-size: 0.875rem;
        color: var(--text-secondary);
        line-height: 1.5;
      }
    }

    .success-actions {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--border-subtle);

      .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.875rem 1rem;
        border: none;
        background: transparent;
        font-size: 0.9375rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;

        &:not(:last-child) {
          border-bottom: 1px solid var(--border-subtle);
        }

        &.primary {
          color: var(--accent);

          &:hover {
            background: color-mix(in srgb, var(--accent) 8%, transparent);
          }
        }

        &.secondary {
          color: var(--text-secondary);

          &:hover {
            background: var(--bg-hover);
          }
        }
      }
    }
  `]
})
export class AiCleanupPanelComponent implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly settingsService = inject(SettingsService);
  private readonly router = inject(Router);

  // Inputs
  readonly epubPath = input<string>('');
  readonly metadata = input<{ title?: string; author?: string } | undefined>(undefined);

  // Outputs
  readonly cleanupComplete = output<void>();

  // State
  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly addingToQueue = signal(false);
  readonly showSuccessModal = signal(false);

  // AI Provider state
  readonly selectedProvider = signal<AIProvider>('ollama');
  readonly selectedModel = signal<string>('');
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);

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
      return [
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' }
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

    // Set initial model based on provider
    if (config.provider === 'ollama') {
      this.selectedModel.set(config.ollama.model);
    } else if (config.provider === 'claude') {
      this.selectedModel.set(config.claude.model);
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

        // Set default model if none selected and we have models
        if (!this.selectedModel() && models.length > 0) {
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

    // Set default model for the provider
    const config = this.settingsService.getAIConfig();
    if (provider === 'ollama') {
      const models = this.ollamaModels();
      this.selectedModel.set(models.length > 0 ? models[0].value : config.ollama.model);
    } else if (provider === 'claude') {
      this.selectedModel.set(config.claude.model || 'claude-sonnet-4-20250514');
    } else if (provider === 'openai') {
      this.selectedModel.set(config.openai.model || 'gpt-4o');
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
        type: 'ocr-cleanup',
        epubPath: path,
        metadata: this.metadata(),
        config: {
          type: 'ocr-cleanup',
          aiProvider: provider,
          aiModel: model,
          ollamaBaseUrl: provider === 'ollama' ? config.ollama.baseUrl : undefined,
          claudeApiKey: provider === 'claude' ? config.claude.apiKey : undefined,
          openaiApiKey: provider === 'openai' ? config.openai.apiKey : undefined
        }
      });
      this.showSuccessModal.set(true);
    } catch (err) {
      console.error('Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  closeSuccessModal(): void {
    this.showSuccessModal.set(false);
  }

  goToQueue(): void {
    this.closeSuccessModal();
    this.router.navigate(['/queue']);
  }
}

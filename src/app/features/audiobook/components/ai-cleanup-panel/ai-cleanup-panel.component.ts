/**
 * AI Cleanup Panel - Simplified component for adding EPUBs to the OCR cleanup queue
 */

import { Component, input, output, signal, computed, OnInit, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';
import { DeletedBlockExample } from '../../../queue/models/queue.types';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
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

      <!-- Prompt Section -->
      <div class="prompt-section">
        <label class="field-label">AI Prompt</label>
        @if (loadingPrompt()) {
          <div class="prompt-loading">Loading prompt...</div>
        } @else {
          <textarea
            class="prompt-textarea"
            [value]="promptText()"
            (input)="onPromptChange($event)"
            placeholder="Enter the AI cleanup prompt..."
          ></textarea>
          <div class="prompt-footer">
            <desktop-button
              variant="secondary"
              size="sm"
              [disabled]="!promptModified() || savingPrompt()"
              (click)="savePrompt()"
            >
              {{ savingPrompt() ? 'Saving...' : 'Save Prompt' }}
            </desktop-button>
          </div>
        }
      </div>

      <!-- Cleanup Mode Selection -->
      <div class="mode-section">
        <label class="field-label">Cleanup Mode</label>
        <div class="mode-options">
          <label class="mode-option" [class.selected]="cleanupMode() === 'structure'">
            <input
              type="radio"
              name="cleanupMode"
              value="structure"
              [checked]="cleanupMode() === 'structure'"
              (change)="setCleanupMode('structure')"
            />
            <div class="mode-content">
              <span class="mode-name">Structure Preserving</span>
              <span class="mode-desc">Preserves HTML tags, cleans text inside elements</span>
            </div>
          </label>
          <label class="mode-option" [class.selected]="cleanupMode() === 'full'">
            <input
              type="radio"
              name="cleanupMode"
              value="full"
              [checked]="cleanupMode() === 'full'"
              (change)="setCleanupMode('full')"
            />
            <div class="mode-content">
              <span class="mode-name">Full Document</span>
              <span class="mode-desc">Sends HTML to AI - can fix structural issues but riskier</span>
            </div>
          </label>
        </div>
      </div>

      <!-- Parallel Workers Option (only for Claude/OpenAI) -->
      @if (supportsParallel()) {
        <div class="parallel-section">
          <label class="field-label">Parallel Workers</label>
          <div class="worker-options">
            @for (count of workerOptions; track count) {
              <label class="worker-option" [class.selected]="parallelWorkers() === count">
                <input
                  type="radio"
                  name="aiWorkerCount"
                  [value]="count"
                  [checked]="parallelWorkers() === count"
                  (change)="setParallelWorkers(count)"
                />
                <span>{{ count }}</span>
              </label>
            }
          </div>
          <p class="option-hint">
            Process multiple chapters simultaneously. More workers = faster, but uses more API quota.
          </p>
        </div>
      }

      <!-- Detailed Cleanup Option -->
      @if (hasDeletedExamples()) {
        <div class="detailed-cleanup-section">
          <label class="checkbox-option">
            <input
              type="checkbox"
              [checked]="useDetailedCleanup()"
              (change)="toggleDetailedCleanup($event)"
            >
            <span class="checkbox-label">
              Use detailed cleanup ({{ exampleCount() }} deletion examples)
            </span>
          </label>
          <p class="option-hint">
            The AI will learn from your deleted blocks and remove similar patterns throughout the document.
          </p>
        </div>
      }

      <!-- Test Mode Option -->
      <div class="test-mode-section">
        <label class="checkbox-option">
          <input
            type="checkbox"
            [checked]="testMode()"
            (change)="toggleTestMode($event)"
          >
          <span class="checkbox-label">
            Test mode (first 5 chunks only)
          </span>
        </label>
        <p class="option-hint">
          Process only the first 5 chunks to preview AI cleanup results before running the full job.
        </p>
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
            ✓ Added to Queue
          } @else if (testMode()) {
            Add Test Job to Queue
          } @else {
            Add to Queue
          }
        </desktop-button>
      </div>
    </div>
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

    .loading-indicator {
      margin-top: 0.375rem;
      font-size: 0.75rem;
      color: var(--text-tertiary);
    }

    .actions {
      display: flex;
      gap: 0.75rem;
    }

    .detailed-cleanup-section,
    .test-mode-section {
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
    }

    .checkbox-option {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;

      input[type="checkbox"] {
        width: 1rem;
        height: 1rem;
        accent-color: var(--accent);
        cursor: pointer;
      }

      .checkbox-label {
        font-size: 0.875rem;
        color: var(--text-primary);
      }
    }

    .option-hint {
      margin: 0.5rem 0 0 1.5rem;
      font-size: 0.75rem;
      color: var(--text-tertiary);
      line-height: 1.4;
    }

    .prompt-section {
      margin-top: 0.25rem;
    }

    .prompt-loading {
      color: var(--text-secondary);
      font-size: 0.8125rem;
      padding: 1rem;
      text-align: center;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .prompt-textarea {
      width: 100%;
      height: 200px;
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 0.6875rem;
      line-height: 1.5;
      resize: none;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .prompt-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 0.5rem;
    }

    .mode-section {
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
    }

    .mode-options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .mode-option {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;

      input[type="radio"] {
        margin-top: 0.125rem;
        accent-color: var(--accent);
      }

      .mode-content {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }

      .mode-name {
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .mode-desc {
        font-size: 0.6875rem;
        color: var(--text-tertiary);
      }

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));

        .mode-name {
          color: var(--accent);
        }
      }
    }

    .parallel-section {
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
    }

    .worker-options {
      display: flex;
      gap: 0.5rem;
    }

    .worker-option {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      transition: all 0.15s;

      input[type="radio"] {
        display: none;
      }

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated));
        color: var(--accent);
      }
    }
  `]
})
export class AiCleanupPanelComponent implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly settingsService = inject(SettingsService);
  private readonly electronService = inject(ElectronService);
  private readonly router = inject(Router);

  // Inputs
  readonly epubPath = input<string>('');
  readonly metadata = input<{ title?: string; author?: string } | undefined>(undefined);
  readonly bfpPath = input<string | undefined>(undefined);  // BFP project path for analytics saving

  // Outputs
  readonly cleanupComplete = output<void>();

  // State
  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // Detailed cleanup state (deleted block examples)
  readonly hasDeletedExamples = signal(false);
  readonly exampleCount = signal(0);
  readonly useDetailedCleanup = signal(false);
  readonly deletedBlockExamples = signal<DeletedBlockExample[]>([]);

  // Prompt editor state
  readonly loadingPrompt = signal(false);
  readonly savingPrompt = signal(false);
  readonly promptText = signal('');
  readonly originalPromptText = signal('');
  readonly promptModified = computed(() => this.promptText() !== this.originalPromptText());

  // Parallel workers state (only for Claude/OpenAI)
  readonly parallelWorkers = signal(1);
  readonly workerOptions = [1, 2, 3, 4, 5];

  // Cleanup mode state
  readonly cleanupMode = signal<'structure' | 'full'>('structure');

  // Test mode state (only process first 5 chunks)
  readonly testMode = signal(false);

  // Computed: check if provider supports parallel processing
  readonly supportsParallel = computed(() => {
    const provider = this.selectedProvider();
    return provider === 'claude' || provider === 'openai';
  });

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
      // Return fetched models, or fallback while loading
      if (models.length > 0) {
        return models;
      }
      // Fallback models shown while loading
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

  // Effect to load deleted examples when epubPath changes
  private readonly epubPathEffect = effect(() => {
    const path = this.epubPath();
    if (path) {
      this.loadDeletedExamples();
    }
  });

  ngOnInit(): void {
    this.checkConnection();
    this.initializeFromSettings();
    this.loadPrompt();
  }

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();
    this.selectedProvider.set(config.provider);

    // Set initial model based on provider
    if (config.provider === 'ollama') {
      this.selectedModel.set(config.ollama.model);
    } else if (config.provider === 'claude') {
      this.selectedModel.set(config.claude.model);
      // Fetch available Claude models for this API key
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

        // Validate selected model exists, otherwise use first available
        const currentModel = this.selectedModel();
        const modelExists = models.some((m: { value: string }) => m.value === currentModel);
        if ((!currentModel || !modelExists) && models.length > 0) {
          console.log('[AI-CLEANUP] Selected model', currentModel, 'not in available models, defaulting to', models[0].value);
          this.selectedModel.set(models[0].value);
        } else {
          console.log('[AI-CLEANUP] Using model:', currentModel);
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
      // Fetch available Claude models for this API key
      this.fetchClaudeModels(config.claude.apiKey);
      // Set initial model while loading
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
        // Update selected model to first in list if current selection isn't valid
        const currentModel = this.selectedModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!modelExists && result.models.length > 0) {
          this.selectedModel.set(result.models[0].value);
        }
      } else {
        console.error('Failed to fetch Claude models:', result.error);
        // Keep fallback models on error
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

      // Include detailed cleanup options if enabled
      const useDetailed = this.useDetailedCleanup() && this.hasDeletedExamples();
      const examples = useDetailed ? this.deletedBlockExamples() : undefined;

      // Parallel processing settings (only for Claude/OpenAI)
      const useParallel = this.supportsParallel() && this.parallelWorkers() > 1;
      const workers = useParallel ? this.parallelWorkers() : undefined;

      await this.queueService.addJob({
        type: 'ocr-cleanup',
        epubPath: path,
        metadata: this.metadata(),
        bfpPath: this.bfpPath(),  // For analytics saving
        config: {
          type: 'ocr-cleanup',
          aiProvider: provider,
          aiModel: model,
          ollamaBaseUrl: provider === 'ollama' ? config.ollama.baseUrl : undefined,
          claudeApiKey: provider === 'claude' ? config.claude.apiKey : undefined,
          openaiApiKey: provider === 'openai' ? config.openai.apiKey : undefined,
          useDetailedCleanup: useDetailed,
          deletedBlockExamples: examples,
          useParallel,
          parallelWorkers: workers,
          cleanupMode: this.cleanupMode(),
          testMode: this.testMode()
        }
      });
      this.addedToQueue.set(true);
      // Reset after 3 seconds
      setTimeout(() => this.addedToQueue.set(false), 3000);
    } catch (err) {
      console.error('Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  // Prompt editor methods
  async loadPrompt(): Promise<void> {
    this.loadingPrompt.set(true);
    try {
      const result = await this.electronService.getAIPrompt();
      if (result) {
        this.promptText.set(result.prompt);
        this.originalPromptText.set(result.prompt);
      }
    } catch (err) {
      console.error('Failed to load prompt:', err);
    } finally {
      this.loadingPrompt.set(false);
    }
  }

  onPromptChange(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    this.promptText.set(textarea.value);
  }

  async savePrompt(): Promise<void> {
    this.savingPrompt.set(true);
    try {
      const success = await this.electronService.saveAIPrompt(this.promptText());
      if (success) {
        this.originalPromptText.set(this.promptText());
      }
    } catch (err) {
      console.error('Failed to save prompt:', err);
    } finally {
      this.savingPrompt.set(false);
    }
  }

  toggleDetailedCleanup(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.useDetailedCleanup.set(checkbox.checked);
  }

  setParallelWorkers(count: number): void {
    this.parallelWorkers.set(count);
  }

  setCleanupMode(mode: 'structure' | 'full'): void {
    this.cleanupMode.set(mode);
  }

  toggleTestMode(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.testMode.set(checkbox.checked);
  }

  /**
   * Load deleted block examples from project metadata or linked BFP project.
   * First checks for examples stored directly in audiobook project,
   * then falls back to loading from the source BFP project file.
   */
  async loadDeletedExamples(): Promise<void> {
    const path = this.epubPath();
    if (!path) return;

    try {
      // First try: load examples directly from audiobook project metadata
      const result = await this.electronService.loadProjectMetadata(path);
      if (result?.deletedBlockExamples && result.deletedBlockExamples.length > 0) {
        const typedExamples: DeletedBlockExample[] = result.deletedBlockExamples.map(ex => ({
          text: ex.text,
          category: (ex.category as DeletedBlockExample['category']) || 'block',
          page: ex.page
        }));
        this.deletedBlockExamples.set(typedExamples);
        this.exampleCount.set(typedExamples.length);
        this.hasDeletedExamples.set(true);
        // Don't auto-check - let user decide if they want detailed cleanup
        console.log(`[AI-CLEANUP] Loaded ${typedExamples.length} deleted block examples from project metadata`);
        return;
      }

      // Second try: load from linked BFP project file
      const bfpExamples = await this.electronService.loadDeletedExamplesFromBfp(path);
      if (bfpExamples && bfpExamples.length > 0) {
        const typedExamples: DeletedBlockExample[] = bfpExamples.map(ex => ({
          text: ex.text,
          category: (ex.category as DeletedBlockExample['category']) || 'block',
          page: ex.page
        }));
        this.deletedBlockExamples.set(typedExamples);
        this.exampleCount.set(typedExamples.length);
        this.hasDeletedExamples.set(true);
        // Don't auto-check - let user decide if they want detailed cleanup
        console.log(`[AI-CLEANUP] Loaded ${typedExamples.length} deleted block examples from BFP project`);
      }
    } catch (err) {
      console.warn('Failed to load deleted block examples:', err);
      // Not an error - examples are optional
    }
  }
}

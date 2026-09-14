/**
 * Translation Panel - Component for adding EPUBs to the translation queue
 *
 * Translates EPUBs to English (auto-detects source language).
 * Recommended workflow: Translate -> AI Cleanup -> TTS
 */

import { Component, input, output, signal, computed, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { AIProvider } from '../../../../core/models/ai-config.types';
import { capabilityWords } from '../../../settings/components/crucible-words';
import type { CrucibleCapabilityView } from '@shared/crucible/settings-wire';

@Component({
  selector: 'app-translation-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
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
            [class.selected]="selectedProvider() === 'crucible'"
            [class.disabled]="!crucibleServer()"
            (click)="selectProvider('crucible')"
          >
            <span class="provider-icon">&#128225;</span>
            <span class="provider-name">GPU engine (Crucible)</span>
            @if (crucibleServer(); as server) {
              <span class="provider-status">{{ server }}</span>
            } @else {
              <span class="provider-status">No engine chosen</span>
            }
          </button>
          <button
            class="provider-btn"
            [class.selected]="selectedProvider() === 'local'"
            (click)="selectProvider('local')"
          >
            <span class="provider-icon">&#128187;</span>
            <span class="provider-name">Bundled local</span>
            <span class="provider-status">Runs on this machine</span>
          </button>
        </div>
        @if (selectedProvider() === 'crucible' && !crucibleServer()) {
          <div class="api-key-warning">
            No engine is chosen yet. <a (click)="goToSettings()">Pick one in Settings</a>
          </div>
        }
      </div>

      <!-- The model, as its owner states it -->
      <div class="model-section">
        <label class="field-label">Model</label>
        <div class="no-models">{{ modelLine() }}</div>
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

    .add-langs-btn {
      margin-top: 0.5rem;
      padding: 0.25rem 0.6rem;
      font-size: 0.75rem;
      background: transparent;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--accent);
      cursor: pointer;

      &:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
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

    /* .model-select and .loading-indicator went with the model picker and the
       Claude model fetch it waited on. .no-models stayed: it is now the one
       line that states the model rather than offering one. */
    .no-models {
      padding: 0.75rem;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border-radius: 6px;
      line-height: 1.5;
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
  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  /*
   * WHAT THIS PANEL STOPPED ASKING (2026-09-14).
   *
   * `ollamaConnected`, `checkingConnection`, `ollamaModels`, `claudeModels`,
   * `loadingClaudeModels`, `hasClaudeKey`, `hasOpenAIKey`,
   * `hasApiKeyForProvider`, `availableModels`, `modelOptions`, `selectModel`,
   * `checkConnection` and `fetchClaudeModels` are all deleted, and with them a
   * hardcoded `claude-sonnet-4-20250514` and a three-item GPT list that had
   * been the only choices this panel ever offered for those two.
   *
   * Nothing here picks a model any more, because nothing here owns one: the
   * bundled model is whichever was activated in Settings → AI, and the
   * engine's is its own capability record, measured against its own card.
   * What this panel still owns is WHO runs the translation.
   */

  // AI Provider state
  readonly selectedProvider = signal<AIProvider>('local');

  /** The engine's capability record, or null before it has been asked for. */
  readonly capability = signal<CrucibleCapabilityView | null>(null);

  /** The engine this app is pointed at, or '' when none has been chosen. */
  readonly crucibleServer = computed(() => this.settingsService.getAIConfig().crucible?.server ?? '');

  /** THE MODEL, as its owner states it. Never a control. */
  readonly modelLine = computed(() => {
    if (this.selectedProvider() === 'local') return 'The bundled local model.';
    if (!this.crucibleServer()) return 'No engine chosen yet — pick one in Settings → AI.';
    return capabilityWords(this.capability(), 'translate');
  });

  // Computed: can add to queue
  readonly canAddToQueue = computed(() => {
    if (!this.epubPath()) return false;
    // The bundled model is always there to be asked; an engine has to have
    // been named, because a run cannot ask a machine nobody picked.
    return this.selectedProvider() === 'local' || !!this.crucibleServer();
  });

  ngOnInit(): void {
    this.selectedProvider.set(this.settingsService.getAIConfig().provider);
    void this.loadCapability();
  }

  private async loadCapability(): Promise<void> {
    const server = this.crucibleServer();
    if (!server) return;
    const res = await this.electronService.crucible.capability(server);
    // Never an empty record on failure — an empty class list reads as "this
    // engine serves nothing", which is a different and false claim.
    if (res.success && res.data) this.capability.set(res.data);
  }

  selectProvider(provider: AIProvider): void {
    if (provider === 'crucible' && !this.crucibleServer()) return;
    this.selectedProvider.set(provider);
  }

  goToSettings(): void {
    this.router.navigate(['/settings']);
  }

  async addToQueue(): Promise<void> {
    const path = this.epubPath();
    if (!path || !this.canAddToQueue()) return;

    const provider = this.selectedProvider();

    this.addingToQueue.set(true);

    try {
      await this.queueService.addJob({
        type: 'translation',
        epubPath: path,
        metadata: this.metadata(),
        config: {
          type: 'translation',
          aiProvider: provider,
          // Empty because neither provider's model is this panel's to name:
          // the engine's is its capability record and the bundled one is the
          // active local model. A string typed here would be a second opinion.
          aiModel: ''
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

/**
 * ProcessWizard - Pipeline wizard for processing EPUBs into mono audiobooks
 *
 * Steps:
 * 1. AI Cleanup - Configure AI provider/model for text cleanup
 * 2. TTS - Configure voice/engine settings
 * 3. Review - Summary of all settings, Add to Queue button
 *
 * Note: Translation and bilingual features are handled in the Bilingual tab.
 */

import { Component, input, output, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { LibraryService } from '../../../../core/services/library.service';
import { QueueService } from '../../../queue/services/queue.service';
import { OcrCleanupConfig, TtsConversionConfig, BilingualCleanupJobConfig, BilingualTranslationJobConfig } from '../../../queue/models/queue.types';
import { AIProvider } from '../../../../core/models/ai-config.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WizardStep = 'cleanup' | 'translate' | 'tts' | 'review';

export interface SourceOption {
  path: string;
  label: string;
  description?: string;
  modifiedAt?: string;
  isDefault?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-process-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="wizard">
      <!-- Source Selection -->
      @if (availableSources().length > 1) {
        <div class="source-selector">
          <label class="source-label">Source EPUB</label>
          <div class="source-options">
            @for (source of availableSources(); track source.path) {
              <button
                class="source-btn"
                [class.selected]="selectedSourcePath() === source.path"
                (click)="selectSource(source.path)"
              >
                <span class="source-name">{{ source.label }}</span>
                @if (source.description) {
                  <span class="source-desc">{{ source.description }}</span>
                }
                @if (source.isDefault) {
                  <span class="source-badge">Latest</span>
                }
              </button>
            }
          </div>
        </div>
      }

      <!-- Step Indicator -->
      <div class="step-indicator">
        <div class="step" [class.active]="currentStep() === 'cleanup'" [class.completed]="isStepCompleted('cleanup')" [class.skipped]="isStepSkipped('cleanup')">
          <span class="step-num">1</span>
          <span class="step-label">AI Cleanup</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'translate'" [class.completed]="isStepCompleted('translate')" [class.skipped]="isStepSkipped('translate')">
          <span class="step-num">2</span>
          <span class="step-label">Translate</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'tts'" [class.completed]="isStepCompleted('tts')" [class.skipped]="isStepSkipped('tts')">
          <span class="step-num">3</span>
          <span class="step-label">TTS</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'review'" [class.completed]="isStepCompleted('review')">
          <span class="step-num">4</span>
          <span class="step-label">Review</span>
        </div>
      </div>

      <!-- Step Content -->
      <div class="step-content">
        @switch (currentStep()) {
          @case ('cleanup') {
            <div class="step-panel">
              <h3>AI Cleanup</h3>
              <p class="step-desc">Clean up OCR artifacts and formatting issues using AI.</p>

              <!-- Provider Selection -->
              <div class="config-section">
                <label class="field-label">AI Provider</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="cleanupProvider() === 'ollama'"
                    [class.connected]="cleanupProvider() === 'ollama' && ollamaConnected()"
                    (click)="selectCleanupProvider('ollama')"
                  >
                    <span class="provider-icon">🦙</span>
                    <span class="provider-name">Ollama</span>
                    @if (cleanupProvider() === 'ollama') {
                      <span class="provider-status" [class.connected]="ollamaConnected()">
                        {{ ollamaConnected() ? 'Connected' : 'Not connected' }}
                      </span>
                    }
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="cleanupProvider() === 'claude'"
                    [class.disabled]="!hasClaudeKey()"
                    (click)="selectCleanupProvider('claude')"
                  >
                    <span class="provider-icon">🧠</span>
                    <span class="provider-name">Claude</span>
                    @if (!hasClaudeKey()) {
                      <span class="provider-status">No API key</span>
                    }
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="cleanupProvider() === 'openai'"
                    [class.disabled]="!hasOpenAIKey()"
                    (click)="selectCleanupProvider('openai')"
                  >
                    <span class="provider-icon">🤖</span>
                    <span class="provider-name">OpenAI</span>
                    @if (!hasOpenAIKey()) {
                      <span class="provider-status">No API key</span>
                    }
                  </button>
                </div>
                @if (cleanupProvider() !== 'ollama' && !hasApiKeyForCleanupProvider()) {
                  <div class="api-key-warning">
                    API key not configured. <a (click)="goToSettings()">Add in Settings</a>
                  </div>
                }
              </div>

              <!-- Model Selection -->
              <div class="config-section">
                <label class="field-label">Model</label>
                @if (cleanupModels().length > 0) {
                  <select
                    class="select-input"
                    [value]="cleanupModel()"
                    (change)="cleanupModel.set($any($event.target).value)"
                  >
                    @for (model of cleanupModels(); track model.value) {
                      <option [value]="model.value" [selected]="model.value === cleanupModel()">{{ model.label }}</option>
                    }
                  </select>
                  @if (loadingModels()) {
                    <div class="loading-indicator">Fetching available models...</div>
                  }
                } @else {
                  <div class="no-models">
                    @if (cleanupProvider() === 'ollama') {
                      @if (checkingConnection()) {
                        Checking connection...
                      } @else if (!ollamaConnected()) {
                        <span class="error-text">Ollama not running.</span>
                        <a href="https://ollama.ai" target="_blank">Install Ollama</a> and run <code>ollama pull llama3.2</code>
                      } @else {
                        No models found. Run <code>ollama pull llama3.2</code>
                      }
                    } @else if (loadingModels()) {
                      Fetching available models...
                    } @else {
                      Configure API key in Settings
                    }
                  </div>
                }
              </div>

              <!-- Parallel Workers (Claude/OpenAI only) -->
              @if (cleanupProvider() !== 'ollama') {
                <div class="config-section">
                  <label class="field-label">Parallel Workers</label>
                  <div class="worker-options">
                    @for (count of [1, 2, 3, 4, 5]; track count) {
                      <button class="worker-btn" [class.selected]="cleanupParallelWorkers() === count" (click)="cleanupParallelWorkers.set(count)">
                        {{ count }}
                      </button>
                    }
                  </div>
                  <span class="hint">
                    More workers = faster processing but higher API costs per minute.
                  </span>
                </div>
              }

              <!-- Processing Options -->
              <div class="processing-options">
                <label class="field-label">Processing Options</label>

                <!-- AI Cleanup Option -->
                <div class="toggle-section">
                  <button
                    class="option-toggle"
                    [class.active]="enableAiCleanup()"
                    (click)="enableAiCleanup.set(!enableAiCleanup())"
                  >
                    <span class="toggle-icon">🔧</span>
                    <span class="toggle-label">AI Cleanup</span>
                    <span class="toggle-sublabel">Fix OCR errors & formatting</span>
                  </button>
                  <span class="hint">
                    Fix OCR errors, remove headers/footers, clean up formatting issues
                  </span>
                </div>

                <!-- Simplify for Language Learning Option -->
                <div class="toggle-section">
                  <button
                    class="option-toggle"
                    [class.active]="simplifyForChildren()"
                    (click)="simplifyForChildren.set(!simplifyForChildren())"
                  >
                    <span class="toggle-icon">📖</span>
                    <span class="toggle-label">Simplify for language learning</span>
                    <span class="toggle-sublabel">Natural American English, 3rd grade level</span>
                  </button>
                  <span class="hint">
                    Rewrite into clean, natural American English that flows well when spoken aloud. Ideal for language learners.
                  </span>
                </div>

                @if (!enableAiCleanup() && !simplifyForChildren()) {
                  <div class="warning-banner">
                    No processing selected. Enable at least one option or skip this step.
                  </div>
                }
              </div>

              <!-- Test Mode Option -->
              <div class="toggle-section">
                <button
                  class="option-toggle"
                  [class.active]="testMode()"
                  (click)="testMode.set(!testMode())"
                >
                  <span class="toggle-icon">🧪</span>
                  <span class="toggle-label">Test mode</span>
                  <span class="toggle-sublabel">First {{ testModeChunks() }} chunks only</span>
                </button>
                @if (testMode()) {
                  <div class="test-mode-config">
                    <label>Chunks to process:</label>
                    <div class="chunk-options">
                      @for (count of [3, 5, 10, 20]; track count) {
                        <button
                          class="chunk-option"
                          [class.selected]="testModeChunks() === count"
                          (click)="testModeChunks.set(count)"
                        >
                          {{ count }}
                        </button>
                      }
                    </div>
                  </div>
                }
                <span class="hint">
                  Process only the first few chunks to preview results before running the full job.
                </span>
              </div>

              <!-- Prompt Accordion -->
              <div class="accordion" [class.open]="promptAccordionOpen()">
                <button class="accordion-header" (click)="promptAccordionOpen.set(!promptAccordionOpen())">
                  <span class="accordion-title">AI Prompt</span>
                  <span class="accordion-icon">{{ promptAccordionOpen() ? '▼' : '▶' }}</span>
                </button>
                @if (promptAccordionOpen()) {
                  <div class="accordion-content">
                    @if (loadingPrompt()) {
                      <div class="prompt-loading">Loading prompt...</div>
                    } @else {
                      <textarea
                        class="prompt-textarea"
                        [value]="promptText()"
                        (input)="onPromptChange($event)"
                        placeholder="Enter the AI cleanup prompt..."
                      ></textarea>
                      @if (promptModified()) {
                        <div class="prompt-footer">
                          <button class="btn-save-prompt" [disabled]="savingPrompt()" (click)="savePrompt()">
                            {{ savingPrompt() ? 'Saving...' : 'Save Prompt' }}
                          </button>
                        </div>
                      }
                    }
                  </div>
                }
              </div>
            </div>
          }

          @case ('translate') {
            <div class="step-panel">
              <h3>Translation</h3>
              <p class="step-desc">Translate foreign language books to English before TTS.</p>

              <!-- Enable Translation Toggle -->
              <div class="toggle-section">
                <button
                  class="option-toggle"
                  [class.active]="enableTranslation()"
                  (click)="enableTranslation.set(!enableTranslation())"
                >
                  <span class="toggle-icon">🌐</span>
                  <span class="toggle-label">Enable Translation</span>
                  <span class="toggle-sublabel">Translate to English before TTS</span>
                </button>
                <span class="hint">
                  Use this for foreign language books you want narrated in English.
                </span>
              </div>

              @if (enableTranslation()) {
                <!-- Source Language -->
                <div class="config-section">
                  <label class="field-label">Source Language (book's language)</label>
                  <div class="language-grid">
                    @for (lang of translationLanguages; track lang.code) {
                      <button
                        class="language-btn"
                        [class.selected]="translateSourceLang() === lang.code"
                        (click)="translateSourceLang.set(lang.code)"
                      >
                        <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                        <span class="lang-name">{{ lang.name }}</span>
                      </button>
                    }
                  </div>
                </div>

                <!-- AI Provider for Translation -->
                <div class="config-section">
                  <label class="field-label">AI Provider</label>
                  <div class="provider-buttons">
                    <button
                      class="provider-btn"
                      [class.selected]="translateProvider() === 'ollama'"
                      [class.connected]="translateProvider() === 'ollama' && ollamaConnected()"
                      (click)="selectTranslateProvider('ollama')"
                    >
                      <span class="provider-icon">🦙</span>
                      <span class="provider-name">Ollama</span>
                      @if (translateProvider() === 'ollama') {
                        <span class="provider-status" [class.connected]="ollamaConnected()">
                          {{ ollamaConnected() ? 'Connected' : 'Not connected' }}
                        </span>
                      }
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="translateProvider() === 'claude'"
                      [class.disabled]="!hasClaudeKey()"
                      (click)="selectTranslateProvider('claude')"
                    >
                      <span class="provider-icon">🧠</span>
                      <span class="provider-name">Claude</span>
                      @if (!hasClaudeKey()) {
                        <span class="provider-status">No API key</span>
                      }
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="translateProvider() === 'openai'"
                      [class.disabled]="!hasOpenAIKey()"
                      (click)="selectTranslateProvider('openai')"
                    >
                      <span class="provider-icon">🤖</span>
                      <span class="provider-name">OpenAI</span>
                      @if (!hasOpenAIKey()) {
                        <span class="provider-status">No API key</span>
                      }
                    </button>
                  </div>
                </div>

                <!-- Model Selection -->
                <div class="config-section">
                  <label class="field-label">Model</label>
                  @if (translateModels().length > 0) {
                    <select
                      class="select-input"
                      [value]="translateModel()"
                      (change)="translateModel.set($any($event.target).value)"
                    >
                      @for (model of translateModels(); track model.value) {
                        <option [value]="model.value" [selected]="model.value === translateModel()">{{ model.label }}</option>
                      }
                    </select>
                  } @else {
                    <div class="no-models">
                      @if (translateProvider() === 'ollama') {
                        @if (!ollamaConnected()) {
                          <span class="error-text">Ollama not running.</span>
                        } @else {
                          No models found.
                        }
                      } @else {
                        Configure API key in Settings
                      }
                    </div>
                  }
                </div>

                <div class="translation-note">
                  Translation will create a new EPUB with English text, which will then be used for TTS.
                </div>
              }
            </div>
          }

          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">Configure voice synthesis settings.</p>

              <div class="config-section">
                  <!-- Device Selection -->
                  <label class="field-label">Processing Device</label>
                  <div class="provider-buttons">
                    <button class="provider-btn" [class.selected]="ttsDevice === 'mps'" (click)="selectTtsDevice('mps')">
                      <span class="provider-name">MPS</span>
                      <span class="provider-status">Apple Silicon</span>
                    </button>
                    <button class="provider-btn" [class.selected]="ttsDevice === 'gpu'" (click)="selectTtsDevice('gpu')">
                      <span class="provider-name">GPU</span>
                      <span class="provider-status">CUDA</span>
                    </button>
                    <button class="provider-btn" [class.selected]="ttsDevice === 'cpu'" (click)="selectTtsDevice('cpu')">
                      <span class="provider-name">CPU</span>
                      <span class="provider-status">Slower</span>
                    </button>
                  </div>

                  <!-- Engine Selection -->
                  <label class="field-label">TTS Engine</label>
                  <div class="provider-buttons">
                    <button
                      class="provider-btn"
                      [class.selected]="ttsEngine === 'xtts'"
                      (click)="selectTtsEngine('xtts')"
                    >
                      <span class="provider-name">XTTS</span>
                      <span class="provider-status">Multi-language</span>
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="ttsEngine === 'orpheus'"
                      (click)="selectTtsEngine('orpheus')"
                    >
                      <span class="provider-name">Orpheus</span>
                      <span class="provider-status">Better prosody</span>
                    </button>
                  </div>

                  <!-- Language (only for XTTS) -->
                  @if (ttsEngine === 'xtts') {
                    <label class="field-label">Language</label>
                    <select [(ngModel)]="ttsLanguage" class="select-input">
                      <option value="en">English</option>
                      <option value="es">Spanish</option>
                      <option value="fr">French</option>
                      <option value="de">German</option>
                      <option value="it">Italian</option>
                      <option value="pt">Portuguese</option>
                      <option value="ja">Japanese</option>
                      <option value="zh">Chinese</option>
                    </select>
                  }

                  <!-- Voice Selection -->
                  <label class="field-label">Voice</label>
                  <select [(ngModel)]="ttsVoice" class="select-input">
                    @for (voice of getVoicesForEngine(ttsEngine); track voice.value) {
                      <option [value]="voice.value">{{ voice.label }}</option>
                    }
                  </select>

                  <label class="field-label">Speed: {{ ttsSpeed }}x</label>
                  <div class="speed-control">
                    <input type="range" min="0.5" max="2" step="0.05" [(ngModel)]="ttsSpeed">
                    <span class="speed-value">{{ ttsSpeed }}x</span>
                  </div>

                  <!-- Parallel Workers (only for XTTS) -->
                  @if (ttsEngine === 'xtts') {
                    <label class="field-label">Parallel Workers</label>
                    <div class="worker-options">
                      @for (count of [1, 2, 3, 4]; track count) {
                        <button class="worker-btn" [class.selected]="parallelWorkers === count" (click)="parallelWorkers = count">
                          {{ count }}
                        </button>
                      }
                    </div>
                    <span class="hint">More workers = faster, but uses ~3GB RAM each</span>
                  }

                  <!-- Advanced Settings Accordion -->
                  <div class="accordion" [class.open]="advancedTtsOpen()">
                    <button class="accordion-header" (click)="advancedTtsOpen.set(!advancedTtsOpen())">
                      <span class="accordion-title">Advanced Settings</span>
                      <span class="accordion-icon">{{ advancedTtsOpen() ? '▼' : '▶' }}</span>
                    </button>
                    @if (advancedTtsOpen()) {
                      <div class="accordion-content">
                        <label class="field-label">Temperature: {{ ttsTemperature }}</label>
                        <input type="range" min="0.1" max="1.0" step="0.05" [(ngModel)]="ttsTemperature" class="full-width-slider">
                        <span class="hint">Higher = more expressive but less consistent</span>

                        <label class="field-label">Top P: {{ ttsTopP }}</label>
                        <input type="range" min="0.1" max="1.0" step="0.05" [(ngModel)]="ttsTopP" class="full-width-slider">
                      </div>
                    }
                  </div>

                  <!-- TTS Test Mode -->
                  <div class="toggle-section">
                    <button
                      class="option-toggle"
                      [class.active]="ttsTestMode()"
                      (click)="ttsTestMode.set(!ttsTestMode())"
                    >
                      <span class="toggle-icon">🧪</span>
                      <span class="toggle-label">Test mode</span>
                      <span class="toggle-sublabel">First {{ ttsTestModeChunks() }} sentences only</span>
                    </button>
                    @if (ttsTestMode()) {
                      <div class="test-mode-config">
                        <label>Sentences to process:</label>
                        <div class="chunk-options">
                          @for (count of [5, 10, 20, 50]; track count) {
                            <button
                              class="chunk-option"
                              [class.selected]="ttsTestModeChunks() === count"
                              (click)="ttsTestModeChunks.set(count)"
                            >
                              {{ count }}
                            </button>
                          }
                        </div>
                      </div>
                    }
                    <span class="hint">
                      Process only the first few sentences to test voice quality before running the full conversion.
                    </span>
                  </div>
              </div>
            </div>
          }

          @case ('review') {
            <div class="step-panel">
              <h3>Review & Queue</h3>
              <p class="step-desc">Review your settings before adding to queue.</p>

              <div class="review-section">
                <div class="review-item">
                  <span class="review-label">EPUB:</span>
                  <span class="review-value">{{ epubFilename() }}</span>
                </div>

                <div class="review-item">
                  <span class="review-label">AI Cleanup:</span>
                  <span class="review-value" [class.disabled]="isStepSkipped('cleanup')">
                    {{ isStepSkipped('cleanup') ? 'Skipped' : cleanupProvider() + ' / ' + cleanupModel() }}
                  </span>
                </div>

                <div class="review-item">
                  <span class="review-label">Translation:</span>
                  <span class="review-value" [class.disabled]="isStepSkipped('translate') || !enableTranslation()">
                    @if (isStepSkipped('translate') || !enableTranslation()) {
                      Skipped
                    } @else {
                      {{ getLanguageName(translateSourceLang()) }} → English ({{ translateProvider() }} / {{ translateModel() }})
                    }
                  </span>
                </div>

                <div class="review-item">
                  <span class="review-label">TTS:</span>
                  <span class="review-value" [class.disabled]="isStepSkipped('tts')">
                    @if (isStepSkipped('tts')) {
                      Skipped
                    } @else {
                      {{ ttsEngine }} / {{ ttsVoice }} @ {{ ttsSpeed }}x
                    }
                  </span>
                </div>
              </div>

              @if (!hasAnyTask()) {
                <div class="warning-box">
                  All steps skipped. Nothing will be processed.
                </div>
              }
            </div>
          }
        }
      </div>

      <!-- Navigation -->
      <div class="wizard-nav">
        @if (currentStep() !== 'cleanup') {
          <button class="btn-back" (click)="goBack()">
            ← Back
          </button>
        } @else {
          <div></div>
        }

        <div class="nav-right">
          @if (currentStep() !== 'review') {
            <button class="btn-skip" (click)="skipStep()">
              Skip
            </button>
            <button class="btn-next" (click)="goNext()" [disabled]="!canProceed()">
              Next →
            </button>
          } @else {
            <button
              class="btn-queue"
              [class.added]="addedToQueue()"
              [disabled]="!hasAnyTask() || addingToQueue() || addedToQueue()"
              (click)="addToQueue()"
            >
              @if (addingToQueue()) {
                Adding...
              } @else if (addedToQueue()) {
                ✓ Added to Queue
              } @else {
                Add to Queue
              }
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
    }

    .wizard {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 16px;
      overflow: hidden;
    }

    /* Source Selector */
    .source-selector {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 12px;
    }

    .source-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }

    .source-options {
      display: flex;
      gap: 8px;
    }

    .source-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;

      .source-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .source-desc {
        font-size: 11px;
        color: var(--text-muted);
      }

      .source-badge {
        position: absolute;
        top: -6px;
        right: -6px;
        padding: 2px 6px;
        background: #22c55e;
        color: white;
        font-size: 9px;
        font-weight: 600;
        border-radius: 10px;
        text-transform: uppercase;
      }

      &:hover:not(.selected) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .source-name {
          color: #06b6d4;
        }
      }
    }

    /* Step Indicator */
    .step-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      opacity: 0.6;
      transition: all 0.2s ease;

      &.active {
        opacity: 1;
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .step-num {
          background: #06b6d4;
          color: white;
        }
      }

      &.completed {
        opacity: 1;

        .step-num {
          background: #22c55e;
          color: white;
        }
      }

      &.skipped {
        opacity: 0.5;

        .step-num {
          background: var(--text-muted);
          color: white;
        }

        .step-label {
          text-decoration: line-through;
        }
      }
    }

    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--bg-base);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .step-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .step-connector {
      width: 24px;
      height: 2px;
      background: var(--border-default);
    }

    /* Step Content */
    .step-content {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
    }

    .step-panel {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 24px;

      h3 {
        margin: 0 0 8px;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .step-desc {
        margin: 0 0 24px;
        font-size: 14px;
        color: var(--text-secondary);
      }
    }

    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 8px;
      margin-top: 16px;

      &:first-child {
        margin-top: 0;
      }
    }

    .config-section {
      display: flex;
      flex-direction: column;
    }

    .provider-buttons {
      display: flex;
      gap: 8px;
    }

    .provider-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      color: var(--text-primary);

      .provider-icon {
        font-size: 1.5rem;
      }

      .provider-name {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .provider-status {
        font-size: 10px;
        color: var(--text-muted);

        &.connected {
          color: #22c55e;
        }
      }

      &:hover:not(.disabled) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .provider-name {
          color: #06b6d4;
        }
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .api-key-warning {
      margin-top: 8px;
      font-size: 12px;
      color: #eab308;

      a {
        color: #06b6d4;
        cursor: pointer;
        text-decoration: underline;
      }
    }

    .select-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;

      &:focus {
        outline: none;
        border-color: #06b6d4;
      }

      option {
        background: var(--bg-surface);
      }
    }

    .no-models {
      padding: 12px;
      font-size: 13px;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border-radius: 6px;
      line-height: 1.5;

      .error-text {
        color: #ef4444;
      }

      a {
        color: #06b6d4;
      }

      code {
        background: var(--bg-elevated);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
      }
    }

    .loading-indicator {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-tertiary);
    }

    /* Checkbox Section */
    .checkbox-section {
      margin-top: 16px;
      padding: 12px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }

    .checkbox-option {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;

      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: #06b6d4;
        cursor: pointer;
      }

      .checkbox-label {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }
    }

    /* Processing Options Group */
    .processing-options {
      margin-top: 16px;

      > .field-label {
        margin-bottom: 12px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted);
      }

      .toggle-section {
        display: inline-block;
        width: calc(50% - 6px);
        margin-top: 0;
        vertical-align: top;

        &:first-of-type {
          margin-right: 12px;
        }

        .option-toggle {
          height: 100%;
        }
      }
    }

    /* Warning Banner */
    .warning-banner {
      display: block;
      width: 100%;
      margin-top: 12px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid var(--warning);
      border-radius: 6px;
      font-size: 12px;
      color: var(--warning);
      text-align: center;
    }

    /* Toggle Section */
    .toggle-section {
      margin-top: 16px;
    }

    .option-toggle {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 16px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;

      .toggle-icon {
        font-size: 24px;
      }

      .toggle-label {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-secondary);
      }

      .toggle-sublabel {
        font-size: 11px;
        color: var(--text-muted);
      }

      &:hover:not(.active) {
        border-color: var(--border-default);
        background: var(--bg-hover);
      }

      &.active {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 10%, var(--bg-elevated));

        .toggle-label {
          color: #06b6d4;
        }

        .toggle-sublabel {
          color: #06b6d4;
          opacity: 0.8;
        }
      }
    }

    .test-mode-config {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      padding: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      label {
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
      }
    }

    .chunk-options {
      display: flex;
      gap: 6px;
    }

    .chunk-option {
      padding: 6px 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 15%, var(--bg-subtle));
        color: #06b6d4;
      }
    }

    /* Accordion */
    .accordion {
      margin-top: 16px;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;
    }

    .accordion-header {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: var(--bg-elevated);
      border: none;
      cursor: pointer;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .accordion-icon {
      font-size: 10px;
      color: var(--text-tertiary);
    }

    .accordion-content {
      padding: 16px;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
    }

    .prompt-loading {
      color: var(--text-secondary);
      font-size: 13px;
      padding: 16px;
      text-align: center;
    }

    .prompt-textarea {
      width: 100%;
      height: 200px;
      padding: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 11px;
      line-height: 1.5;
      resize: vertical;

      &:focus {
        outline: none;
        border-color: #06b6d4;
      }

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .prompt-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }

    .btn-save-prompt {
      padding: 6px 12px;
      background: #06b6d4;
      border: none;
      border-radius: 4px;
      color: white;
      font-size: 12px;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: #0891b2;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    /* Language Grid */
    .language-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .language-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      .lang-flag {
        display: block;
        width: 32px;
        height: 20px;
        border-radius: 3px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        flex-shrink: 0;
      }

      .lang-code {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .lang-name {
        font-size: 11px;
        color: var(--text-primary);
      }

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .lang-name {
          color: #06b6d4;
        }
      }

      .lang-check {
        position: absolute;
        top: 4px;
        right: 4px;
        font-size: 12px;
        color: #06b6d4;
        font-weight: bold;
      }

      position: relative;
    }

    /* Translation Note */
    .translation-note {
      margin-top: 16px;
      padding: 12px 16px;
      background: color-mix(in srgb, #06b6d4 10%, transparent);
      border: 1px solid rgba(6, 182, 212, 0.3);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* Worker Options */
    .worker-options {
      display: flex;
      gap: 8px;
    }

    .worker-btn {
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;
        color: #06b6d4;
      }
    }

    /* Hint text */
    .hint {
      display: block;
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-tertiary);
    }

    /* Bilingual Mode Styles */
    .loading-cache {
      padding: 16px;
      text-align: center;
      color: var(--text-secondary);
      font-size: 13px;
    }

    .language-select-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }

    .lang-select-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;

      .lang-flag {
        width: 24px;
        height: 16px;
        border-radius: 2px;
      }

      .lang-code {
        font-weight: 600;
        font-size: 14px;
        color: var(--text-primary);
      }

      .lang-name {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .cache-info {
        font-size: 10px;
        color: var(--text-muted);
      }

      .audio-badge,
      .cache-badge {
        position: absolute;
        top: 4px;
        right: 4px;
        font-size: 9px;
        padding: 2px 6px;
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border-radius: 10px;
      }

      &:hover:not(:disabled) {
        border-color: var(--color-primary);
        background: rgba(6, 182, 212, 0.05);
      }

      &.selected {
        border-color: var(--color-primary);
        background: rgba(6, 182, 212, 0.1);

        .lang-code {
          color: var(--color-primary);
        }
      }

      &.cached {
        border-color: rgba(34, 197, 94, 0.3);
      }

      &.has-audio {
        border-color: rgba(34, 197, 94, 0.5);
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    .no-source-hint {
      grid-column: 1 / -1;
      padding: 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
      background: var(--bg-subtle);
      border-radius: 8px;
    }

    .bilingual-voice-settings {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: var(--bg-elevated);
      border-radius: 8px;
    }

    .voice-row {
      display: flex;
      align-items: center;
      gap: 12px;

      .voice-lang {
        width: 32px;
        font-weight: 600;
        font-size: 13px;
        color: var(--text-primary);
      }

      .voice-select {
        flex: 1;
        min-width: 120px;
      }

      .speed-slider {
        width: 80px;
      }

      .speed-label {
        width: 48px;
        font-size: 12px;
        color: var(--text-secondary);
        text-align: right;
      }
    }

    /* Full width slider */
    .full-width-slider {
      width: 100%;
      margin-top: 4px;
    }

    /* Speed Control */
    .speed-control {
      display: flex;
      align-items: center;
      gap: 12px;

      input[type="range"] {
        flex: 1;
        cursor: pointer;
      }

      .speed-value {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        min-width: 40px;
      }
    }

    /* Review Section */
    .review-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--bg-elevated);
      border-radius: 8px;
      padding: 16px;
    }

    .review-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .review-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .review-value {
      font-size: 13px;
      color: var(--text-primary);

      &.disabled {
        color: var(--text-muted);
        font-style: italic;
      }
    }

    .warning-box {
      margin-top: 16px;
      padding: 12px 16px;
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid #eab308;
      border-radius: 6px;
      font-size: 13px;
      color: #eab308;
    }

    /* Navigation */
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 16px;
      border-top: 1px solid var(--border-subtle);
      margin-top: 16px;
    }

    .nav-right {
      display: flex;
      gap: 8px;
    }

    .btn-back,
    .btn-skip,
    .btn-next,
    .btn-queue {
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-back {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-skip {
      background: transparent;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-next {
      background: #06b6d4;
      border: none;
      color: white;

      &:hover:not(:disabled) {
        background: #0891b2;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-queue {
      background: var(--accent);
      border: none;
      color: var(--bg-primary);

      &:hover:not(:disabled) {
        background: #16a34a;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.added {
        background: var(--accent);
        opacity: 0.8;
      }
    }
  `]
})
export class ProcessWizardComponent implements OnInit {
  private readonly settingsService = inject(SettingsService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);

  // Inputs
  readonly epubPath = input.required<string>();  // Current EPUB (may be cleaned version for TTS)
  readonly originalEpubPath = input<string>('');  // Always the original exported.epub for AI cleanup
  readonly availableSources = input<SourceOption[]>([]);  // Available source EPUBs to choose from
  readonly title = input<string>('');
  readonly author = input<string>('');
  readonly itemType = input<'book' | 'article'>('book');
  readonly bfpPath = input<string>('');  // BFP project path for books (used to copy VTT after TTS)
  // Article-specific inputs
  readonly projectId = input<string>('');
  readonly projectDir = input<string>('');
  readonly sourceLang = input<string>('en');
  readonly textContent = input<string>('');  // Plain text content for article cleanup
  // Book-specific inputs for bilingual cache

  // Outputs
  readonly queued = output<void>();

  // State
  readonly currentStep = signal<WizardStep>('cleanup');
  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // Source selection - defaults to the epubPath input, can be changed by user
  readonly selectedSourcePath = signal<string>('');

  // Connection state
  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly loadingModels = signal(false);

  // Model lists
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);

  // Cleanup config (signals for reactivity)
  readonly cleanupProvider = signal<AIProvider>('ollama');
  readonly cleanupModel = signal<string>('');
  readonly enableAiCleanup = signal(true);  // Standard OCR/formatting cleanup
  readonly simplifyForChildren = signal(false);  // Simplify archaic language
  readonly testMode = signal(false);
  readonly testModeChunks = signal(5);
  readonly cleanupParallelWorkers = signal(4);  // Parallel workers for Claude/OpenAI

  // Translation config
  readonly enableTranslation = signal(false);  // Whether to translate before TTS
  readonly translateSourceLang = signal('de');  // Source language to translate from
  readonly translateTargetLang = signal('en');  // Target language (usually English)
  readonly translateProvider = signal<AIProvider>('ollama');
  readonly translateModel = signal<string>('');

  // TTS config
  ttsDevice: 'gpu' | 'mps' | 'cpu' = 'cpu';
  ttsEngine: 'xtts' | 'orpheus' = 'xtts';
  ttsLanguage = 'en';
  ttsVoice = 'ScarlettJohansson';
  ttsSpeed = 1.25;
  parallelWorkers = 4;
  ttsTemperature = 0.7;
  ttsTopP = 0.9;
  readonly advancedTtsOpen = signal(false);
  readonly ttsTestMode = signal(false);
  readonly ttsTestModeChunks = signal(10);

  // XTTS voice models
  readonly xttsVoices = [
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson', desc: 'Natural, warm female voice' },
    { value: 'DavidAttenborough', label: 'David Attenborough', desc: 'Documentary-style narration' },
    { value: 'BobRoss', label: 'Bob Ross', desc: 'Calm, soothing male voice' },
    { value: 'MorganFreeman', label: 'Morgan Freeman', desc: 'Deep, authoritative male voice' },
    { value: 'internal', label: 'Default XTTS', desc: 'Built-in XTTS voice' },
  ];

  // Orpheus voice models
  readonly orpheusVoices = [
    { value: 'tara', label: 'Tara (Female)', desc: 'Most natural (default)' },
    { value: 'leah', label: 'Leah (Female)', desc: 'Natural prosody' },
    { value: 'mia', label: 'Mia (Female)', desc: 'Clean, clear' },
    { value: 'jess', label: 'Jess (Female)', desc: 'Conversational' },
    { value: 'zoe', label: 'Zoe (Female)', desc: '' },
    { value: 'leo', label: 'Leo (Male)', desc: 'Conversational' },
    { value: 'dan', label: 'Dan (Male)', desc: 'Conversational' },
    { value: 'zac', label: 'Zac (Male)', desc: '' },
  ];

  // Languages available for translation source
  readonly translationLanguages = [
    { code: 'de', name: 'German' },
    { code: 'fr', name: 'French' },
    { code: 'es', name: 'Spanish' },
    { code: 'it', name: 'Italian' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'nl', name: 'Dutch' },
    { code: 'ru', name: 'Russian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'zh', name: 'Chinese' },
    { code: 'ko', name: 'Korean' },
  ];

  // Prompt state
  readonly promptAccordionOpen = signal(false);
  readonly loadingPrompt = signal(false);
  readonly savingPrompt = signal(false);
  readonly promptText = signal('');
  readonly originalPromptText = signal('');
  readonly promptModified = computed(() => this.promptText() !== this.originalPromptText());

  // Track completed/skipped steps
  private completedSteps = new Set<WizardStep>();
  private skippedSteps = new Set<WizardStep>();

  readonly epubFilename = computed(() => {
    const path = this.selectedSourcePath() || this.epubPath();
    return path.replace(/\\/g, '/').split('/').pop() || path;
  });

  // Get the effective EPUB path to use for the pipeline
  readonly effectiveEpubPath = computed(() => {
    return this.selectedSourcePath() || this.epubPath();
  });

  // Computed: check if API keys are configured
  readonly hasClaudeKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.claude.apiKey;
  });

  readonly hasOpenAIKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.openai.apiKey;
  });

  readonly hasApiKeyForCleanupProvider = computed(() => {
    const provider = this.cleanupProvider();
    if (provider === 'ollama') return true;
    if (provider === 'claude') return this.hasClaudeKey();
    if (provider === 'openai') return this.hasOpenAIKey();
    return false;
  });

  // Computed: available models based on cleanup provider
  readonly cleanupModels = computed(() => {
    const provider = this.cleanupProvider();
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  });

  // Computed: available models based on translate provider
  readonly translateModels = computed(() => {
    const provider = this.translateProvider();
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  });

  ngOnInit(): void {
    this.initializeFromSettings();
    this.initializeTtsDefaults();
    this.initializeSourceSelection();
    this.checkOllamaConnection();
    this.loadPrompt();
  }

  private initializeSourceSelection(): void {
    // If sources are provided, find the default (most recently modified)
    const sources = this.availableSources();
    if (sources.length > 0) {
      const defaultSource = sources.find(s => s.isDefault) || sources[0];
      this.selectedSourcePath.set(defaultSource.path);
    } else {
      // Fall back to epubPath input
      this.selectedSourcePath.set(this.epubPath());
    }
  }

  selectSource(path: string): void {
    this.selectedSourcePath.set(path);
  }

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();

    // Default to Ollama for cleanup
    this.cleanupProvider.set('ollama');
    this.cleanupModel.set(config.ollama.model || 'llama3.2');

    // Pre-fetch other providers' models so they're ready if the user switches
    if (config.claude.apiKey) {
      this.fetchClaudeModels(config.claude.apiKey);
    }
    if (config.openai.apiKey) {
      this.fetchOpenAIModels(config.openai.apiKey);
    }
  }

  private initializeTtsDefaults(): void {
    const isWindows = navigator.platform.startsWith('Win');
    if (isWindows) {
      this.ttsDevice = 'gpu';
      this.parallelWorkers = 1;
    }
  }

  async checkOllamaConnection(): Promise<void> {
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

        // Validate selected model exists
        const currentModel = this.cleanupModel();
        const modelExists = models.some((m: { value: string }) => m.value === currentModel);
        if ((!currentModel || !modelExists) && models.length > 0) {
          this.cleanupModel.set(models[0].value);
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

  async fetchClaudeModels(apiKey: string): Promise<void> {
    if (!apiKey) return;
    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getClaudeModels(apiKey);
      if (result.success && result.models) {
        this.claudeModels.set(result.models);
        // Update selected model if current isn't valid
        const currentModel = this.cleanupModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!modelExists && result.models.length > 0) {
          this.cleanupModel.set(result.models[0].value);
        }
      }
    } catch (err) {
      console.error('Failed to fetch Claude models:', err);
    } finally {
      this.loadingModels.set(false);
    }
  }

  async fetchOpenAIModels(apiKey: string): Promise<void> {
    if (!apiKey) return;
    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getOpenAIModels(apiKey);
      if (result.success && result.models) {
        this.openaiModels.set(result.models);
        // Update selected model if current isn't valid
        const currentModel = this.cleanupModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!modelExists && result.models.length > 0) {
          this.cleanupModel.set(result.models[0].value);
        }
      }
    } catch (err) {
      console.error('Failed to fetch OpenAI models:', err);
    } finally {
      this.loadingModels.set(false);
    }
  }

  selectCleanupProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.cleanupProvider.set(provider);
    const config = this.settingsService.getAIConfig();

    if (provider === 'ollama') {
      const models = this.ollamaModels();
      this.cleanupModel.set(models.length > 0 ? models[0].value : config.ollama.model);
    } else if (provider === 'claude') {
      if (this.claudeModels().length === 0) {
        this.fetchClaudeModels(config.claude.apiKey);
      }
      const models = this.claudeModels();
      this.cleanupModel.set(models.length > 0 ? models[0].value : config.claude.model);
    } else if (provider === 'openai') {
      if (this.openaiModels().length === 0) {
        this.fetchOpenAIModels(config.openai.apiKey);
      }
      const models = this.openaiModels();
      this.cleanupModel.set(models.length > 0 ? models[0].value : config.openai.model);
    }
  }

  selectTranslateProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.translateProvider.set(provider);
    const config = this.settingsService.getAIConfig();

    if (provider === 'ollama') {
      const models = this.ollamaModels();
      this.translateModel.set(models.length > 0 ? models[0].value : config.ollama.model);
    } else if (provider === 'claude') {
      if (this.claudeModels().length === 0) {
        this.fetchClaudeModels(config.claude.apiKey);
      }
      const models = this.claudeModels();
      this.translateModel.set(models.length > 0 ? models[0].value : config.claude.model);
    } else if (provider === 'openai') {
      if (this.openaiModels().length === 0) {
        this.fetchOpenAIModels(config.openai.apiKey);
      }
      const models = this.openaiModels();
      this.translateModel.set(models.length > 0 ? models[0].value : config.openai.model);
    }
  }

  // Prompt methods
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

  toggleSimplifyForChildren(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.simplifyForChildren.set(checkbox.checked);
  }

  toggleTestMode(event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    this.testMode.set(checkbox.checked);
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

  goToSettings(): void {
    this.router.navigate(['/settings']);
  }

  getVoicesForEngine(engine: 'xtts' | 'orpheus'): { value: string; label: string }[] {
    if (engine === 'orpheus') {
      return this.orpheusVoices;
    } else {
      return this.xttsVoices;
    }
  }

  getLanguageName(code: string): string {
    const lang = this.translationLanguages.find(l => l.code === code);
    return lang?.name || code.toUpperCase();
  }

  selectTtsEngine(engine: 'xtts' | 'orpheus'): void {
    this.ttsEngine = engine;
    // Reset voice to default for the engine
    if (engine === 'xtts') {
      this.ttsVoice = 'ScarlettJohansson';
      // Restore parallel workers based on device
      this.updateParallelWorkersForDevice();
    } else {
      this.ttsVoice = 'tara';
      this.ttsLanguage = 'en';
      // Orpheus doesn't benefit from parallel workers
      this.parallelWorkers = 1;
    }
  }

  selectTtsDevice(device: 'gpu' | 'mps' | 'cpu'): void {
    this.ttsDevice = device;
    if (this.ttsEngine === 'xtts') {
      this.updateParallelWorkersForDevice();
    }
  }

  private updateParallelWorkersForDevice(): void {
    switch (this.ttsDevice) {
      case 'mps':
        this.parallelWorkers = 4;
        break;
      case 'gpu':
      case 'cpu':
        this.parallelWorkers = 1;
        break;
    }
  }

  isStepCompleted(step: WizardStep): boolean {
    return this.completedSteps.has(step);
  }

  isStepSkipped(step: WizardStep): boolean {
    return this.skippedSteps.has(step);
  }

  canProceed(): boolean {
    const step = this.currentStep();
    if (step === 'cleanup') {
      const provider = this.cleanupProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.cleanupModel();
      return this.hasApiKeyForCleanupProvider() && !!this.cleanupModel();
    }
    if (step === 'translate') {
      // Can always proceed from translate - either skip or configure
      if (!this.enableTranslation()) return true;
      const provider = this.translateProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.translateModel();
      return this.hasApiKeyForTranslateProvider() && !!this.translateModel();
    }
    return true;
  }

  private hasApiKeyForTranslateProvider(): boolean {
    const provider = this.translateProvider();
    if (provider === 'ollama') return true;
    if (provider === 'claude') return this.hasClaudeKey();
    if (provider === 'openai') return this.hasOpenAIKey();
    return false;
  }

  skipStep(): void {
    const step = this.currentStep();
    this.skippedSteps.add(step);
    this.goNext();
  }

  goNext(): void {
    const step = this.currentStep();
    if (!this.skippedSteps.has(step)) {
      this.completedSteps.add(step);
    }

    switch (step) {
      case 'cleanup':
        this.currentStep.set('translate');
        break;
      case 'translate':
        // If translation is not enabled, mark it as skipped
        if (!this.enableTranslation()) {
          this.skippedSteps.add('translate');
        }
        this.currentStep.set('tts');
        break;
      case 'tts':
        this.currentStep.set('review');
        break;
    }
  }

  goBack(): void {
    const step = this.currentStep();

    switch (step) {
      case 'translate':
        this.currentStep.set('cleanup');
        break;
      case 'tts':
        this.currentStep.set('translate');
        break;
      case 'review':
        this.currentStep.set('tts');
        break;
    }
  }

  hasAnyTask(): boolean {
    const hasCleanup = !this.skippedSteps.has('cleanup');
    const hasTranslate = !this.skippedSteps.has('translate') && this.enableTranslation();
    const hasTts = !this.skippedSteps.has('tts');
    return hasCleanup || hasTranslate || hasTts;
  }

  async addToQueue(): Promise<void> {
    if (!this.hasAnyTask()) return;

    this.addingToQueue.set(true);

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();
      const isArticle = this.itemType() === 'article';
      let masterJobId: string | undefined;
      // Use user-selected source, or fall back to epubPath
      const selectedSource = this.effectiveEpubPath();
      // For cleanup: ALWAYS use the original finalized EPUB (not any existing cleaned version)
      // This ensures we don't create _cleaned_cleaned.epub files - cleanup replaces the old cleaned version
      const cleanupSourcePath = this.originalEpubPath() || selectedSource;
      // For TTS: start with selected source, will be updated to cleaned version after cleanup
      let currentEpubPath = selectedSource;

      // Get external audiobooks directory for TTS jobs (books only, not articles)
      const externalDir = this.settingsService.get('externalAudiobooksDir') as string | undefined;
      const outputDir = externalDir || this.libraryService.audiobooksPath() || '';

      // Create master job for audiobook production
      const masterJob = await this.queueService.addJob({
        type: 'audiobook',
        epubPath: currentEpubPath,
        projectDir: isArticle ? this.projectDir() : undefined,
        metadata: {
          title: this.title(),
          author: this.author(),
        },
        config: {
          type: 'audiobook',
        },
        workflowId,
      });
      masterJobId = masterJob.id;

      // 1. AI Cleanup job (if not skipped)
      if (!this.skippedSteps.has('cleanup')) {
        if (isArticle) {
          // Article cleanup uses bilingual-cleanup type
          await this.queueService.addJob({
            type: 'bilingual-cleanup',
            epubPath: cleanupSourcePath,
            projectDir: this.projectDir(),
            metadata: {
              title: 'AI Cleanup',
            },
            config: {
              type: 'bilingual-cleanup',
              projectId: this.projectId(),
              projectDir: this.projectDir(),
              sourceLang: this.sourceLang(),
              aiProvider: this.cleanupProvider(),
              aiModel: this.cleanupModel(),
              ollamaBaseUrl: aiConfig.ollama?.baseUrl,
              claudeApiKey: aiConfig.claude?.apiKey,
              openaiApiKey: aiConfig.openai?.apiKey,
            },
            workflowId,
            parentJobId: masterJobId,
          });
        } else {
          // Book cleanup uses ocr-cleanup type
          const cleanupConfig: Partial<OcrCleanupConfig> = {
            type: 'ocr-cleanup',
            aiProvider: this.cleanupProvider(),
            aiModel: this.cleanupModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
            enableAiCleanup: this.enableAiCleanup(),
            simplifyForChildren: this.simplifyForChildren(),
            testMode: this.testMode(),
            // Parallel processing for Claude/OpenAI
            useParallel: this.cleanupProvider() !== 'ollama',
            parallelWorkers: this.cleanupParallelWorkers(),
          };

          await this.queueService.addJob({
            type: 'ocr-cleanup',
            epubPath: cleanupSourcePath,
            bfpPath: this.bfpPath(),
            metadata: {
              title: 'AI Cleanup',
            },
            config: cleanupConfig,
            workflowId,
            parentJobId: masterJobId,
          });

          // Cleanup produces _cleaned.epub from the original source
          currentEpubPath = cleanupSourcePath.replace('.epub', '_cleaned.epub');
        }
      }

      // 2. Translation job (if enabled and not skipped)
      if (!this.skippedSteps.has('translate') && this.enableTranslation()) {
        await this.queueService.addJob({
          type: 'bilingual-translation',
          epubPath: currentEpubPath,
          bfpPath: isArticle ? undefined : this.bfpPath(),
          projectDir: isArticle ? this.projectDir() : undefined,
          metadata: {
            title: 'Translation',
          },
          config: {
            type: 'bilingual-translation',
            projectId: isArticle ? this.projectId() : undefined,
            projectDir: isArticle ? this.projectDir() : undefined,
            sourceLang: this.translateSourceLang(),
            targetLang: this.translateTargetLang(),
            aiProvider: this.translateProvider(),
            aiModel: this.translateModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
            monoTranslation: true,  // Flag to indicate full book translation (not bilingual interleave)
          },
          workflowId,
          parentJobId: masterJobId,
        });

        // Translation produces _translated.epub
        currentEpubPath = currentEpubPath.replace('.epub', '_translated.epub');
      }

      // 3. TTS job (if not skipped)
      if (!this.skippedSteps.has('tts')) {
        const ttsConfig: Partial<TtsConversionConfig> = {
          type: 'tts-conversion',
          device: this.ttsDevice,
          language: this.ttsLanguage,
          ttsEngine: this.ttsEngine,
          fineTuned: this.ttsVoice,
          temperature: this.ttsTemperature,
          topP: this.ttsTopP,
          topK: 50,
          repetitionPenalty: 1.0,
          speed: this.ttsSpeed,
          enableTextSplitting: true,
          // Use parallel TTS for better performance
          useParallel: true,
          parallelMode: 'sentences',
          parallelWorkers: this.ttsEngine === 'xtts' ? this.parallelWorkers : 1,
          outputDir,
        };

        await this.queueService.addJob({
          type: 'tts-conversion',
          epubPath: currentEpubPath,
          projectDir: isArticle ? this.projectDir() : undefined,
          bfpPath: isArticle ? undefined : this.bfpPath(),
          metadata: {
            title: 'TTS',
            bookTitle: this.title(),
            author: this.author(),
            outputFilename: `${this.title() || 'audiobook'}.m4b`,
          },
          config: ttsConfig,
          workflowId,
          parentJobId: masterJobId,
        });
      }

      console.log('[ProcessWizard] Jobs added to queue:', {
        workflowId,
        masterJobId,
        isArticle,
        cleanup: !this.skippedSteps.has('cleanup'),
        translate: !this.skippedSteps.has('translate') && this.enableTranslation(),
        tts: !this.skippedSteps.has('tts'),
      });

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[ProcessWizard] Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  private generateWorkflowId(): string {
    return `workflow-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }
}

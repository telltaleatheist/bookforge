/**
 * LLWizard - Language Learning Pipeline Wizard
 *
 * A 4-step wizard for processing EPUBs through the language learning pipeline:
 * 1. Source - Select EPUB to translate, auto-detect source language
 * 2. AI Cleanup - Clean OCR/formatting OR simplify for learners (skippable)
 * 3. Translation - Select multiple target languages (skippable)
 * 4. TTS - Configure TTS for source + targets, interleave (skippable)
 *
 * Modeled after the ProcessWizard component for consistent UI patterns.
 */

import { Component, input, output, signal, computed, inject, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { LibraryService } from '../../../../core/services/library.service';
import { QueueService } from '../../../queue/services/queue.service';
import { SUPPORTED_LANGUAGES } from '../../models/language-learning.types';
import { AIProvider } from '../../../../core/models/ai-config.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WizardStep = 'source' | 'cleanup' | 'translate' | 'tts';

export interface AvailableEpub {
  path: string;
  filename: string;
  lang: string;
  isSource: boolean;
  isTranslated: boolean;
  isCleaned: boolean;
  modifiedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-ll-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="wizard">
      <!-- Step Indicator -->
      <div class="step-indicator">
        <div class="step" [class.active]="currentStep() === 'source'" [class.completed]="isStepCompleted('source')">
          <span class="step-num">1</span>
          <span class="step-label">Source</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'cleanup'" [class.completed]="isStepCompleted('cleanup')" [class.skipped]="isStepSkipped('cleanup')">
          <span class="step-num">2</span>
          <span class="step-label">AI Cleanup</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'translate'" [class.completed]="isStepCompleted('translate')" [class.skipped]="isStepSkipped('translate')">
          <span class="step-num">3</span>
          <span class="step-label">Translate</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'tts'" [class.completed]="isStepCompleted('tts')" [class.skipped]="isStepSkipped('tts')">
          <span class="step-num">4</span>
          <span class="step-label">TTS</span>
        </div>
      </div>

      <!-- Step Content -->
      <div class="step-content">
        @switch (currentStep()) {
          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 1: Source Selection -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('source') {
            <div class="step-panel">
              <h3>Select Source EPUB</h3>
              <p class="step-desc">Choose the EPUB file to translate and convert to audio.</p>

              @if (scanningEpubs()) {
                <div class="loading-state">
                  <div class="spinner"></div>
                  <span>Scanning project folder...</span>
                </div>
              } @else if (availableEpubs().length === 0) {
                <div class="empty-state">
                  <p>No EPUBs found in project folder.</p>
                  <p class="hint">Go back and complete the article extraction step first.</p>
                </div>
              } @else {
                <div class="epub-grid">
                  @for (epub of availableEpubs(); track epub.path) {
                    <button
                      class="epub-btn"
                      [class.selected]="selectedSourcePath() === epub.path"
                      (click)="selectSource(epub.path, epub.lang)"
                    >
                      <div class="epub-icon">📄</div>
                      <div class="epub-info">
                        <span class="epub-filename">{{ epub.filename }}</span>
                        <span class="epub-lang">{{ getLanguageName(epub.lang) }}</span>
                      </div>
                      <div class="epub-badges">
                        @if (epub.isSource) {
                          <span class="badge badge-source">Original</span>
                        }
                        @if (epub.isCleaned) {
                          <span class="badge badge-cleaned">Cleaned</span>
                        }
                        @if (epub.isTranslated) {
                          <span class="badge badge-translated">Translated</span>
                        }
                      </div>
                    </button>
                  }
                </div>
              }

              <!-- Detected Language -->
              @if (selectedSourcePath()) {
                <div class="detected-lang">
                  <span class="label">Detected source language:</span>
                  <span class="value">{{ getLanguageName(detectedSourceLang()) }}</span>
                </div>
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 2: AI Cleanup -->
          <!-- ─────────────────────────────────────────────────────────────── -->
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

              <!-- Processing Options -->
              <div class="processing-options">
                <label class="field-label">Processing Options</label>

                <!-- AI Cleanup Option -->
                <div class="toggle-section-inline">
                  <button
                    class="option-toggle"
                    [class.active]="enableAiCleanup()"
                    (click)="enableAiCleanup.set(!enableAiCleanup())"
                  >
                    <span class="toggle-icon">🔧</span>
                    <span class="toggle-label">AI Cleanup</span>
                    <span class="toggle-sublabel">Fix OCR errors & formatting</span>
                  </button>

                  <!-- Simplify for Language Learning Option -->
                  <button
                    class="option-toggle"
                    [class.active]="simplifyForLearning()"
                    (click)="simplifyForLearning.set(!simplifyForLearning())"
                  >
                    <span class="toggle-icon">📖</span>
                    <span class="toggle-label">Simplify for learning</span>
                    <span class="toggle-sublabel">Natural American English</span>
                  </button>
                </div>

                @if (!enableAiCleanup() && !simplifyForLearning()) {
                  <div class="warning-banner">
                    No processing selected. Enable at least one option or skip this step.
                  </div>
                }
              </div>

              <!-- Test Mode -->
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
              </div>
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 3: Translation -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('translate') {
            <div class="step-panel">
              <h3>Translation</h3>
              <p class="step-desc">Select target languages for bilingual audiobook. Multiple selections allowed.</p>

              <!-- Source Language Display -->
              <div class="source-lang-display">
                <span class="label">Source language:</span>
                <span class="value">{{ getLanguageName(detectedSourceLang()) }}</span>
              </div>

              <!-- Target Language Multi-Select Grid -->
              <div class="config-section">
                <label class="field-label">Target Languages (select multiple)</label>
                <div class="language-grid">
                  @for (lang of supportedLanguages; track lang.code) {
                    @if (lang.code !== detectedSourceLang()) {
                      <button
                        class="language-btn"
                        [class.selected]="isTargetLangSelected(lang.code)"
                        (click)="toggleTargetLang(lang.code)"
                      >
                        <span class="lang-flag" [style.background]="getFlagCss(lang.code)"></span>
                        <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                        <span class="lang-name">{{ lang.name }}</span>
                        @if (isTargetLangSelected(lang.code)) {
                          <span class="lang-check">✓</span>
                        }
                      </button>
                    }
                  }
                </div>

                @if (targetLangs().size === 0) {
                  <div class="hint">Select at least one target language, or skip this step to use existing translations.</div>
                } @else {
                  <div class="selection-summary">
                    Selected: {{ Array.from(targetLangs()).map(getLanguageName.bind(this)).join(', ') }}
                  </div>
                }
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
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="translateProvider() === 'claude'"
                    [class.disabled]="!hasClaudeKey()"
                    (click)="selectTranslateProvider('claude')"
                  >
                    <span class="provider-icon">🧠</span>
                    <span class="provider-name">Claude</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="translateProvider() === 'openai'"
                    [class.disabled]="!hasOpenAIKey()"
                    (click)="selectTranslateProvider('openai')"
                  >
                    <span class="provider-icon">🤖</span>
                    <span class="provider-name">OpenAI</span>
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
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 4: TTS -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">Configure voice synthesis for bilingual audiobook.</p>

              <!-- Source EPUB for TTS -->
              <div class="config-section">
                <label class="field-label">Source EPUB</label>
                <select
                  class="select-input"
                  [value]="sourceForTts()"
                  (change)="sourceForTts.set($any($event.target).value)"
                >
                  @for (epub of availableEpubs(); track epub.path) {
                    <option [value]="epub.path">{{ epub.filename }} ({{ getLanguageName(epub.lang) }})</option>
                  }
                </select>
              </div>

              <!-- Target EPUBs for TTS -->
              <div class="config-section">
                <label class="field-label">Target EPUBs for TTS</label>
                @if (targetsForTts().size > 0 || targetLangs().size > 0) {
                  <div class="target-epub-list">
                    @for (target of getTargetTtsOptions(); track target.path) {
                      <label class="target-checkbox">
                        <input
                          type="checkbox"
                          [checked]="targetsForTts().has(target.path)"
                          (change)="toggleTargetForTts(target.path)"
                        />
                        <span class="target-info">
                          <span class="target-filename">{{ target.filename }}</span>
                          <span class="target-lang">{{ getLanguageName(target.lang) }}</span>
                          @if (target.exists) {
                            <span class="target-exists">exists</span>
                          } @else {
                            <span class="target-new">will be created</span>
                          }
                        </span>
                      </label>
                    }
                  </div>
                } @else {
                  <div class="hint">No target languages selected. Go back to Translation step or select existing translated EPUBs.</div>
                }
              </div>

              <!-- TTS Engine Selection -->
              <div class="config-section">
                <label class="field-label">TTS Engine</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="ttsEngine() === 'xtts'"
                    (click)="selectTtsEngine('xtts')"
                  >
                    <span class="provider-name">XTTS</span>
                    <span class="provider-status">Multi-language</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="ttsEngine() === 'orpheus'"
                    (click)="selectTtsEngine('orpheus')"
                  >
                    <span class="provider-name">Orpheus</span>
                    <span class="provider-status">Better prosody</span>
                  </button>
                </div>
              </div>

              <!-- Device Selection -->
              <div class="config-section">
                <label class="field-label">Processing Device</label>
                <div class="provider-buttons">
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'cpu'" (click)="ttsDevice.set('cpu')">
                    <span class="provider-name">CPU</span>
                  </button>
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'mps'" (click)="ttsDevice.set('mps')">
                    <span class="provider-name">MPS</span>
                    <span class="provider-status">Apple Silicon</span>
                  </button>
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'gpu'" (click)="ttsDevice.set('gpu')">
                    <span class="provider-name">GPU</span>
                    <span class="provider-status">CUDA</span>
                  </button>
                </div>
              </div>

              <!-- Parallel Workers (XTTS only) -->
              @if (ttsEngine() === 'xtts') {
                <div class="config-section">
                  <label class="field-label">Parallel Workers</label>
                  <div class="worker-options">
                    @for (count of [1, 2, 3, 4]; track count) {
                      <button class="worker-btn" [class.selected]="ttsWorkers() === count" (click)="ttsWorkers.set(count)">
                        {{ count }}
                      </button>
                    }
                  </div>
                  <span class="hint">More workers = faster, but uses ~5GB RAM each</span>
                </div>
              }

              <!-- Voice Settings per Language -->
              <div class="config-section">
                <label class="field-label">Voice Settings</label>
                <div class="voice-settings">
                  <!-- Source Language Voice -->
                  <div class="voice-row">
                    <span class="voice-lang">{{ detectedSourceLang().toUpperCase() }}</span>
                    <select
                      class="voice-select"
                      [value]="getVoiceForLang(detectedSourceLang())"
                      (change)="setVoiceForLang(detectedSourceLang(), $any($event.target).value)"
                    >
                      @for (voice of getVoicesForEngine(); track voice.value) {
                        <option [value]="voice.value">{{ voice.label }}</option>
                      }
                    </select>
                    <input
                      type="range"
                      class="speed-slider"
                      min="0.5"
                      max="2"
                      step="0.05"
                      [value]="getSpeedForLang(detectedSourceLang())"
                      (input)="setSpeedForLang(detectedSourceLang(), $any($event.target).value)"
                    />
                    <span class="speed-label">{{ getSpeedForLang(detectedSourceLang()) }}x</span>
                  </div>

                  <!-- Target Languages Voices -->
                  @for (lang of Array.from(targetLangs()); track lang) {
                    <div class="voice-row">
                      <span class="voice-lang">{{ lang.toUpperCase() }}</span>
                      <select
                        class="voice-select"
                        [value]="getVoiceForLang(lang)"
                        (change)="setVoiceForLang(lang, $any($event.target).value)"
                      >
                        @for (voice of getVoicesForEngine(); track voice.value) {
                          <option [value]="voice.value">{{ voice.label }}</option>
                        }
                      </select>
                      <input
                        type="range"
                        class="speed-slider"
                        min="0.5"
                        max="2"
                        step="0.05"
                        [value]="getSpeedForLang(lang)"
                        (input)="setSpeedForLang(lang, $any($event.target).value)"
                      />
                      <span class="speed-label">{{ getSpeedForLang(lang) }}x</span>
                    </div>
                  }
                </div>
              </div>

              <!-- Assembly Pattern -->
              <div class="config-section">
                <label class="field-label">Assembly Pattern</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="assemblyPattern() === 'interleaved'"
                    (click)="assemblyPattern.set('interleaved')"
                  >
                    <span class="provider-name">Interleaved</span>
                    <span class="provider-status">EN-DE-EN-DE...</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="assemblyPattern() === 'sequential'"
                    (click)="assemblyPattern.set('sequential')"
                  >
                    <span class="provider-name">Sequential</span>
                    <span class="provider-status">All EN then all DE</span>
                  </button>
                </div>
              </div>

              <!-- Pause Duration -->
              <div class="config-section">
                <label class="field-label">Pause between sentences: {{ pauseDuration() }}s</label>
                <input
                  type="range"
                  class="full-width-slider"
                  min="0"
                  max="2"
                  step="0.1"
                  [value]="pauseDuration()"
                  (input)="pauseDuration.set(+$any($event.target).value)"
                />
              </div>
            </div>
          }
        }
      </div>

      <!-- Navigation -->
      <div class="wizard-nav">
        @if (currentStep() !== 'source') {
          <button class="btn-back" (click)="goBack()">
            ← Back
          </button>
        } @else {
          <button class="btn-back" (click)="back.emit()">
            ← Back
          </button>
        }

        <div class="nav-right">
          @if (currentStep() !== 'source' && currentStep() !== 'tts') {
            <button class="btn-skip" (click)="skipStep()">
              Skip
            </button>
          }
          @if (currentStep() !== 'tts') {
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

      &.scrollable {
        max-height: 100%;
        overflow-y: auto;
      }

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

    /* Loading/Empty States */
    .loading-state, .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: var(--text-secondary);
      text-align: center;
      gap: 12px;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-default);
      border-top-color: #06b6d4;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* EPUB Grid */
    .epub-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .epub-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 16px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;

      .epub-icon {
        font-size: 2rem;
      }

      .epub-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .epub-filename {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        word-break: break-all;
      }

      .epub-lang {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .epub-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: center;
      }

      .badge {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
      }

      .badge-source {
        background: rgba(59, 130, 246, 0.15);
        color: #3b82f6;
      }

      .badge-cleaned {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      .badge-translated {
        background: rgba(168, 85, 247, 0.15);
        color: #a855f7;
      }

      &:hover:not(.selected) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .epub-filename {
          color: #06b6d4;
        }
      }
    }

    .detected-lang {
      padding: 12px 16px;
      background: var(--bg-elevated);
      border-radius: 6px;
      font-size: 13px;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        font-weight: 500;
        margin-left: 8px;
      }
    }

    /* Config Sections */
    .config-section {
      margin-top: 16px;
    }

    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 8px;

      &:first-child {
        margin-top: 0;
      }
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

    /* Processing Options */
    .processing-options {
      margin-top: 16px;
    }

    .toggle-section-inline {
      display: flex;
      gap: 12px;

      .option-toggle {
        flex: 1;
      }
    }

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

    /* Language Grid */
    .source-lang-display {
      padding: 12px 16px;
      background: var(--bg-elevated);
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        font-weight: 500;
        margin-left: 8px;
      }
    }

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
      position: relative;

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
        color: var(--text-secondary);
      }

      .lang-check {
        position: absolute;
        top: 4px;
        right: 4px;
        font-size: 12px;
        color: #06b6d4;
        font-weight: bold;
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
    }

    .selection-summary {
      margin-top: 12px;
      padding: 8px 12px;
      background: rgba(6, 182, 212, 0.1);
      border: 1px solid rgba(6, 182, 212, 0.3);
      border-radius: 6px;
      font-size: 12px;
      color: #06b6d4;
    }

    .hint {
      display: block;
      margin-top: 8px;
      font-size: 11px;
      color: var(--text-tertiary);
    }

    /* Target EPUB List */
    .target-epub-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .target-checkbox {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      cursor: pointer;

      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: #06b6d4;
      }

      .target-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
      }

      .target-filename {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .target-lang {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .target-exists {
        font-size: 10px;
        padding: 2px 6px;
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border-radius: 4px;
      }

      .target-new {
        font-size: 10px;
        padding: 2px 6px;
        background: rgba(168, 85, 247, 0.15);
        color: #a855f7;
        border-radius: 4px;
      }
    }

    /* Voice Settings */
    .voice-settings {
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
        padding: 6px 10px;
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-primary);
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

    .full-width-slider {
      width: 100%;
      margin-top: 4px;
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
export class LLWizardComponent implements OnInit {
  private readonly settingsService = inject(SettingsService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);

  // Make Array available in template
  readonly Array = Array;

  // ─────────────────────────────────────────────────────────────────────────
  // Inputs/Outputs
  // ─────────────────────────────────────────────────────────────────────────

  readonly projectId = input.required<string>();
  readonly projectDir = input.required<string>();
  readonly projectTitle = input<string>('');
  readonly initialSourceLang = input<string>('en');

  readonly queued = output<void>();
  readonly back = output<void>();

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation State
  // ─────────────────────────────────────────────────────────────────────────

  readonly currentStep = signal<WizardStep>('source');
  private completedSteps = new Set<WizardStep>();
  private skippedSteps = new Set<WizardStep>();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Source
  // ─────────────────────────────────────────────────────────────────────────

  readonly scanningEpubs = signal(false);
  readonly availableEpubs = signal<AvailableEpub[]>([]);
  readonly selectedSourcePath = signal<string>('');
  readonly detectedSourceLang = signal<string>('en');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  readonly cleanupProvider = signal<AIProvider>('ollama');
  readonly cleanupModel = signal<string>('');
  readonly enableAiCleanup = signal(true);
  readonly simplifyForLearning = signal(false);
  readonly testMode = signal(false);
  readonly testModeChunks = signal(5);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Translation
  // ─────────────────────────────────────────────────────────────────────────

  readonly targetLangs = signal<Set<string>>(new Set());
  readonly translateProvider = signal<AIProvider>('ollama');
  readonly translateModel = signal<string>('');

  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: TTS
  // ─────────────────────────────────────────────────────────────────────────

  readonly ttsEngine = signal<'xtts' | 'orpheus'>('xtts');
  readonly ttsDevice = signal<'cpu' | 'mps' | 'gpu'>('cpu');
  readonly ttsWorkers = signal(2);
  readonly sourceForTts = signal<string>('');
  readonly targetsForTts = signal<Set<string>>(new Set());
  readonly languageVoices = signal<Record<string, { voice: string; speed: number }>>({});
  readonly assemblyPattern = signal<'interleaved' | 'sequential'>('interleaved');
  readonly pauseDuration = signal(0.5);

  // Voice options
  readonly xttsVoices = [
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
    { value: 'DavidAttenborough', label: 'David Attenborough' },
    { value: 'BobRoss', label: 'Bob Ross' },
    { value: 'MorganFreeman', label: 'Morgan Freeman' },
    { value: 'internal', label: 'Default XTTS' },
  ];

  readonly orpheusVoices = [
    { value: 'tara', label: 'Tara (Female)' },
    { value: 'leah', label: 'Leah (Female)' },
    { value: 'mia', label: 'Mia (Female)' },
    { value: 'jess', label: 'Jess (Female)' },
    { value: 'zoe', label: 'Zoe (Female)' },
    { value: 'leo', label: 'Leo (Male)' },
    { value: 'dan', label: 'Dan (Male)' },
    { value: 'zac', label: 'Zac (Male)' },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // Connection/Model State
  // ─────────────────────────────────────────────────────────────────────────

  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly loadingModels = signal(false);
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // Queue State
  // ─────────────────────────────────────────────────────────────────────────

  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // ─────────────────────────────────────────────────────────────────────────
  // Computed Values
  // ─────────────────────────────────────────────────────────────────────────

  readonly hasClaudeKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.claude.apiKey;
  });

  readonly hasOpenAIKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.openai.apiKey;
  });

  readonly cleanupModels = computed(() => {
    const provider = this.cleanupProvider();
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  });

  readonly translateModels = computed(() => {
    const provider = this.translateProvider();
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  constructor() {
    // Set up effect to update sourceForTts when entering TTS step
    effect(() => {
      if (this.currentStep() === 'tts') {
        this.onEnterTtsStep();
      }
    });
  }

  ngOnInit(): void {
    this.detectedSourceLang.set(this.initialSourceLang());
    this.initializeFromSettings();
    this.checkOllamaConnection();
    this.scanProjectEpubs();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();

    // Default to Ollama
    this.cleanupProvider.set('ollama');
    this.cleanupModel.set(config.ollama.model || 'llama3.2');
    this.translateProvider.set('ollama');
    this.translateModel.set(config.ollama.model || 'llama3.2');

    // Pre-fetch other providers' models
    if (config.claude.apiKey) {
      this.fetchClaudeModels(config.claude.apiKey);
    }
    if (config.openai.apiKey) {
      this.fetchOpenAIModels(config.openai.apiKey);
    }

    // Initialize default voice settings
    this.initializeVoiceSettings();
  }

  private initializeVoiceSettings(): void {
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    const sourceLang = this.detectedSourceLang();

    this.languageVoices.set({
      [sourceLang]: { voice: defaultVoice, speed: 1.0 }
    });
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

        // Validate selected models exist
        if (models.length > 0) {
          if (!this.cleanupModel() || !models.some((m: { value: string }) => m.value === this.cleanupModel())) {
            this.cleanupModel.set(models[0].value);
          }
          if (!this.translateModel() || !models.some((m: { value: string }) => m.value === this.translateModel())) {
            this.translateModel.set(models[0].value);
          }
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
      }
    } catch (err) {
      console.error('Failed to fetch OpenAI models:', err);
    } finally {
      this.loadingModels.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Source Selection
  // ─────────────────────────────────────────────────────────────────────────

  async scanProjectEpubs(): Promise<void> {
    this.scanningEpubs.set(true);
    try {
      // Get list of files in project directory
      const files = await this.electronService.listDirectory(this.projectDir());
      const epubs: AvailableEpub[] = [];

      for (const file of files) {
        if (file.endsWith('.epub')) {
          const path = `${this.projectDir()}/${file}`;
          const filename = file;
          const lang = this.detectLanguageFromFilename(filename);
          const isSource = filename.includes('source') || filename.includes('original') || filename === 'article.epub';
          const isTranslated = /^[a-z]{2}\.epub$/.test(filename);
          const isCleaned = filename.includes('cleaned');

          epubs.push({ path, filename, lang, isSource, isTranslated, isCleaned });
        }
      }

      this.availableEpubs.set(epubs);

      // Auto-select the most appropriate source
      const defaultEpub = epubs.find(e => e.isCleaned) ||
                          epubs.find(e => e.isSource) ||
                          epubs[0];
      if (defaultEpub) {
        this.selectSource(defaultEpub.path, defaultEpub.lang);
      }
    } catch (err) {
      console.error('Failed to scan project EPUBs:', err);
      this.availableEpubs.set([]);
    } finally {
      this.scanningEpubs.set(false);
    }
  }

  private detectLanguageFromFilename(filename: string): string {
    // Check for language code patterns like "de.epub", "ko.epub"
    const match = filename.match(/^([a-z]{2})\.epub$/);
    if (match) {
      return match[1];
    }
    // Default to source language
    return this.initialSourceLang();
  }

  selectSource(path: string, lang: string): void {
    this.selectedSourcePath.set(path);
    this.detectedSourceLang.set(lang);
    this.sourceForTts.set(path);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Cleanup Provider Selection
  // ─────────────────────────────────────────────────────────────────────────

  selectCleanupProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.cleanupProvider.set(provider);
    const models = this.getModelsForProvider(provider);
    if (models.length > 0) {
      this.cleanupModel.set(models[0].value);
    }
  }

  selectTranslateProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.translateProvider.set(provider);
    const models = this.getModelsForProvider(provider);
    if (models.length > 0) {
      this.translateModel.set(models[0].value);
    }
  }

  private getModelsForProvider(provider: AIProvider): { value: string; label: string }[] {
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Translation
  // ─────────────────────────────────────────────────────────────────────────

  isTargetLangSelected(code: string): boolean {
    return this.targetLangs().has(code);
  }

  toggleTargetLang(code: string): void {
    const current = new Set(this.targetLangs());
    if (current.has(code)) {
      current.delete(code);
    } else {
      current.add(code);
      // Initialize voice settings for new language
      const voices = this.languageVoices();
      if (!voices[code]) {
        const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';
        this.languageVoices.set({
          ...voices,
          [code]: { voice: defaultVoice, speed: 0.85 }  // Slower for target language
        });
      }
    }
    this.targetLangs.set(current);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: TTS
  // ─────────────────────────────────────────────────────────────────────────

  private onEnterTtsStep(): void {
    // Set sourceForTts to selected source or cleaned version
    if (!this.sourceForTts()) {
      this.sourceForTts.set(this.selectedSourcePath());
    }

    // Populate targetsForTts based on translation selections or existing files
    if (this.skippedSteps.has('translate')) {
      // User skipped translation - check for existing translated EPUBs
      const existing = this.availableEpubs().filter(e =>
        e.isTranslated && e.lang !== this.detectedSourceLang()
      );
      const targets = new Set(existing.map(e => e.path));
      this.targetsForTts.set(targets);
    } else {
      // User selected translations - populate with expected output paths
      const targets = new Set<string>();
      for (const lang of this.targetLangs()) {
        targets.add(`${this.projectDir()}/${lang}.epub`);
      }
      this.targetsForTts.set(targets);
    }
  }

  getTargetTtsOptions(): { path: string; filename: string; lang: string; exists: boolean }[] {
    const options: { path: string; filename: string; lang: string; exists: boolean }[] = [];

    // Add existing translated EPUBs
    const existingPaths = new Set(this.availableEpubs().filter(e => e.isTranslated).map(e => e.path));

    // Add from selected target languages
    for (const lang of this.targetLangs()) {
      const path = `${this.projectDir()}/${lang}.epub`;
      const exists = existingPaths.has(path);
      options.push({
        path,
        filename: `${lang}.epub`,
        lang,
        exists
      });
    }

    // Add existing EPUBs that weren't in target selections
    for (const epub of this.availableEpubs()) {
      if (epub.isTranslated && !this.targetLangs().has(epub.lang)) {
        options.push({
          path: epub.path,
          filename: epub.filename,
          lang: epub.lang,
          exists: true
        });
      }
    }

    return options;
  }

  toggleTargetForTts(path: string): void {
    const current = new Set(this.targetsForTts());
    if (current.has(path)) {
      current.delete(path);
    } else {
      current.add(path);
    }
    this.targetsForTts.set(current);
  }

  selectTtsEngine(engine: 'xtts' | 'orpheus'): void {
    this.ttsEngine.set(engine);
    if (engine === 'orpheus') {
      this.ttsWorkers.set(1);  // Orpheus doesn't benefit from parallel
    }
    // Update voice selections to engine defaults
    const newVoices: Record<string, { voice: string; speed: number }> = {};
    const defaultVoice = engine === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    for (const [lang, settings] of Object.entries(this.languageVoices())) {
      newVoices[lang] = { voice: defaultVoice, speed: settings.speed };
    }
    this.languageVoices.set(newVoices);
  }

  getVoicesForEngine(): { value: string; label: string }[] {
    return this.ttsEngine() === 'orpheus' ? this.orpheusVoices : this.xttsVoices;
  }

  getVoiceForLang(lang: string): string {
    const voices = this.languageVoices();
    return voices[lang]?.voice || (this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson');
  }

  setVoiceForLang(lang: string, voice: string): void {
    const voices = this.languageVoices();
    const current = voices[lang] || { voice: '', speed: 1.0 };
    this.languageVoices.set({
      ...voices,
      [lang]: { ...current, voice }
    });
  }

  getSpeedForLang(lang: string): number {
    const voices = this.languageVoices();
    return voices[lang]?.speed || 1.0;
  }

  setSpeedForLang(lang: string, speed: string | number): void {
    const voices = this.languageVoices();
    const current = voices[lang] || { voice: this.getVoiceForLang(lang), speed: 1.0 };
    this.languageVoices.set({
      ...voices,
      [lang]: { ...current, speed: parseFloat(speed.toString()) }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  isStepCompleted(step: WizardStep): boolean {
    return this.completedSteps.has(step);
  }

  isStepSkipped(step: WizardStep): boolean {
    return this.skippedSteps.has(step);
  }

  canProceed(): boolean {
    const step = this.currentStep();
    if (step === 'source') {
      return !!this.selectedSourcePath();
    }
    if (step === 'cleanup') {
      const provider = this.cleanupProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.cleanupModel();
      return !!this.cleanupModel();
    }
    if (step === 'translate') {
      // Can always proceed - either have selections or will skip
      if (this.targetLangs().size === 0) return true;  // Can skip
      const provider = this.translateProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.translateModel();
      return !!this.translateModel();
    }
    return true;
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
      case 'source':
        this.currentStep.set('cleanup');
        break;
      case 'cleanup':
        this.currentStep.set('translate');
        break;
      case 'translate':
        // If no target languages selected, mark as skipped
        if (this.targetLangs().size === 0) {
          this.skippedSteps.add('translate');
        }
        this.currentStep.set('tts');
        break;
    }
  }

  goBack(): void {
    const step = this.currentStep();

    switch (step) {
      case 'cleanup':
        this.currentStep.set('source');
        break;
      case 'translate':
        this.currentStep.set('cleanup');
        break;
      case 'tts':
        this.currentStep.set('translate');
        break;
    }
  }

  hasAnyTask(): boolean {
    const hasCleanup = !this.skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning());
    const hasTranslate = !this.skippedSteps.has('translate') && this.targetLangs().size > 0;
    const hasTts = this.targetsForTts().size > 0 || !!this.sourceForTts();
    return hasCleanup || hasTranslate || hasTts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue Jobs
  // ─────────────────────────────────────────────────────────────────────────

  async addToQueue(): Promise<void> {
    if (!this.hasAnyTask()) return;

    this.addingToQueue.set(true);

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();
      let currentEpubPath = this.selectedSourcePath();

      // 1. Cleanup job (if not skipped and has processing selected)
      if (!this.skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning())) {
        await this.queueService.addJob({
          type: 'bilingual-cleanup',
          epubPath: currentEpubPath,
          projectDir: this.projectDir(),
          metadata: {
            title: 'AI Cleanup',
          },
          config: {
            type: 'bilingual-cleanup',
            projectId: this.projectId(),
            projectDir: this.projectDir(),
            sourceLang: this.detectedSourceLang(),
            aiProvider: this.cleanupProvider(),
            aiModel: this.cleanupModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
          },
          workflowId,
        });
        currentEpubPath = `${this.projectDir()}/cleaned.epub`;
      }

      // 2. Translation jobs (if not skipped, one per target language)
      if (!this.skippedSteps.has('translate') && this.targetLangs().size > 0) {
        for (const targetLang of this.targetLangs()) {
          await this.queueService.addJob({
            type: 'bilingual-translation',
            epubPath: currentEpubPath,
            projectDir: this.projectDir(),
            metadata: {
              title: `Translate → ${this.getLanguageName(targetLang)}`,
            },
            config: {
              type: 'bilingual-translation',
              projectId: this.projectId(),
              projectDir: this.projectDir(),
              sourceLang: this.detectedSourceLang(),
              targetLang,
              aiProvider: this.translateProvider(),
              aiModel: this.translateModel(),
              ollamaBaseUrl: aiConfig.ollama?.baseUrl,
              claudeApiKey: aiConfig.claude?.apiKey,
              openaiApiKey: aiConfig.openai?.apiKey,
              testMode: this.testMode(),
              testModeChunks: this.testModeChunks(),
            },
            workflowId,
          });
        }
      }

      // 3. TTS jobs (source + each target) and assembly
      if (this.sourceForTts() || this.targetsForTts().size > 0) {
        const sourceLang = this.detectedSourceLang();
        const sourceVoice = this.getVoiceForLang(sourceLang);
        const sourceSpeed = this.getSpeedForLang(sourceLang);

        // Source TTS
        if (this.sourceForTts()) {
          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: this.sourceForTts(),
            projectDir: this.projectDir(),
            metadata: {
              title: `TTS (${sourceLang.toUpperCase()})`,
            },
            config: {
              type: 'tts-conversion',
              device: this.ttsDevice(),
              language: sourceLang,
              ttsEngine: this.ttsEngine(),
              fineTuned: sourceVoice,
              speed: sourceSpeed,
              temperature: 0.7,
              topP: 0.9,
              topK: 50,
              repetitionPenalty: 1.0,
              enableTextSplitting: true,
              useParallel: this.ttsEngine() === 'xtts',
              parallelMode: 'sentences',
              parallelWorkers: this.ttsWorkers(),
              sentencePerParagraph: true,
              skipHeadings: true,
              cleanSession: true,
            },
            workflowId,
          });
        }

        // Target TTS + Assembly for each
        for (const targetPath of this.targetsForTts()) {
          const targetLang = this.getLanguageFromPath(targetPath);
          const targetVoice = this.getVoiceForLang(targetLang);
          const targetSpeed = this.getSpeedForLang(targetLang);

          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: targetPath,
            projectDir: this.projectDir(),
            metadata: {
              title: `TTS (${targetLang.toUpperCase()})`,
            },
            config: {
              type: 'tts-conversion',
              device: this.ttsDevice(),
              language: targetLang,
              ttsEngine: this.ttsEngine(),
              fineTuned: targetVoice,
              speed: targetSpeed,
              temperature: 0.7,
              topP: 0.9,
              topK: 50,
              repetitionPenalty: 1.0,
              enableTextSplitting: true,
              useParallel: this.ttsEngine() === 'xtts',
              parallelMode: 'sentences',
              parallelWorkers: this.ttsWorkers(),
              sentencePerParagraph: true,
              skipHeadings: true,
              cleanSession: true,
              skipAssembly: true,  // Assembly happens separately
            },
            workflowId,
          });

          // Assembly job for this language pair
          await this.queueService.addJob({
            type: 'bilingual-assembly',
            projectDir: this.projectDir(),
            metadata: {
              title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
            },
            config: {
              type: 'bilingual-assembly',
              projectId: this.projectId(),
              sourceSentencesDir: `${this.projectDir()}/sentences/${sourceLang}`,
              targetSentencesDir: `${this.projectDir()}/sentences/${targetLang}`,
              sentencePairsPath: `${this.projectDir()}/sentence_pairs_${targetLang}.json`,
              outputDir: this.projectDir(),
              pauseDuration: this.pauseDuration(),
              gapDuration: 1.0,
              sourceLang,
              targetLang,
              title: this.projectTitle(),
              pattern: this.assemblyPattern(),
            },
            workflowId,
          });
        }
      }

      console.log('[LLWizard] Jobs added to queue:', {
        workflowId,
        cleanup: !this.skippedSteps.has('cleanup'),
        translations: Array.from(this.targetLangs()),
        ttsTargets: Array.from(this.targetsForTts()),
      });

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[LLWizard] Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  private generateWorkflowId(): string {
    return `ll-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  private getLanguageFromPath(path: string): string {
    const filename = path.split('/').pop() || '';
    const match = filename.match(/^([a-z]{2})\.epub$/);
    return match ? match[1] : 'en';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getLanguageName(code: string): string {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    if (lang) return lang.name;
    if (code === 'en') return 'English';
    return code.toUpperCase();
  }

  getFlagCss(code: string): string {
    const flags: Record<string, string> = {
      'de': 'linear-gradient(to bottom, #000 33.3%, #DD0000 33.3% 66.6%, #FFCE00 66.6%)',
      'es': 'linear-gradient(to bottom, #AA151B 25%, #F1BF00 25% 75%, #AA151B 75%)',
      'fr': 'linear-gradient(to right, #002395 33.3%, #FFF 33.3% 66.6%, #ED2939 66.6%)',
      'it': 'linear-gradient(to right, #008C45 33.3%, #F4F5F0 33.3% 66.6%, #CD212A 66.6%)',
      'pt': 'linear-gradient(to right, #006600 40%, #FF0000 40%)',
      'nl': 'linear-gradient(to bottom, #AE1C28 33.3%, #FFF 33.3% 66.6%, #21468B 66.6%)',
      'pl': 'linear-gradient(to bottom, #FFF 50%, #DC143C 50%)',
      'ru': 'linear-gradient(to bottom, #FFF 33.3%, #0039A6 33.3% 66.6%, #D52B1E 66.6%)',
      'ja': 'radial-gradient(circle, #BC002D 25%, #FFF 25%)',
      'zh': 'radial-gradient(circle at 28% 35%, #FFDE00 8%, #DE2910 8%)',
      'ko': 'radial-gradient(circle at 50% 40%, #CD2E3A 18%, transparent 18%), radial-gradient(circle at 50% 60%, #0047A0 18%, transparent 18%), linear-gradient(#FFF, #FFF)',
    };
    return flags[code] || 'linear-gradient(#666, #666)';
  }
}

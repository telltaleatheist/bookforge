/**
 * LLWizard - Language Learning Pipeline Wizard v2
 *
 * A 5-step wizard for processing EPUBs through the language learning pipeline:
 * 1. AI Cleanup - Clean OCR/formatting OR simplify for learners (skippable)
 * 2. Translation - Select multiple target languages (skippable)
 * 3. TTS - Configure TTS for multiple languages with per-language rows (skippable)
 * 4. Assembly - Interleave source + target sentences (skippable)
 * 5. Review - Summary before submission (required)
 *
 * Key principle: Each step has its own source dropdown with "Latest" as default.
 * Pipeline-aware source selection means each step uses output of previous step if available.
 */

import { Component, input, output, signal, computed, inject, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService } from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { LibraryService } from '../../../../core/services/library.service';
import { QueueService } from '../../../queue/services/queue.service';
import {
  SUPPORTED_LANGUAGES,
  TtsLanguageRow,
  SessionCache,
  LLWizardStep,
  SourceDropdownOption,
  AvailableEpub
} from '../../models/language-learning.types';
import { AIProvider } from '../../../../core/models/ai-config.types';

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
        <div class="step" [class.active]="currentStep() === 'assembly'" [class.completed]="isStepCompleted('assembly')" [class.skipped]="isStepSkipped('assembly')">
          <span class="step-num">4</span>
          <span class="step-label">Assembly</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'review'" [class.completed]="isStepCompleted('review')">
          <span class="step-num">5</span>
          <span class="step-label">Review</span>
        </div>
      </div>

      <!-- Step Content -->
      <div class="step-content">
        @switch (currentStep()) {
          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 1: AI Cleanup -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('cleanup') {
            <div class="step-panel">
              <h3>AI Cleanup</h3>
              <p class="step-desc">Clean up OCR artifacts and formatting issues using AI.</p>

              <!-- Source EPUB Selection -->
              <div class="config-section">
                <label class="field-label">Source EPUB</label>
                <select
                  class="select-input"
                  [value]="cleanupSourceEpub()"
                  (change)="cleanupSourceEpub.set($any($event.target).value)"
                >
                  <option value="latest">Latest</option>
                  @for (epub of availableEpubs(); track epub.path) {
                    <option [value]="epub.path">{{ epub.filename }} ({{ getLanguageName(epub.lang) }})</option>
                  }
                </select>
                <span class="hint">Latest: uses finalized.epub or original.epub</span>
              </div>

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

              <!-- Start Fresh vs Use Existing (only show if cleaned.epub exists) -->
              @if (hasExistingCleaned()) {
                <div class="config-section">
                  <label class="field-label">Cleanup Mode</label>
                  <div class="provider-buttons">
                    <button
                      class="provider-btn"
                      [class.selected]="startFreshCleanup()"
                      (click)="startFreshCleanup.set(true)"
                    >
                      <span class="provider-icon">🆕</span>
                      <span class="provider-name">Start Fresh</span>
                      <span class="provider-status">Process from source EPUB</span>
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="!startFreshCleanup()"
                      (click)="startFreshCleanup.set(false)"
                    >
                      <span class="provider-icon">♻️</span>
                      <span class="provider-name">Use Existing</span>
                      <span class="provider-status">Apply to cleaned.epub</span>
                    </button>
                  </div>
                </div>
              }

              <!-- Processing Options -->
              <div class="processing-options">
                <label class="field-label">Processing Options</label>

                <!-- AI Cleanup Option -->
                <div class="toggle-section-inline">
                  <button
                    class="option-toggle"
                    [class.active]="enableAiCleanup()"
                    (click)="toggleAiCleanup()"
                  >
                    <span class="toggle-icon">🔧</span>
                    <span class="toggle-label">AI Cleanup</span>
                    <span class="toggle-sublabel">Fix OCR errors & formatting</span>
                  </button>

                  <!-- Simplify for Language Learning Option -->
                  <button
                    class="option-toggle"
                    [class.active]="simplifyForLearning()"
                    (click)="toggleSimplify()"
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
          <!-- Step 2: Translation -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('translate') {
            <div class="step-panel scrollable">
              <h3>Translation</h3>
              <p class="step-desc">Select target languages for bilingual audiobook. Multiple selections allowed.</p>

              <!-- Source EPUB Selection -->
              <div class="config-section">
                <label class="field-label">Source EPUB</label>
                <select
                  class="select-input"
                  [value]="translateSourceEpub()"
                  (change)="translateSourceEpub.set($any($event.target).value)"
                >
                  <option value="latest">Latest</option>
                  @for (epub of availableEpubs(); track epub.path) {
                    <option [value]="epub.path">{{ epub.filename }} ({{ getLanguageName(epub.lang) }})</option>
                  }
                </select>
                <span class="hint">Latest: uses cleaned.epub, finalized.epub, or original.epub</span>
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

              <!-- Test Mode -->
              <div class="config-section">
                <label class="field-label">Test Mode</label>
                <div class="worker-options">
                  <button class="worker-btn" [class.selected]="!translateTestMode()" (click)="translateTestMode.set(false)">
                    Full
                  </button>
                  @for (count of [3, 5, 10, 20]; track count) {
                    <button class="worker-btn" [class.selected]="translateTestChunks() === count && translateTestMode()" (click)="translateTestMode.set(true); translateTestChunks.set(count)">
                      {{ count }}
                    </button>
                  }
                </div>
                <span class="hint">Test mode translates only first N chunks</span>
              </div>

              <!-- Source Language Display -->
              <div class="source-lang-display">
                <span class="label">Detected source language:</span>
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
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 3: TTS -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">Configure voice synthesis for each language. Each row becomes a separate TTS job.</p>

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

              <!-- Test Mode -->
              <div class="config-section">
                <label class="field-label">Test Mode</label>
                <div class="worker-options">
                  <button class="worker-btn" [class.selected]="!ttsTestMode()" (click)="ttsTestMode.set(false)">
                    Full
                  </button>
                  @for (count of [5, 10, 20, 50]; track count) {
                    <button class="worker-btn" [class.selected]="ttsTestSentences() === count && ttsTestMode()" (click)="ttsTestMode.set(true); ttsTestSentences.set(count)">
                      {{ count }}
                    </button>
                  }
                </div>
                <span class="hint">Test mode processes only first N sentences</span>
              </div>

              <!-- Language Rows -->
              <div class="config-section">
                <label class="field-label">Languages to Generate</label>

                <div class="language-rows">
                  @for (row of ttsLanguageRows(); track row.id; let i = $index) {
                    <div class="language-row">
                      <select
                        class="lang-select"
                        [value]="row.language"
                        (change)="updateTtsRow(i, 'language', $any($event.target).value)"
                      >
                        @for (lang of availableTtsLanguages(); track lang.code) {
                          <option [value]="lang.code">{{ lang.code.toUpperCase() }} - {{ lang.name }}</option>
                        }
                      </select>

                      <select
                        class="source-select"
                        [value]="row.sourceEpub"
                        (change)="updateTtsRow(i, 'sourceEpub', $any($event.target).value)"
                      >
                        <option value="latest">Latest</option>
                        @for (epub of availableEpubs(); track epub.path) {
                          <option [value]="epub.path">{{ epub.filename }}</option>
                        }
                      </select>

                      <select
                        class="voice-select"
                        [value]="row.voice"
                        (change)="updateTtsRow(i, 'voice', $any($event.target).value)"
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
                        [value]="row.speed"
                        (input)="updateTtsRow(i, 'speed', +$any($event.target).value)"
                      />
                      <span class="speed-label">{{ row.speed }}x</span>

                      <button class="remove-row-btn" (click)="removeTtsRow(i)" [disabled]="ttsLanguageRows().length <= 1">
                        ✕
                      </button>
                    </div>
                  }
                </div>

                <button class="add-row-btn" (click)="addTtsRow()">
                  + Add Language
                </button>
              </div>
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 4: Assembly -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('assembly') {
            <div class="step-panel">
              <h3>Bilingual Assembly</h3>
              <p class="step-desc">Interleave source and target sentences into a bilingual audiobook.</p>

              <!-- Available Sessions -->
              <div class="config-section">
                <label class="field-label">Source Sentences</label>
                <select
                  class="select-input"
                  [value]="assemblySourceLang()"
                  (change)="assemblySourceLang.set($any($event.target).value)"
                >
                  @if (availableSessions().length === 0) {
                    <option value="">No TTS sessions available</option>
                  }
                  @for (session of availableSessions(); track session.language) {
                    <option [value]="session.language">
                      {{ session.language.toUpperCase() }} ({{ session.sentenceCount }} sentences)
                    </option>
                  }
                  @for (lang of ttsLanguageRows(); track lang.id) {
                    @if (!hasSessionForLang(lang.language)) {
                      <option [value]="lang.language">
                        {{ lang.language.toUpperCase() }} (will be created by TTS)
                      </option>
                    }
                  }
                </select>
              </div>

              <div class="config-section">
                <label class="field-label">Target Sentences</label>
                <select
                  class="select-input"
                  [value]="assemblyTargetLang()"
                  (change)="assemblyTargetLang.set($any($event.target).value)"
                >
                  @if (availableSessions().length === 0 && ttsLanguageRows().length <= 1) {
                    <option value="">No TTS sessions available</option>
                  }
                  @for (session of availableSessions(); track session.language) {
                    @if (session.language !== assemblySourceLang()) {
                      <option [value]="session.language">
                        {{ session.language.toUpperCase() }} ({{ session.sentenceCount }} sentences)
                      </option>
                    }
                  }
                  @for (lang of ttsLanguageRows(); track lang.id) {
                    @if (!hasSessionForLang(lang.language) && lang.language !== assemblySourceLang()) {
                      <option [value]="lang.language">
                        {{ lang.language.toUpperCase() }} (will be created by TTS)
                      </option>
                    }
                  }
                </select>
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

              <!-- Gap Duration -->
              <div class="config-section">
                <label class="field-label">Gap between pairs: {{ gapDuration() }}s</label>
                <input
                  type="range"
                  class="full-width-slider"
                  min="0"
                  max="3"
                  step="0.1"
                  [value]="gapDuration()"
                  (input)="gapDuration.set(+$any($event.target).value)"
                />
              </div>

              @if (!assemblySourceLang() || !assemblyTargetLang()) {
                <div class="warning-banner">
                  Select both source and target languages for assembly, or skip this step.
                </div>
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 5: Review -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('review') {
            <div class="step-panel">
              <h3>Review & Submit</h3>
              <p class="step-desc">Review your pipeline configuration before adding to queue.</p>

              <div class="review-cards">
                <!-- Cleanup Card -->
                @if (!isStepSkipped('cleanup') && (enableAiCleanup() || simplifyForLearning())) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔧</span>
                      <span class="review-card-title">AI Cleanup</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">{{ cleanupSourceEpub() === 'latest' ? 'Latest' : getFilenameFromPath(cleanupSourceEpub()) }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Provider:</span>
                        <span class="review-value">{{ cleanupProvider() }} / {{ cleanupModel() }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Mode:</span>
                        <span class="review-value">
                          {{ enableAiCleanup() ? 'AI Cleanup' : simplifyForLearning() ? 'Simplify for Learning' : 'None' }}
                        </span>
                      </div>
                      @if (testMode()) {
                        <div class="review-row">
                          <span class="review-label">Test:</span>
                          <span class="review-value">First {{ testModeChunks() }} chunks</span>
                        </div>
                      }
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔧</span>
                      <span class="review-card-title">AI Cleanup</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- Translation Card -->
                @if (!isStepSkipped('translate') && targetLangs().size > 0) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🌐</span>
                      <span class="review-card-title">Translation</span>
                      <span class="job-count">{{ targetLangs().size }} job{{ targetLangs().size > 1 ? 's' : '' }}</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">{{ translateSourceEpub() === 'latest' ? 'Latest' : getFilenameFromPath(translateSourceEpub()) }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Languages:</span>
                        <span class="review-value">{{ Array.from(targetLangs()).map(getLanguageName.bind(this)).join(', ') }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Provider:</span>
                        <span class="review-value">{{ translateProvider() }} / {{ translateModel() }}</span>
                      </div>
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🌐</span>
                      <span class="review-card-title">Translation</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- TTS Card -->
                @if (!isStepSkipped('tts') && ttsLanguageRows().length > 0) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔊</span>
                      <span class="review-card-title">TTS</span>
                      <span class="job-count">{{ ttsLanguageRows().length }} job{{ ttsLanguageRows().length > 1 ? 's' : '' }}</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Engine:</span>
                        <span class="review-value">{{ ttsEngine().toUpperCase() }} / {{ ttsDevice().toUpperCase() }}</span>
                      </div>
                      @for (row of ttsLanguageRows(); track row.id) {
                        <div class="review-row">
                          <span class="review-label">{{ row.language.toUpperCase() }}:</span>
                          <span class="review-value">{{ row.voice }} @ {{ row.speed }}x</span>
                        </div>
                      }
                      @if (ttsTestMode()) {
                        <div class="review-row">
                          <span class="review-label">Test:</span>
                          <span class="review-value">First {{ ttsTestSentences() }} sentences</span>
                        </div>
                      }
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔊</span>
                      <span class="review-card-title">TTS</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- Assembly Card -->
                @if (!isStepSkipped('assembly') && assemblySourceLang() && assemblyTargetLang()) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🎵</span>
                      <span class="review-card-title">Assembly</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Pair:</span>
                        <span class="review-value">{{ assemblySourceLang().toUpperCase() }} + {{ assemblyTargetLang().toUpperCase() }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Pattern:</span>
                        <span class="review-value">{{ assemblyPattern() }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Timing:</span>
                        <span class="review-value">{{ pauseDuration() }}s pause, {{ gapDuration() }}s gap</span>
                      </div>
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🎵</span>
                      <span class="review-card-title">Assembly</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }
              </div>

              <!-- Job Count Summary -->
              <div class="job-summary">
                <span class="job-summary-label">Total jobs to create:</span>
                <span class="job-summary-value">{{ getTotalJobCount() }}</span>
              </div>

              <!-- Warnings -->
              @if (getReviewWarnings().length > 0) {
                <div class="review-warnings">
                  @for (warning of getReviewWarnings(); track warning) {
                    <div class="warning-item">⚠️ {{ warning }}</div>
                  }
                </div>
              }

              @if (getTotalJobCount() === 0) {
                <div class="warning-banner">
                  No jobs to create. Go back and configure at least one step.
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
          <button class="btn-back" (click)="back.emit()">
            ← Back
          </button>
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
              [disabled]="getTotalJobCount() === 0 || addingToQueue() || addedToQueue()"
              (click)="addToQueue()"
            >
              @if (addingToQueue()) {
                Adding...
              } @else if (addedToQueue()) {
                ✓ Added to Queue
              } @else {
                Add to Queue ({{ getTotalJobCount() }} jobs)
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
      padding: 8px 12px;
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
      width: 16px;
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

    /* Language Rows (TTS) */
    .language-rows {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .language-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      .lang-select {
        width: 140px;
        padding: 6px 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-primary);
      }

      .source-select {
        width: 140px;
        padding: 6px 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-primary);
      }

      .voice-select {
        flex: 1;
        min-width: 120px;
        padding: 6px 8px;
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
        width: 40px;
        font-size: 12px;
        color: var(--text-secondary);
        text-align: right;
      }

      .remove-row-btn {
        padding: 4px 8px;
        background: transparent;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-muted);
        cursor: pointer;
        transition: all 0.15s;

        &:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.15);
          border-color: #ef4444;
          color: #ef4444;
        }

        &:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
      }
    }

    .add-row-btn {
      margin-top: 8px;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px dashed var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
        border-color: #06b6d4;
        color: #06b6d4;
      }
    }

    /* Review Cards */
    .review-cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .review-card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;

      &.skipped {
        opacity: 0.5;

        .review-card-header {
          background: var(--bg-subtle);
        }
      }
    }

    .review-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(6, 182, 212, 0.1);
      border-bottom: 1px solid var(--border-subtle);

      .review-card-icon {
        font-size: 16px;
      }

      .review-card-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
      }

      .job-count {
        font-size: 11px;
        padding: 2px 8px;
        background: #06b6d4;
        color: white;
        border-radius: 10px;
      }

      .skipped-badge {
        font-size: 11px;
        padding: 2px 8px;
        background: var(--text-muted);
        color: white;
        border-radius: 10px;
      }
    }

    .review-card-content {
      padding: 12px;
    }

    .review-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      font-size: 12px;

      .review-label {
        color: var(--text-secondary);
      }

      .review-value {
        color: var(--text-primary);
        font-weight: 500;
      }
    }

    .job-summary {
      margin-top: 16px;
      padding: 16px;
      background: var(--bg-elevated);
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;

      .job-summary-label {
        font-size: 14px;
        color: var(--text-secondary);
      }

      .job-summary-value {
        font-size: 24px;
        font-weight: 700;
        color: #06b6d4;
      }
    }

    .review-warnings {
      margin-top: 12px;
      padding: 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid var(--warning);
      border-radius: 6px;

      .warning-item {
        font-size: 12px;
        color: var(--warning);
        padding: 4px 0;
      }
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

  // Primary inputs (compatible with bilingual-wizard for Studio integration)
  readonly epubPath = input<string>('');
  readonly originalEpubPath = input<string>('');
  readonly title = input<string>('');
  readonly author = input<string>('');
  readonly itemType = input<'book' | 'article'>('book');
  readonly bfpPath = input<string>('');
  readonly projectId = input<string>('');
  readonly projectDir = input<string>('');
  readonly audiobookFolder = input<string>('');

  // Language Learning specific inputs
  readonly projectTitle = input<string>('');
  readonly initialSourceLang = input<string>('en');

  readonly queued = output<void>();
  readonly back = output<void>();

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation State
  // ─────────────────────────────────────────────────────────────────────────

  readonly currentStep = signal<LLWizardStep>('cleanup');
  private completedSteps = new Set<LLWizardStep>();
  private _skippedSteps = new Set<LLWizardStep>();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  readonly cleanupSourceEpub = signal<string>('latest');
  readonly cleanupProvider = signal<AIProvider>('ollama');
  readonly cleanupModel = signal<string>('');
  readonly enableAiCleanup = signal(false);  // Start with neither selected
  readonly simplifyForLearning = signal(false);
  readonly testMode = signal(false);
  readonly testModeChunks = signal(5);
  readonly startFreshCleanup = signal(true);  // Default to start fresh
  readonly hasExistingCleaned = computed(() => {
    return this.availableEpubs().some(e => e.filename === 'cleaned.epub');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Translation
  // ─────────────────────────────────────────────────────────────────────────

  readonly translateSourceEpub = signal<string>('latest');
  readonly targetLangs = signal<Set<string>>(new Set());
  readonly translateProvider = signal<AIProvider>('ollama');
  readonly translateModel = signal<string>('');
  readonly detectedSourceLang = signal<string>('en');
  readonly translateTestMode = signal(false);
  readonly translateTestChunks = signal(5);

  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: TTS
  // ─────────────────────────────────────────────────────────────────────────

  readonly ttsEngine = signal<'xtts' | 'orpheus'>('xtts');
  readonly ttsDevice = signal<'cpu' | 'mps' | 'gpu'>('cpu');
  readonly ttsWorkers = signal(2);
  readonly ttsTestMode = signal(false);
  readonly ttsTestSentences = signal(10);
  readonly ttsLanguageRows = signal<TtsLanguageRow[]>([]);

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
  // Step 4: Assembly
  // ─────────────────────────────────────────────────────────────────────────

  readonly assemblySourceLang = signal<string>('');
  readonly assemblyTargetLang = signal<string>('');
  readonly assemblyPattern = signal<'interleaved' | 'sequential'>('interleaved');
  readonly pauseDuration = signal(0.5);
  readonly gapDuration = signal(1.0);
  readonly availableSessions = signal<SessionCache[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // EPUBs State
  // ─────────────────────────────────────────────────────────────────────────

  readonly scanningEpubs = signal(false);
  readonly availableEpubs = signal<AvailableEpub[]>([]);

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

  /**
   * Effective project directory - uses projectDir if provided,
   * otherwise derives from epubPath or bfpPath
   */
  readonly effectiveProjectDir = computed(() => {
    // Prefer explicit projectDir
    if (this.projectDir()) {
      return this.projectDir();
    }
    // Derive from epubPath (parent directory)
    if (this.epubPath()) {
      const parts = this.epubPath().split('/');
      parts.pop(); // Remove filename
      return parts.join('/');
    }
    // Derive from bfpPath
    if (this.bfpPath()) {
      const parts = this.bfpPath().split('/');
      parts.pop(); // Remove .bfp filename
      return parts.join('/');
    }
    return '';
  });

  /**
   * Available languages for TTS - source language + selected target languages.
   * If translate step is skipped, only source language is available.
   */
  readonly availableTtsLanguages = computed(() => {
    const sourceLang = this.detectedSourceLang();
    const targets = this.targetLangs();
    const isTranslateSkipped = this._skippedSteps.has('translate');

    const languages: { code: string; name: string }[] = [
      { code: sourceLang, name: this.getLanguageName(sourceLang) }
    ];

    // Add target languages if translate step is not skipped
    if (!isTranslateSkipped && targets.size > 0) {
      for (const code of targets) {
        languages.push({ code, name: this.getLanguageName(code) });
      }
    }

    return languages;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  constructor() {
    // Sync TTS language rows when target languages change
    effect(() => {
      const targets = this.targetLangs();
      const sourceLang = this.detectedSourceLang();
      this.syncTtsRowsWithTargets(sourceLang, targets);
    });
  }

  ngOnInit(): void {
    console.log('[LL-WIZARD] Component initializing with:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());

    this.detectedSourceLang.set(this.initialSourceLang());
    this.initializeFromSettings();
    this.checkOllamaConnection();
    this.scanProjectEpubs();
    this.scanAvailableSessions();
    this.initializeDefaultTtsRows();

    console.log('[LL-WIZARD] After initialization:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());
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
  }

  private initializeDefaultTtsRows(): void {
    const sourceLang = this.detectedSourceLang();
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';

    this.ttsLanguageRows.set([{
      id: `tts-${Date.now()}`,
      language: sourceLang,
      sourceEpub: 'latest',
      voice: defaultVoice,
      speed: 1.0
    }]);
  }

  private syncTtsRowsWithTargets(sourceLang: string, targets: Set<string>): void {
    const currentRows = this.ttsLanguageRows();
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';

    // Ensure source language row exists
    const hasSource = currentRows.some(r => r.language === sourceLang);
    if (!hasSource && currentRows.length === 0) {
      this.ttsLanguageRows.update(rows => [...rows, {
        id: `tts-${Date.now()}`,
        language: sourceLang,
        sourceEpub: 'latest',
        voice: defaultVoice,
        speed: 1.0
      }]);
    }

    // Add rows for new target languages
    for (const lang of targets) {
      const hasLang = currentRows.some(r => r.language === lang);
      if (!hasLang) {
        this.ttsLanguageRows.update(rows => [...rows, {
          id: `tts-${Date.now()}-${lang}`,
          language: lang,
          sourceEpub: 'latest',
          voice: defaultVoice,
          speed: 0.85 // Slower for target language
        }]);
      }
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
  // EPUB Scanning
  // ─────────────────────────────────────────────────────────────────────────

  async scanProjectEpubs(): Promise<void> {
    const dir = this.effectiveProjectDir();
    if (!dir) {
      this.availableEpubs.set([]);
      return;
    }

    this.scanningEpubs.set(true);
    try {
      const files = await this.electronService.listDirectory(dir);
      const epubs: AvailableEpub[] = [];

      for (const file of files) {
        if (file.endsWith('.epub')) {
          const filePath = `${dir}/${file}`;
          const lang = this.detectLanguageFromFilename(file);
          const isSource = file === 'exported.epub' || file.includes('original') || file === 'article.epub' || file === 'finalized.epub';
          const isTranslated = /^[a-z]{2}\.epub$/.test(file);
          const isCleaned = file.includes('cleaned');

          epubs.push({
            path: filePath,
            filename: file,
            lang,
            isSource,
            isTranslated,
            isCleaned
          });
        }
      }

      this.availableEpubs.set(epubs);
    } catch (err) {
      console.error('Failed to scan project EPUBs:', err);
      this.availableEpubs.set([]);
    } finally {
      this.scanningEpubs.set(false);
    }
  }

  private detectLanguageFromFilename(filename: string): string {
    const match = filename.match(/^([a-z]{2})\.epub$/);
    if (match) {
      return match[1];
    }
    return this.initialSourceLang();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Scanning (for Assembly)
  // ─────────────────────────────────────────────────────────────────────────

  async scanAvailableSessions(): Promise<void> {
    const dir = this.effectiveProjectDir();
    if (!dir) {
      this.availableSessions.set([]);
      return;
    }

    try {
      // Use the proper session cache API
      const result = await this.electronService.listProjectSessions(dir);

      if (result.success && result.data) {
        const sessions: SessionCache[] = result.data.map(s => ({
          language: s.language,
          sessionDir: s.sessionDir,
          sentenceCount: s.sentenceCount,
          createdAt: s.createdAt
        }));
        this.availableSessions.set(sessions);

        // Set default assembly languages if we have sessions
        if (sessions.length >= 2) {
          const sourceLang = this.detectedSourceLang();
          const sourceSession = sessions.find(s => s.language === sourceLang);
          const targetSession = sessions.find(s => s.language !== sourceLang);

          if (sourceSession) {
            this.assemblySourceLang.set(sourceSession.language);
          }
          if (targetSession) {
            this.assemblyTargetLang.set(targetSession.language);
          }
        }
      } else {
        this.availableSessions.set([]);
      }
    } catch (err) {
      console.error('Failed to scan sessions:', err);
      this.availableSessions.set([]);
    }
  }

  hasSessionForLang(lang: string): boolean {
    return this.availableSessions().some(s => s.language === lang);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Selection
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
  // Translation
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
    }
    this.targetLangs.set(current);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TTS
  // ─────────────────────────────────────────────────────────────────────────

  selectTtsEngine(engine: 'xtts' | 'orpheus'): void {
    this.ttsEngine.set(engine);
    if (engine === 'orpheus') {
      this.ttsWorkers.set(1);
    }

    // Update all rows to use new engine's default voice
    const defaultVoice = engine === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    this.ttsLanguageRows.update(rows =>
      rows.map(row => ({ ...row, voice: defaultVoice }))
    );
  }

  getVoicesForEngine(): { value: string; label: string }[] {
    return this.ttsEngine() === 'orpheus' ? this.orpheusVoices : this.xttsVoices;
  }

  addTtsRow(): void {
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    const existingLangs = new Set(this.ttsLanguageRows().map(r => r.language));
    const availableLangs = this.availableTtsLanguages();

    // Find a language that's not already added from available languages
    let newLang = this.detectedSourceLang();
    for (const lang of availableLangs) {
      if (!existingLangs.has(lang.code)) {
        newLang = lang.code;
        break;
      }
    }

    this.ttsLanguageRows.update(rows => [...rows, {
      id: `tts-${Date.now()}`,
      language: newLang,
      sourceEpub: 'latest',
      voice: defaultVoice,
      speed: newLang === this.detectedSourceLang() ? 1.0 : 0.85
    }]);
  }

  removeTtsRow(index: number): void {
    this.ttsLanguageRows.update(rows => rows.filter((_, i) => i !== index));
  }

  updateTtsRow(index: number, field: keyof TtsLanguageRow, value: any): void {
    this.ttsLanguageRows.update(rows =>
      rows.map((row, i) => i === index ? { ...row, [field]: value } : row)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  isStepCompleted(step: LLWizardStep): boolean {
    return this.completedSteps.has(step);
  }

  isStepSkipped(step: LLWizardStep): boolean {
    return this._skippedSteps.has(step);
  }

  toggleAiCleanup(): void {
    if (!this.enableAiCleanup()) {
      // Turning on AI Cleanup - turn off simplify
      this.enableAiCleanup.set(true);
      this.simplifyForLearning.set(false);
    } else {
      // Turning off AI Cleanup
      this.enableAiCleanup.set(false);
    }
  }

  toggleSimplify(): void {
    if (!this.simplifyForLearning()) {
      // Turning on Simplify - turn off AI Cleanup
      console.log('[LL-WIZARD] Enabling simplify for learning, disabling AI cleanup');
      this.simplifyForLearning.set(true);
      this.enableAiCleanup.set(false);
    } else {
      // Turning off Simplify
      console.log('[LL-WIZARD] Disabling simplify for learning');
      this.simplifyForLearning.set(false);
    }
    console.log('[LL-WIZARD] Current state: simplify=', this.simplifyForLearning(), 'cleanup=', this.enableAiCleanup());
  }

  canProceed(): boolean {
    const step = this.currentStep();
    if (step === 'cleanup') {
      if (!this.enableAiCleanup() && !this.simplifyForLearning()) {
        return true; // Can skip
      }
      const provider = this.cleanupProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.cleanupModel();
      return !!this.cleanupModel();
    }
    if (step === 'translate') {
      if (this.targetLangs().size === 0) return true; // Can skip
      const provider = this.translateProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.translateModel();
      return !!this.translateModel();
    }
    if (step === 'tts') {
      return this.ttsLanguageRows().length > 0;
    }
    if (step === 'assembly') {
      return true; // Always can proceed, will skip if no langs selected
    }
    return true;
  }

  skipStep(): void {
    const step = this.currentStep();
    this._skippedSteps.add(step);
    this.goNext();
  }

  goNext(): void {
    const step = this.currentStep();
    if (!this._skippedSteps.has(step)) {
      this.completedSteps.add(step);
    }

    const stepOrder: LLWizardStep[] = ['cleanup', 'translate', 'tts', 'assembly', 'review'];
    const currentIndex = stepOrder.indexOf(step);
    if (currentIndex < stepOrder.length - 1) {
      const nextStep = stepOrder[currentIndex + 1];

      // Auto-skip translate if no languages selected
      if (nextStep === 'translate' && this.targetLangs().size === 0 && !this.completedSteps.has('translate')) {
        // Don't auto-skip, let user decide
      }

      // Auto-skip assembly if no source/target
      if (step === 'assembly' && (!this.assemblySourceLang() || !this.assemblyTargetLang())) {
        this._skippedSteps.add('assembly');
      }

      this.currentStep.set(nextStep);

      // Rescan sessions when entering assembly step
      if (nextStep === 'assembly') {
        this.scanAvailableSessions();
      }
    }
  }

  goBack(): void {
    const stepOrder: LLWizardStep[] = ['cleanup', 'translate', 'tts', 'assembly', 'review'];
    const currentIndex = stepOrder.indexOf(this.currentStep());
    if (currentIndex > 0) {
      this.currentStep.set(stepOrder[currentIndex - 1]);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Review Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getTotalJobCount(): number {
    let count = 0;

    // Cleanup job
    if (!this._skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning())) {
      count += 1;
    }

    // Translation jobs (one per language)
    if (!this._skippedSteps.has('translate') && this.targetLangs().size > 0) {
      count += this.targetLangs().size;
    }

    // TTS jobs (one per row)
    if (!this._skippedSteps.has('tts')) {
      count += this.ttsLanguageRows().length;
    }

    // Assembly job
    if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
      count += 1;
    }

    return count;
  }

  getReviewWarnings(): string[] {
    const warnings: string[] = [];

    // Check if TTS references a language that won't exist
    const ttsLangs = new Set(this.ttsLanguageRows().map(r => r.language));
    const translationLangs = this.targetLangs();
    const availableSessionLangs = new Set(this.availableSessions().map(s => s.language));

    for (const lang of ttsLangs) {
      if (lang !== this.detectedSourceLang() &&
          !translationLangs.has(lang) &&
          !availableSessionLangs.has(lang) &&
          !this.availableEpubs().some(e => e.lang === lang)) {
        warnings.push(`TTS row for ${lang.toUpperCase()} has no source EPUB or translation job`);
      }
    }

    // Check assembly references
    if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
      const sourceLang = this.assemblySourceLang();
      const targetLang = this.assemblyTargetLang();

      const hasSourceSession = availableSessionLangs.has(sourceLang) || ttsLangs.has(sourceLang);
      const hasTargetSession = availableSessionLangs.has(targetLang) || ttsLangs.has(targetLang);

      if (!hasSourceSession) {
        warnings.push(`Assembly source (${sourceLang.toUpperCase()}) has no TTS session or job`);
      }
      if (!hasTargetSession) {
        warnings.push(`Assembly target (${targetLang.toUpperCase()}) has no TTS session or job`);
      }
    }

    return warnings;
  }

  getFilenameFromPath(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue Jobs
  // ─────────────────────────────────────────────────────────────────────────

  async addToQueue(): Promise<void> {
    if (this.getTotalJobCount() === 0) return;

    const projectDir = this.effectiveProjectDir();
    if (!projectDir) {
      console.error('[LLWizard] No project directory available');
      return;
    }

    this.addingToQueue.set(true);

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();

      // 1. Cleanup job (if not skipped and has processing selected)
      if (!this._skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning())) {
        const simplifyValue = this.simplifyForLearning();
        const cleanupValue = this.enableAiCleanup();
        // Prompts are now loaded from files on the backend (electron/prompts/)
        const cleanupPromptValue = undefined; // Backend will load appropriate prompt from file

        console.log('[LL-WIZARD] Signal values at job creation:');
        console.log('[LL-WIZARD]   simplifyForLearning signal:', simplifyValue);
        console.log('[LL-WIZARD]   enableAiCleanup signal:', cleanupValue);
        console.log('[LL-WIZARD]   cleanupPrompt being sent:', cleanupPromptValue ? 'PROVIDED' : 'UNDEFINED');

        const jobConfig = {
          type: 'bilingual-cleanup' as const,
          projectId: this.projectId(),
          projectDir: projectDir,
          sourceLang: this.detectedSourceLang(),
          aiProvider: this.cleanupProvider(),
          aiModel: this.cleanupModel(),
          ollamaBaseUrl: aiConfig.ollama?.baseUrl,
          claudeApiKey: aiConfig.claude?.apiKey,
          openaiApiKey: aiConfig.openai?.apiKey,
          testMode: this.testMode(),
          testModeChunks: this.testModeChunks(),
          cleanupPrompt: cleanupPromptValue,
          simplifyForLearning: simplifyValue,
          startFresh: this.startFreshCleanup(),
        };

        console.log('[LL-WIZARD] Full job config being sent:', JSON.stringify(jobConfig, null, 2));

        // If not starting fresh and cleaned.epub exists, use it as source
        let cleanupSource = this.resolveLatestSource('cleanup');
        if (!this.startFreshCleanup() && this.hasExistingCleaned()) {
          const cleanedEpub = this.availableEpubs().find(e => e.filename === 'cleaned.epub');
          if (cleanedEpub) {
            cleanupSource = cleanedEpub.path;
          }
        }

        await this.queueService.addJob({
          type: 'bilingual-cleanup',
          epubPath: cleanupSource,
          projectDir: projectDir,
          metadata: {
            title: 'AI Cleanup',
          },
          config: jobConfig,
          workflowId,
        });
      }

      // 2. Translation jobs (if not skipped, one per target language)
      if (!this._skippedSteps.has('translate') && this.targetLangs().size > 0) {
        for (const targetLang of this.targetLangs()) {
          await this.queueService.addJob({
            type: 'bilingual-translation',
            epubPath: this.resolveLatestSource('translate'),
            projectDir: projectDir,
            metadata: {
              title: `Translate → ${this.getLanguageName(targetLang)}`,
            },
            config: {
              type: 'bilingual-translation',
              projectId: this.projectId(),
              projectDir: projectDir,
              sourceLang: this.detectedSourceLang(),
              targetLang,
              aiProvider: this.translateProvider(),
              aiModel: this.translateModel(),
              ollamaBaseUrl: aiConfig.ollama?.baseUrl,
              claudeApiKey: aiConfig.claude?.apiKey,
              openaiApiKey: aiConfig.openai?.apiKey,
              testMode: this.translateTestMode(),
              testModeChunks: this.translateTestChunks(),
            },
            workflowId,
          });
        }
      }

      // 3. TTS jobs (one per language row)
      if (!this._skippedSteps.has('tts')) {
        for (const row of this.ttsLanguageRows()) {
          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: this.resolveTtsSource(row),
            projectDir: projectDir,
            metadata: {
              title: `TTS (${row.language.toUpperCase()})`,
            },
            config: {
              type: 'tts-conversion',
              device: this.ttsDevice(),
              language: row.language,
              ttsEngine: this.ttsEngine(),
              fineTuned: row.voice,
              speed: row.speed,
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
              testMode: this.ttsTestMode(),
              testSentences: this.ttsTestSentences(),
              // Cache session to project folder
              cacheToProject: true,
              projectDir: projectDir,
            },
            workflowId,
          });
        }
      }

      // 4. Assembly job
      if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
        const sourceLang = this.assemblySourceLang();
        const targetLang = this.assemblyTargetLang();

        await this.queueService.addJob({
          type: 'bilingual-assembly',
          projectDir: projectDir,
          metadata: {
            title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
          },
          config: {
            type: 'bilingual-assembly',
            projectId: this.projectId(),
            sourceSentencesDir: `${projectDir}/sessions/${sourceLang}/sentences`,
            targetSentencesDir: `${projectDir}/sessions/${targetLang}/sentences`,
            sentencePairsPath: `${projectDir}/sentence_pairs_${targetLang}.json`,
            outputDir: projectDir,
            pauseDuration: this.pauseDuration(),
            gapDuration: this.gapDuration(),
            sourceLang,
            targetLang,
            title: this.projectTitle() || this.title(),
            pattern: this.assemblyPattern(),
          },
          workflowId,
        });
      }

      console.log('[LLWizard] Jobs added to queue:', {
        workflowId,
        cleanup: !this._skippedSteps.has('cleanup'),
        translations: Array.from(this.targetLangs()),
        ttsRows: this.ttsLanguageRows().map(r => r.language),
        assembly: this.assemblySourceLang() && this.assemblyTargetLang(),
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

  /**
   * Resolve "latest" source EPUB based on pipeline stage
   */
  private resolveLatestSource(stage: 'cleanup' | 'translate'): string {
    const sourceSignal = stage === 'cleanup' ? this.cleanupSourceEpub : this.translateSourceEpub;
    const source = sourceSignal();

    if (source !== 'latest') {
      return source;
    }

    const epubs = this.availableEpubs();
    const projectDir = this.effectiveProjectDir();

    if (stage === 'cleanup') {
      // Cleanup: finalized.epub > exported.epub > original.epub > article.epub
      const finalized = epubs.find(e => e.filename === 'finalized.epub');
      if (finalized) return finalized.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub' || e.filename === 'article.epub');
      if (original) return original.path;
    } else if (stage === 'translate') {
      // Translation: cleaned.epub > finalized.epub > exported.epub > original.epub > article.epub
      const cleaned = epubs.find(e => e.filename === 'cleaned.epub');
      if (cleaned) return cleaned.path;
      const finalized = epubs.find(e => e.filename === 'finalized.epub');
      if (finalized) return finalized.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub' || e.filename === 'article.epub');
      if (original) return original.path;
    }

    // Fallback: first available EPUB
    if (epubs.length > 0) {
      return epubs[0].path;
    }

    // Ultimate fallback
    return `${projectDir}/article.epub`;
  }

  /**
   * Resolve TTS source EPUB based on language
   */
  private resolveTtsSource(row: TtsLanguageRow): string {
    if (row.sourceEpub !== 'latest') {
      return row.sourceEpub;
    }

    const epubs = this.availableEpubs();
    const lang = row.language;
    const sourceLang = this.detectedSourceLang();
    const projectDir = this.effectiveProjectDir();

    if (lang === sourceLang) {
      // Source language: cleaned.epub > finalized.epub > exported.epub > original.epub
      const cleaned = epubs.find(e => e.filename === 'cleaned.epub');
      if (cleaned) return cleaned.path;
      const finalized = epubs.find(e => e.filename === 'finalized.epub');
      if (finalized) return finalized.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub' || e.filename === 'article.epub');
      if (original) return original.path;
    } else {
      // Target language: {lang}.epub (created by translation)
      const langEpub = epubs.find(e => e.filename === `${lang}.epub`);
      if (langEpub) return langEpub.path;

      // Fallback: will be created by translation job
      return `${projectDir}/${lang}.epub`;
    }

    // Fallback
    return `${projectDir}/article.epub`;
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
      'el': 'repeating-linear-gradient(to bottom, #0D5EAF 0%, #0D5EAF 11.1%, white 11.1%, white 22.2%)',
    };
    return flags[code] || 'linear-gradient(#666, #666)';
  }
}

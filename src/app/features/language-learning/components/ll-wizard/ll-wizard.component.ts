/**
 * The unified processing pipeline wizard (formerly LLWizard).
 *
 * One 5-step wizard for ALL audiobook production:
 * 1. AI Cleanup - Clean OCR/formatting OR simplify for learners (skippable)
 * 2. Translation - mode switch: Whole book (single narration) vs
 *    Sentence-aligned (language learning, multiple target languages) (skippable)
 * 3. TTS - single voice (whole-book) or per-language rows (sentence-aligned) (skippable)
 * 4. Assembly - M4B+VTT reassembly (whole-book) or bilingual interleave (skippable)
 * 5. Review - Summary before submission (required)
 *
 * The translate mode drives the pipeline shape ("mono" vs "bilingual"), and each
 * mode submits exactly the job types its predecessor wizard submitted — the merge
 * is a UI consolidation, not a backend change.
 *
 * Key principle: Each step has its own source picker with "Latest" as default.
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
import { ComponentService } from '../../../../core/services/component.service';
import { OcrCleanupConfig, TtsConversionConfig, ReassemblyJobConfig } from '../../../queue/models/queue.types';
import { EpubResolverService } from '../../services/epub-resolver.service';
import { AiService } from '../../../../core/services/ai.service';
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
// Source Stage Types
// ─────────────────────────────────────────────────────────────────────────────

interface SourceStage {
  id: 'original' | 'exported' | 'cleaned' | 'simplified' | 'translated';
  label: string;
  completed: boolean;
  path: string;
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
        <div class="step" [class.active]="currentStep() === 'cleanup'" [class.completed]="isStepCompleted('cleanup')" [class.skipped]="isStepSkipped('cleanup')" [class.has-data]="hasStageData('cleanup')">
          <span class="step-num">1</span>
          <span class="step-label">AI Cleanup</span>
          @if (hasStageData('cleanup')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'translate'" [class.completed]="isStepCompleted('translate')" [class.skipped]="isStepSkipped('translate')" [class.has-data]="hasStageData('translate')">
          <span class="step-num">2</span>
          <span class="step-label">Translate</span>
          @if (hasStageData('translate')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'tts'" [class.completed]="isStepCompleted('tts')" [class.skipped]="isStepSkipped('tts')" [class.has-data]="hasStageData('tts')">
          <span class="step-num">3</span>
          <span class="step-label">TTS</span>
          @if (hasStageData('tts')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'assembly'" [class.completed]="isStepCompleted('assembly')" [class.skipped]="isStepSkipped('assembly')" [class.has-data]="hasStageData('assembly')">
          <span class="step-num">4</span>
          <span class="step-label">Assembly</span>
          @if (hasStageData('assembly')) { <span class="data-dot" title="Data exists"></span> }
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

              <!-- No AI configured → gray out behind a layover that links to the wizard -->
              @if (ai.checkedOnce() && !ai.available()) {
                <div class="ai-layover">
                  <div class="ai-layover-card">
                    <div class="ai-layover-icon">&#129302;</div>
                    <h4>Set up an AI to use cleanup</h4>
                    <p>AI cleanup needs an AI source — a bundled local model, Ollama, or a Claude/OpenAI API key.</p>
                    <button class="ai-layover-btn" (click)="openAiSetup()">Open AI Setup</button>
                  </div>
                </div>
              }

              <!-- Existing cleanup notice -->
              @if (hasExistingCleanup()) {
                <div class="existing-cleanup-banner">
                  <span>Previous cleanup found. Running again will resume where it left off.</span>
                  <button class="start-over-btn" (click)="clearCleanupStage()">Start Over</button>
                </div>
              }

              <!-- Source EPUB Selection -->
              <div class="config-section">
                <label class="field-label">Source EPUB</label>
                <div class="source-stages">
                  @for (stage of cleanupSourceStages(); track stage.id) {
                    <button
                      class="stage-btn"
                      [class.selected]="isStageSelected('cleanup', stage)"
                      [class.completed]="stage.completed"
                      [disabled]="!stage.completed"
                      (click)="selectStage('cleanup', stage)"
                    >
                      {{ stage.label }}
                      @if (stage.completed) {
                        <span class="stage-check">&#10003;</span>
                      }
                    </button>
                  }
                </div>
              </div>

              <!-- AI Model — unified selector: only configured sources, grouped by provider -->
              <div class="config-section">
                <label class="field-label">AI Model</label>
                @if (aiSourceGroups().length > 0) {
                  <select
                    class="select-input"
                    [value]="cleanupSelection()"
                    (change)="onCleanupModelChange($any($event.target).value)"
                  >
                    @for (group of aiSourceGroups(); track group.provider) {
                      <optgroup [label]="group.label">
                        @for (m of group.models; track m.value) {
                          <option
                            [value]="group.provider + '::' + m.value"
                            [selected]="(group.provider + '::' + m.value) === cleanupSelection()"
                          >{{ m.label }}@if (m.active) {  (active)}</option>
                        }
                      </optgroup>
                    }
                  </select>
                } @else {
                  <div class="no-models">
                    @if (checkingConnection()) {
                      Checking for available AI…
                    } @else {
                      <span class="error-text">No AI configured.</span> Set up a local model, Ollama, or an API key.
                    }
                  </div>
                }
                @if (!allAiConfigured()) {
                  <button class="configure-ai-btn" (click)="openAiSetup()">⚙ Configure AI</button>
                }
              </div>

              <!-- Start Fresh / Use Existing removed — source picker handles input selection,
                   backend always overwrites output (startFresh defaults to true) -->

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
              <div class="config-section">
                <label class="field-label">Test Mode</label>
                <div class="worker-options">
                  <button
                    class="worker-btn"
                    [class.selected]="!testMode()"
                    (click)="testMode.set(false)"
                  >
                    Full
                  </button>
                  @for (count of [3, 5, 10, 20]; track count) {
                    <button
                      class="worker-btn"
                      [class.selected]="testModeChunks() === count && testMode()"
                      (click)="testMode.set(true); testModeChunks.set(count)"
                    >
                      {{ count }}
                    </button>
                  }
                </div>
                <span class="hint">Test mode processes only first N chunks</span>
              </div>

              <!-- Custom Instructions -->
              <div class="config-section">
                <label class="field-label">Custom Instructions</label>
                <textarea
                  class="custom-instructions"
                  [value]="customInstructions()"
                  (input)="customInstructions.set($any($event.target).value)"
                  placeholder="Optional: Add specific instructions for the AI (e.g., 'Format numbered lists with periods at the end of each item')"
                  rows="3"
                ></textarea>
                <span class="hint">Appended to the AI prompt for both cleanup and simplify</span>
              </div>

              <!-- Parallel Workers (cloud providers, whole-book pipeline) -->
              @if (pipelineMode() === 'mono' && (cleanupProvider() === 'claude' || cleanupProvider() === 'openai') && itemType() === 'book') {
                <div class="config-section">
                  <label class="field-label">Parallel Workers</label>
                  <div class="worker-options">
                    @for (count of [1, 2, 4, 8]; track count) {
                      <button class="worker-btn" [class.selected]="cleanupParallelWorkers() === count" (click)="cleanupParallelWorkers.set(count)">
                        {{ count }}
                      </button>
                    }
                  </div>
                  <span class="hint">Concurrent API requests for Claude/OpenAI</span>
                </div>
              }

              <!-- AI Prompt Editor -->
              <div class="accordion" [class.open]="promptAccordionOpen()">
                <button class="accordion-header" (click)="togglePromptAccordion()">
                  <span class="accordion-title">AI Prompt</span>
                  <span class="accordion-icon">{{ promptAccordionOpen() ? '▼' : '▶' }}</span>
                </button>
                @if (promptAccordionOpen()) {
                  <div class="accordion-content">
                    @if (loadingPrompt()) {
                      <div class="hint">Loading prompt...</div>
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

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 2: Translation -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('translate') {
            <div class="step-panel scrollable">
              <h3>Translation</h3>
              <p class="step-desc">
                @switch (translateMode()) {
                  @case ('whole-book') {
                    Translate the whole book into another language before narration.
                  }
                  @case ('sentence') {
                    Select target languages for a bilingual audiobook. Multiple selections allowed.
                  }
                  @default {
                    Pick a translation type to translate this book — or just hit Next to continue without translation.
                  }
                }
              </p>

              <!-- Translation Type — selecting one opts into translation and drives the pipeline shape -->
              <div class="config-section">
                <label class="field-label">Translation Type</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="translateMode() === 'whole-book'"
                    (click)="selectTranslateMode('whole-book')"
                  >
                    <span class="provider-name">Whole Book</span>
                    <span class="provider-status">Single narration</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="translateMode() === 'sentence'"
                    (click)="selectTranslateMode('sentence')"
                  >
                    <span class="provider-name">Language Learning</span>
                    <span class="provider-status">Sentence-aligned</span>
                  </button>
                </div>
              </div>

              @if (translateMode()) {

              <!-- Source EPUB Selection -->
              <div class="config-section">
                <label class="field-label">Source EPUB</label>
                <div class="source-stages">
                  @for (stage of translateSourceStages(); track stage.id) {
                    <button
                      class="stage-btn"
                      [class.selected]="isStageSelected('translate', stage)"
                      [class.completed]="stage.completed"
                      [disabled]="!stage.completed"
                      (click)="selectStage('translate', stage)"
                    >
                      {{ stage.label }}
                      @if (stage.completed) {
                        <span class="stage-check">&#10003;</span>
                      }
                    </button>
                  }
                </div>
              </div>

              <!-- AI Model — unified selector: only configured sources, grouped by provider -->
              <div class="config-section">
                <label class="field-label">AI Model</label>
                @if (aiSourceGroups().length > 0) {
                  <select
                    class="select-input"
                    [value]="translateSelection()"
                    (change)="onTranslateModelChange($any($event.target).value)"
                  >
                    @for (group of aiSourceGroups(); track group.provider) {
                      <optgroup [label]="group.label">
                        @for (m of group.models; track m.value) {
                          <option
                            [value]="group.provider + '::' + m.value"
                            [selected]="(group.provider + '::' + m.value) === translateSelection()"
                          >{{ m.label }}@if (m.active) {  (active)}</option>
                        }
                      </optgroup>
                    }
                  </select>
                } @else {
                  <div class="no-models">
                    @if (checkingConnection()) {
                      Checking for available AI…
                    } @else {
                      <span class="error-text">No AI configured.</span> Set up a local model, Ollama, or an API key.
                    }
                  </div>
                }
                @if (!allAiConfigured()) {
                  <button class="configure-ai-btn" (click)="openAiSetup()">⚙ Configure AI</button>
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

              <!-- Custom Instructions -->
              <div class="config-section">
                <label class="field-label">Custom Instructions</label>
                <textarea
                  class="custom-instructions"
                  [value]="translateCustomInstructions()"
                  (input)="translateCustomInstructions.set($any($event.target).value)"
                  placeholder="Optional: Add specific instructions for the AI (e.g., 'If you encounter English text, return it unchanged')"
                  rows="3"
                ></textarea>
                <span class="hint">Appended to the translation prompt for each batch</span>
              </div>

              <!-- Source Language Display -->
              <div class="source-lang-display">
                <span class="label">Detected source language:</span>
                <span class="value">{{ getLanguageName(detectedSourceLang()) }}</span>
              </div>

              @if (translateMode() === 'sentence') {
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
              } @else {
                <!-- Whole-book: single target language -->
                <div class="config-section">
                  <label class="field-label">Target Language</label>
                  <div class="language-grid">
                    @for (lang of supportedLanguages; track lang.code) {
                      @if (lang.code !== detectedSourceLang()) {
                        <button
                          class="language-btn"
                          [class.selected]="monoTargetLang() === lang.code"
                          (click)="monoTargetLang.set(lang.code)"
                        >
                          <span class="lang-flag" [style.background]="getFlagCss(lang.code)"></span>
                          <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                          <span class="lang-name">{{ lang.name }}</span>
                          @if (monoTargetLang() === lang.code) {
                            <span class="lang-check">✓</span>
                          }
                        </button>
                      }
                    }
                  </div>
                  <div class="hint">The whole book is translated to {{ getLanguageName(monoTargetLang()) }} and the translation is narrated.</div>
                </div>
              }

              <!-- Existing Translations (sentence-aligned outputs) -->
              @if (translateMode() === 'sentence' && existingTranslationEpubs().length > 0) {
                <div class="config-section">
                  <label class="field-label">Existing Translations</label>
                  <div class="existing-translations">
                    @for (epub of existingTranslationEpubs(); track epub.path) {
                      <div class="existing-translation-row">
                        <span class="existing-translation-label">{{ epub.lang.toUpperCase() }} — {{ getLanguageName(epub.lang) }}</span>
                        <button class="existing-translation-delete" (click)="deleteTranslationEpub(epub)">Delete</button>
                      </div>
                    }
                    @if (existingTranslationEpubs().length > 1) {
                      <button class="existing-translation-clear-all" (click)="deleteAllTranslationEpubs()">Clear All Translations</button>
                    }
                  </div>
                </div>
              }

              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 3: TTS -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">
                @if (pipelineMode() === 'mono') {
                  Configure the narration voice.
                } @else {
                  Configure voice synthesis for each language. Each row becomes a separate TTS job.
                }
              </p>

              <!-- Continue / New Toggle -->
              <div class="config-section">
                <label class="field-label">Mode</label>
                <div class="provider-buttons">
                  <button class="provider-btn"
                    [class.selected]="!continueTts()"
                    (click)="continueTts.set(false)">
                    <span class="provider-name">New</span>
                    <span class="provider-status">Start fresh</span>
                  </button>
                  <button class="provider-btn"
                    [class.selected]="continueTts()"
                    [disabled]="!partialTtsSessions().length"
                    (click)="partialTtsSessions().length && continueTts.set(true)">
                    <span class="provider-name">Continue</span>
                    <span class="provider-status">
                      @if (partialTtsSessions().length) {
                        {{ partialTtsSessions().length }} partial session{{ partialTtsSessions().length > 1 ? 's' : '' }}
                      } @else {
                        No partial sessions
                      }
                    </span>
                  </button>
                </div>
              </div>

              @if (continueTts()) {
              <!-- Continue mode: show partial session info -->
              <div class="config-section">
                @for (session of partialTtsSessions(); track session.language) {
                  <div class="hint" style="margin-bottom: 4px;">
                    {{ session.language.toUpperCase() }}: {{ session.completedSentences }}/{{ session.totalSentences }} sentences
                  </div>
                }
                <span class="hint">
                  Continuing from previous sessions. Voice, speed, and other settings from the original runs will be used.
                </span>
              </div>
              } @else {

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
                  @if (componentService.isInstalled('orpheus')) {
                    <button
                      class="provider-btn"
                      [class.selected]="ttsEngine() === 'orpheus'"
                      (click)="selectTtsEngine('orpheus')"
                    >
                      <span class="provider-name">Orpheus</span>
                      <span class="provider-status">Better prosody</span>
                    </button>
                  }
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

              @if (pipelineMode() === 'mono') {
                <!-- Source EPUB Selection -->
                <div class="config-section">
                  <label class="field-label">Source EPUB</label>
                  <div class="source-stages">
                    @for (stage of ttsSourceStages(); track stage.id) {
                      <button
                        class="stage-btn"
                        [class.selected]="isStageSelected('tts', stage)"
                        [class.completed]="stage.completed"
                        [disabled]="!stage.completed && !isStageSelected('tts', stage)"
                        (click)="selectStage('tts', stage)"
                      >
                        {{ stage.label }}
                        @if (stage.completed) {
                          <span class="stage-check">&#10003;</span>
                        }
                      </button>
                    }
                  </div>
                  <span class="hint">"Latest" follows the pipeline: output of the last enabled step is narrated.</span>
                </div>

                <!-- Single Voice -->
                <div class="config-section">
                  <label class="field-label">Voice ({{ getLanguageName(monoTtsLanguage()) }})</label>
                  <select
                    class="select-input"
                    [value]="monoTtsVoice()"
                    (change)="monoTtsVoice.set($any($event.target).value)"
                  >
                    @for (voice of getVoicesForEngine(); track voice.value) {
                      <option [value]="voice.value">{{ voice.label }}</option>
                    }
                  </select>
                </div>

                <!-- Speed -->
                <div class="config-section">
                  <label class="field-label">Speed: {{ monoTtsSpeed() }}x</label>
                  <input
                    type="range"
                    class="full-width-slider"
                    min="0.5"
                    max="2"
                    step="0.05"
                    [value]="monoTtsSpeed()"
                    (input)="monoTtsSpeed.set(+$any($event.target).value)"
                  />
                </div>

                <!-- Advanced (XTTS sampling) -->
                <div class="accordion" [class.open]="advancedTtsOpen()">
                  <button class="accordion-header" (click)="advancedTtsOpen.set(!advancedTtsOpen())">
                    <span class="accordion-title">Advanced</span>
                    <span class="accordion-icon">{{ advancedTtsOpen() ? '▼' : '▶' }}</span>
                  </button>
                  @if (advancedTtsOpen()) {
                    <div class="accordion-content">
                      <div class="config-section">
                        <label class="field-label">Temperature: {{ ttsTemperature() }}</label>
                        <input type="range" class="full-width-slider" min="0.1" max="1.0" step="0.05"
                          [value]="ttsTemperature()" (input)="ttsTemperature.set(+$any($event.target).value)" />
                      </div>
                      <div class="config-section">
                        <label class="field-label">Top P: {{ ttsTopP() }}</label>
                        <input type="range" class="full-width-slider" min="0.1" max="1.0" step="0.05"
                          [value]="ttsTopP()" (input)="ttsTopP.set(+$any($event.target).value)" />
                      </div>
                    </div>
                  }
                </div>
              } @else {
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

                      <!-- EPUB automatically resolved at runtime based on language -->
                      <span class="epub-auto">
                        {{ row.language.toUpperCase() }}.epub
                      </span>

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
              }
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 4: Assembly -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('assembly') {
            <div class="step-panel">
              @if (pipelineMode() === 'mono') {
                <h3>Assembly</h3>
                <p class="step-desc">Assemble TTS output into a finished audiobook (M4B with chapters).</p>

                @if (!isStepSkipped('tts')) {
                  <!-- Mode A: TTS is enabled — assembly chains from TTS output -->
                  <div class="review-card">
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Mode:</span>
                        <span class="review-value">Assemble from TTS output</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Status:</span>
                        <span class="review-value">Will run after TTS completes</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Title:</span>
                        <span class="review-value">{{ title() || 'Untitled' }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Author:</span>
                        <span class="review-value">{{ author() || 'Unknown' }}</span>
                      </div>
                    </div>
                  </div>
                } @else if (cachedSession(); as session) {
                  <!-- Mode B: TTS skipped, cached session exists — standalone reassembly -->
                  <div class="review-card">
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Mode:</span>
                        <span class="review-value">Reassemble from cached session</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Progress:</span>
                        <span class="review-value">{{ session.completedSentences }}/{{ session.totalSentences }} sentences</span>
                      </div>
                      @if (session.chapters?.length) {
                        <div class="review-row">
                          <span class="review-label">Chapters:</span>
                          <span class="review-value">{{ session.chapters.length }}</span>
                        </div>
                      }
                    </div>
                  </div>
                } @else {
                  <div class="warning-banner">
                    No cached TTS session found for this book. Enable TTS to chain assembly, or skip this step.
                  </div>
                }
              } @else {
              <h3>Bilingual Assembly</h3>
              <p class="step-desc">Interleave source and target sentences into a bilingual audiobook.</p>

              <!-- Available Sessions -->
              <div class="config-section">
                <label class="field-label">Source Sentences</label>
                <select
                  class="select-input"
                  [value]="assemblySourceLang()"
                  (change)="setAssemblySourceLang($any($event.target).value)"
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
                  (change)="setAssemblyTargetLang($any($event.target).value)"
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
              }

              <!-- Output Format (shared by both pipelines) -->
              @if (pipelineMode() === 'bilingual' || !isStepSkipped('tts') || cachedSession()) {
              <div class="config-section">
                <label class="field-label">Output Format</label>
                <div class="provider-buttons">
                  <button class="provider-btn selected" disabled>
                    <span class="provider-name">Audio</span>
                    <span class="provider-status">M4B + VTT (always)</span>
                  </button>
                  <button class="provider-btn"
                    [class.selected]="generateVideo()"
                    (click)="generateVideo.set(!generateVideo())">
                    <span class="provider-name">Video</span>
                    <span class="provider-status">MP4 with subtitles</span>
                  </button>
                </div>
              </div>
              }

              @if (generateVideo()) {
                <div class="config-section">
                  <label class="field-label">Video Resolution</label>
                  <div class="provider-buttons">
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '480p'"
                      (click)="videoResolution.set('480p')">
                      <span class="provider-name">480p</span>
                      <span class="provider-status">854 x 480</span>
                    </button>
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '720p'"
                      (click)="videoResolution.set('720p')">
                      <span class="provider-name">720p</span>
                      <span class="provider-status">1280 x 720</span>
                    </button>
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '1080p'"
                      (click)="videoResolution.set('1080p')">
                      <span class="provider-name">1080p</span>
                      <span class="provider-status">1920 x 1080</span>
                    </button>
                  </div>
                </div>
              }

              @if (pipelineMode() === 'bilingual' && (!assemblySourceLang() || !assemblyTargetLang())) {
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
                          {{ enableAiCleanup() && simplifyForLearning() ? 'AI Cleanup + Simplify' : enableAiCleanup() ? 'AI Cleanup' : simplifyForLearning() ? 'Simplify for Learning' : 'None' }}
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
                @if (!isStepSkipped('translate') && (translateMode() === 'sentence' ? targetLangs().size > 0 : monoTranslationActive())) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🌐</span>
                      <span class="review-card-title">Translation</span>
                      @if (translateMode() === 'sentence') {
                        <span class="job-count">{{ targetLangs().size }} job{{ targetLangs().size > 1 ? 's' : '' }}</span>
                      }
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">{{ translateSourceEpub() === 'latest' ? 'Latest' : getFilenameFromPath(translateSourceEpub()) }}</span>
                      </div>
                      @if (translateMode() === 'sentence') {
                        <div class="review-row">
                          <span class="review-label">Languages:</span>
                          <span class="review-value">{{ Array.from(targetLangs()).map(getLanguageName.bind(this)).join(', ') }}</span>
                        </div>
                      } @else {
                        <div class="review-row">
                          <span class="review-label">Whole book:</span>
                          <span class="review-value">{{ getLanguageName(detectedSourceLang()) }} → {{ getLanguageName(monoTargetLang()) }}</span>
                        </div>
                      }
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
                @if (!isStepSkipped('tts') && (pipelineMode() === 'mono' || ttsLanguageRows().length > 0)) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔊</span>
                      <span class="review-card-title">TTS</span>
                      @if (pipelineMode() === 'bilingual') {
                        <span class="job-count">{{ ttsLanguageRows().length }} job{{ ttsLanguageRows().length > 1 ? 's' : '' }}</span>
                      }
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Engine:</span>
                        <span class="review-value">{{ ttsEngine().toUpperCase() }} / {{ ttsDevice().toUpperCase() }}</span>
                      </div>
                      @if (pipelineMode() === 'mono') {
                        <div class="review-row">
                          <span class="review-label">{{ monoTtsLanguage().toUpperCase() }}:</span>
                          <span class="review-value">{{ monoTtsVoice() }} @ {{ monoTtsSpeed() }}x</span>
                        </div>
                      } @else {
                        @for (row of ttsLanguageRows(); track row.id) {
                          <div class="review-row">
                            <span class="review-label">{{ row.language.toUpperCase() }}:</span>
                            <span class="review-value">{{ row.voice }} @ {{ row.speed }}x</span>
                          </div>
                        }
                      }
                      @if (pipelineMode() === 'bilingual' && ttsTestMode()) {
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
                @if (!isStepSkipped('assembly') && (pipelineMode() === 'mono' ? (!isStepSkipped('tts') || cachedSession()) : (assemblySourceLang() && assemblyTargetLang()))) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🎵</span>
                      <span class="review-card-title">Assembly</span>
                    </div>
                    <div class="review-card-content">
                      @if (pipelineMode() === 'mono') {
                        <div class="review-row">
                          <span class="review-label">Output:</span>
                          <span class="review-value">M4B + VTT{{ generateVideo() ? ' + Video (' + videoResolution() + ')' : '' }}</span>
                        </div>
                        <div class="review-row">
                          <span class="review-label">Mode:</span>
                          <span class="review-value">{{ !isStepSkipped('tts') ? 'Chained after TTS' : 'From cached session' }}</span>
                        </div>
                      } @else {
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
                      }
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
            @if (voiceDownloadMsg(); as msg) {
              <span class="voice-download-msg">{{ msg }}</span>
            }
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

      &.has-data:not(.active):not(.completed) {
        opacity: 0.85;
        border-color: rgba(34, 197, 94, 0.4);
      }
    }

    .data-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
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
      position: relative;

      &.scrollable {
        max-height: 100%;
        overflow-y: auto;
      }

    .ai-layover {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
      backdrop-filter: blur(2px);
    }

    .ai-layover-card {
      max-width: 420px;
      text-align: center;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 10px;
      padding: 28px 32px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .ai-layover-icon { font-size: 2.5rem; margin-bottom: 8px; }
    .ai-layover-card h4 { margin: 0 0 8px; font-size: 1.1rem; color: var(--text-primary); }
    .ai-layover-card p { margin: 0 0 18px; font-size: 0.875rem; color: var(--text-secondary); line-height: 1.5; }
    .ai-layover-btn {
      padding: 9px 20px;
      border: none;
      border-radius: 6px;
      background: var(--accent-primary);
      color: #fff;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .ai-layover-btn:hover { opacity: 0.9; }

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

    .configure-ai-btn {
      margin-top: 10px;
      padding: 7px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
    }
    .configure-ai-btn:hover { border-color: var(--accent-primary); }

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

    .existing-cleanup-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--info, var(--accent)) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--info, var(--accent)) 40%, transparent);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);

      .start-over-btn {
        flex-shrink: 0;
        padding: 4px 12px;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        background: transparent;
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;

        &:hover {
          background: color-mix(in srgb, var(--text-primary) 8%, transparent);
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

    .accordion {
      margin-top: 16px;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }

    .accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .accordion-content {
      padding: 12px;
      border-top: 1px solid var(--border-subtle);
    }

    .prompt-textarea {
      width: 100%;
      min-height: 220px;
      padding: 10px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: monospace;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
      box-sizing: border-box;
    }

    .prompt-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }

    .btn-save-prompt {
      padding: 6px 14px;
      background: var(--accent-primary);
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 12px;
      cursor: pointer;

      &:disabled {
        opacity: 0.6;
        cursor: default;
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

    .existing-translations {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .existing-translation-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      font-size: 13px;
    }

    .existing-translation-label {
      color: var(--text-secondary);
    }

    .existing-translation-delete {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #ef4444;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: rgba(239, 68, 68, 0.15);
        border-color: #ef4444;
      }
    }

    .existing-translation-clear-all {
      align-self: flex-end;
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: rgba(239, 68, 68, 0.7);
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 4px;
      transition: all 0.15s;

      &:hover {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
        border-color: #ef4444;
      }
    }

    .hint {
      display: block;
      margin-top: 8px;
      font-size: 11px;
      color: var(--text-tertiary);
    }

    .custom-instructions {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
      min-height: 60px;

      &:focus {
        outline: none;
        border-color: var(--accent-primary);
      }

      &::placeholder {
        color: var(--text-muted);
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

    /* Source Stage Buttons */
    .source-stages {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .stage-btn {
      padding: 6px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 4px;

      .stage-check {
        color: #22c55e;
        font-size: 11px;
      }

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;
        color: #06b6d4;

        .stage-check {
          color: #06b6d4;
        }
      }

      &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
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

      .epub-auto {
        width: 140px;
        padding: 6px 8px;
        background: var(--bg-subtle);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-secondary);
        display: inline-block;
        text-align: center;
        font-style: italic;
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

    .voice-download-msg {
      margin-left: 12px;
      font-size: 13px;
      color: var(--text-secondary);
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
  private readonly epubResolver = inject(EpubResolverService);
  // Public for the template: gates optional TTS engines (e.g. Orpheus) on availability.
  protected readonly componentService = inject(ComponentService);
  // Gates the AI Cleanup step behind a "set up an AI" layover when none configured.
  protected readonly ai = inject(AiService);

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
  readonly year = input<string>('');
  readonly itemType = input<'book' | 'article'>('book');
  readonly bfpPath = input<string>('');
  readonly projectId = input<string>('');
  readonly projectDir = input<string>('');
  readonly audiobookFolder = input<string>('');
  readonly coverPath = input<string>('');  // Absolute path to cover image

  // Language Learning specific inputs
  readonly projectTitle = input<string>('');
  readonly initialSourceLang = input<string>('en');
  readonly refreshTrigger = input<number>(0);  // bump to re-scan stages after a delete/reset

  // Mono-pipeline inputs (whole-book mode)
  readonly contributors = input<Array<{ first: string; last: string }> | undefined>(undefined);
  readonly cachedSession = input<any>(null);       // Cached TTS session for standalone reassembly
  readonly outputFilename = input<string>('');     // Saved manifest filename — respected over derived name

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
  readonly customInstructions = signal('');
  readonly cleanupParallelWorkers = signal(4);  // Parallel workers for Claude/OpenAI (mono ocr-cleanup)

  // AI prompt editor (edits the global cleanup prompt file)
  readonly promptAccordionOpen = signal(false);
  readonly loadingPrompt = signal(false);
  readonly savingPrompt = signal(false);
  readonly promptText = signal('');
  readonly originalPromptText = signal('');
  readonly promptModified = computed(() => this.promptText() !== this.originalPromptText());

  readonly hasExistingCleanup = computed(() => {
    return this.availableEpubs().some(e => e.filename === 'cleaned.epub' || e.filename === 'simplified.epub');
  });

  /** Stages relevant for cleanup source: Original, Exported, AI Cleaned, AI Simplified */
  readonly cleanupSourceStages = computed<SourceStage[]>(() => {
    const epubs = this.availableEpubs();
    const find = (name: string) => epubs.find(e => e.filename === name);
    return [
      { id: 'original', label: 'Original', completed: !!find('original.epub'), path: find('original.epub')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported.epub'), path: find('exported.epub')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned.epub'), path: find('cleaned.epub')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified.epub'), path: find('simplified.epub')?.path ?? '' },
    ];
  });

  /** Stages relevant for translate source: Original, Exported, AI Cleaned, AI Simplified */
  readonly translateSourceStages = computed<SourceStage[]>(() => {
    const epubs = this.availableEpubs();
    const find = (name: string) => epubs.find(e => e.filename === name);
    return [
      { id: 'original', label: 'Original', completed: !!find('original.epub'), path: find('original.epub')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported.epub'), path: find('exported.epub')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned.epub'), path: find('cleaned.epub')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified.epub'), path: find('simplified.epub')?.path ?? '' },
    ];
  });

  /** Stages relevant for mono TTS source: everything incl. whole-book translation output */
  readonly ttsSourceStages = computed<SourceStage[]>(() => {
    const epubs = this.availableEpubs();
    const find = (name: string) => epubs.find(e => e.filename === name);
    return [
      { id: 'original', label: 'Original', completed: !!find('original.epub'), path: find('original.epub')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported.epub'), path: find('exported.epub')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned.epub'), path: find('cleaned.epub')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified.epub'), path: find('simplified.epub')?.path ?? '' },
      { id: 'translated', label: 'Translated', completed: !!find('translated.epub'), path: find('translated.epub')?.path ?? '' },
    ];
  });

  /** Stage order tiebreak for mtime-based resolution (higher = preferred when mtimes are equal) */
  private static readonly STAGE_ORDER: Record<string, number> = {
    'original.epub': 0,
    'exported.epub': 1,
    'cleaned.epub': 2,
    'simplified.epub': 3,
    'translated.epub': 4,
  };

  /**
   * Pick the most recently modified EPUB from candidates.
   * Tiebreak by stage order (later stage wins).
   */
  private getMostRecentEpub(candidates: AvailableEpub[], exclude?: Set<string>): AvailableEpub | null {
    const filtered = candidates.filter(e => e.mtimeMs != null && (!exclude || !exclude.has(e.filename)));
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => {
      const diff = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
      if (diff !== 0) return diff;
      return (LLWizardComponent.STAGE_ORDER[b.filename] ?? 0) - (LLWizardComponent.STAGE_ORDER[a.filename] ?? 0);
    });
    return filtered[0];
  }

  /** What the cleanup step will produce, if it's active in this pipeline run */
  private cleanupWillProduce(): 'cleaned.epub' | 'simplified.epub' | null {
    if (this._skippedSteps.has('cleanup')) return null;
    if (this.simplifyForLearning()) return 'simplified.epub';
    if (this.enableAiCleanup()) return 'cleaned.epub';
    return null;
  }

  /** Resolve which stage ID "latest" maps to for a given pipeline step */
  private resolveLatestStageId(step: 'cleanup' | 'translate' | 'tts'): string {
    const epubs = this.availableEpubs();
    const has = (name: string) => epubs.some(e => e.filename === name);
    if (step === 'tts') {
      // Mono TTS input: pipeline intent first (earlier steps will produce files), then on-disk latest
      if (this.monoTranslationActive()) return 'translated';
      const willProduce = this.cleanupWillProduce();
      if (willProduce) return willProduce.replace('.epub', '');
      const exclude = new Set<string>();
      for (const e of epubs) { if (e.isTranslated) exclude.add(e.filename); } // per-language EPUBs are bilingual outputs
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.filename.replace('.epub', '');
      for (const name of ['translated', 'simplified', 'cleaned', 'exported', 'original']) {
        if (has(`${name}.epub`)) return name;
      }
      return '';
    }
    if (step === 'cleanup') {
      // Cleanup input: most recently modified source file (not cleaned/simplified — we produce those)
      const sourceOnly = new Set(['cleaned.epub', 'simplified.epub', 'translated.epub']);
      const best = this.getMostRecentEpub(epubs, sourceOnly);
      if (best) return best.filename.replace('.epub', '');
      if (has('exported.epub')) return 'exported';
      if (has('original.epub')) return 'original';
    } else {
      // Translate input: most recently modified wins (exclude translated — we produce that)
      // Also exclude per-language EPUBs (xx.epub) since those are translation outputs
      const exclude = new Set<string>();
      for (const e of epubs) {
        if (e.isTranslated || e.filename === 'translated.epub') exclude.add(e.filename);
      }
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.filename.replace('.epub', '');
      if (has('simplified.epub')) return 'simplified';
      if (has('cleaned.epub')) return 'cleaned';
      if (has('exported.epub')) return 'exported';
      if (has('original.epub')) return 'original';
    }
    return '';
  }

  private sourceSignalFor(step: 'cleanup' | 'translate' | 'tts') {
    if (step === 'cleanup') return this.cleanupSourceEpub;
    if (step === 'translate') return this.translateSourceEpub;
    return this.ttsSourceEpub;
  }

  /** Check if a stage button should be highlighted as selected */
  isStageSelected(step: 'cleanup' | 'translate' | 'tts', stage: SourceStage): boolean {
    const source = this.sourceSignalFor(step)();
    if (source === 'latest') {
      return stage.id === this.resolveLatestStageId(step);
    }
    return source === stage.path;
  }

  /** Handle stage button click — clicking the auto-selected stage returns to 'latest' */
  selectStage(step: 'cleanup' | 'translate' | 'tts', stage: SourceStage): void {
    const signal = this.sourceSignalFor(step);
    const current = signal();

    // If clicking the currently selected stage, toggle back to 'latest'
    if (current === stage.path || (current === 'latest' && stage.id === this.resolveLatestStageId(step))) {
      signal.set('latest');
    } else {
      signal.set(stage.path);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Translation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Translation mode — selecting one IS the opt-in to translation; null means
   * "don't translate" (hit Next without picking). It also drives the pipeline shape:
   * - 'whole-book': mono pipeline (full-book translation, single TTS voice,
   *   M4B reassembly) — what the old process-wizard did.
   * - 'sentence': bilingual / language-learning pipeline (sentence-aligned
   *   per-language translation, per-language TTS rows, interleaved assembly).
   */
  readonly translateMode = signal<'whole-book' | 'sentence' | null>(null);
  readonly pipelineMode = computed<'mono' | 'bilingual'>(() =>
    this.translateMode() === 'sentence' ? 'bilingual' : 'mono');

  // Whole-book translation (mono pipeline)
  readonly monoTargetLang = signal<string>('en');
  readonly monoTranslationActive = computed(() =>
    this.translateMode() === 'whole-book' && !!this.monoTargetLang());

  readonly translateSourceEpub = signal<string>('latest');
  readonly targetLangs = signal<Set<string>>(new Set());
  readonly translateProvider = signal<AIProvider>('ollama');
  readonly translateModel = signal<string>('');
  readonly detectedSourceLang = signal<string>('en');
  readonly translateTestMode = signal(false);
  readonly translateTestChunks = signal(5);
  readonly translateCustomInstructions = signal('');

  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  /** Translation EPUBs that already exist in the project (e.g., en.epub, de.epub) */
  readonly existingTranslationEpubs = computed(() => {
    return this.availableEpubs().filter(e => e.isTranslated);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: TTS
  // ─────────────────────────────────────────────────────────────────────────

  readonly ttsEngine = signal<'xtts' | 'orpheus'>('xtts');
  readonly ttsDevice = signal<'cpu' | 'mps' | 'gpu'>('cpu');
  readonly ttsWorkers = signal(2);
  readonly ttsTestMode = signal(false);
  readonly ttsTestSentences = signal(10);
  readonly ttsLanguageRows = signal<TtsLanguageRow[]>([]);
  readonly continueTts = signal(false);

  // Mono pipeline: single-voice TTS settings
  readonly ttsSourceEpub = signal<string>('latest');
  readonly monoTtsVoice = signal('ScarlettJohansson');
  readonly monoTtsSpeed = signal(1.0);

  // Pre-flight voice download status (shown near the Add to Queue button).
  readonly voiceDownloadMsg = signal<string | null>(null);
  readonly ttsTemperature = signal(0.7);
  readonly ttsTopP = signal(0.9);
  readonly advancedTtsOpen = signal(false);
  /** Audio language follows the pipeline: translated target if translating, else the book's language */
  readonly monoTtsLanguage = computed(() =>
    this.monoTranslationActive() ? this.monoTargetLang() : this.detectedSourceLang());
  readonly partialTtsSessions = signal<{ language: string; completedSentences: number; totalSentences: number; sessionDir: string; sentencesDir: string }[]>([]);

  // Voice options
  readonly xttsVoices = [
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
    { value: 'DavidAttenborough', label: 'David Attenborough' },
    { value: 'BobRoss', label: 'Bob Ross' },
    { value: 'MorganFreeman', label: 'Morgan Freeman' },
    { value: 'internal', label: 'Default XTTS' },
  ];

  // User-added custom XTTS voices (own fine-tuned checkpoints). Their `value` is
  // the voice id; the TTS bridge detects it and routes through --custom_model.
  readonly customXttsVoices = signal<{ value: string; label: string }[]>([]);

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
  readonly generateVideo = signal(false);
  readonly videoResolution = signal<'480p' | '720p' | '1080p'>('720p');
  readonly availableSessions = signal<SessionCache[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // EPUBs State
  // ─────────────────────────────────────────────────────────────────────────

  readonly scanningEpubs = signal(false);
  readonly availableEpubs = signal<AvailableEpub[]>([]);
  readonly stagesWithData = signal<Set<string>>(new Set());

  // ─────────────────────────────────────────────────────────────────────────
  // Connection/Model State
  // ─────────────────────────────────────────────────────────────────────────

  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly loadingModels = signal(false);
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);
  // Bundled llama.cpp models that are downloaded (value = catalog model id).
  readonly localModels = signal<{ value: string; label: string; active: boolean }[]>([]);

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

  /**
   * Unified AI source list for the cleanup/translate dropdowns. Only sources the
   * user has actually configured appear; each is its own optgroup. Option values
   * are encoded `${provider}::${model}` so one <select> drives provider + model.
   */
  readonly aiSourceGroups = computed<{ provider: AIProvider; label: string; models: { value: string; label: string; active?: boolean }[] }[]>(() => {
    const cfg = this.settingsService.getAIConfig();
    const groups: { provider: AIProvider; label: string; models: { value: string; label: string; active?: boolean }[] }[] = [];

    const local = this.localModels();
    if (local.length > 0) {
      groups.push({ provider: 'local', label: 'Bundled · offline', models: local });
    }
    if (this.ollamaConnected() && this.ollamaModels().length > 0) {
      groups.push({ provider: 'ollama', label: 'Ollama', models: this.ollamaModels() });
    }
    if (this.hasClaudeKey()) {
      const m = this.claudeModels();
      groups.push({ provider: 'claude', label: 'Claude', models: m.length ? m : [{ value: cfg.claude.model || 'claude-sonnet-4-6', label: cfg.claude.model || 'Claude' }] });
    }
    if (this.hasOpenAIKey()) {
      const m = this.openaiModels();
      groups.push({ provider: 'openai', label: 'OpenAI', models: m.length ? m : [{ value: cfg.openai.model || 'gpt-4o', label: cfg.openai.model || 'OpenAI' }] });
    }
    return groups;
  });

  /** Current dropdown value for each step: `${provider}::${model}`. */
  readonly cleanupSelection = computed(() => `${this.cleanupProvider()}::${this.cleanupModel()}`);
  readonly translateSelection = computed(() => `${this.translateProvider()}::${this.translateModel()}`);

  /** Everything the user could set up is set up → hide the "Configure AI" button. */
  readonly allAiConfigured = computed(() =>
    this.hasClaudeKey()
    && this.hasOpenAIKey()
    && (this.localModels().length > 0 || (this.ollamaConnected() && this.ollamaModels().length > 0))
  );

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
      const normalized = this.epubPath().replace(/\\/g, '/');
      const parts = normalized.split('/');
      parts.pop(); // Remove filename
      return parts.join('/');
    }
    // Derive from bfpPath (project directory)
    if (this.bfpPath()) {
      return this.bfpPath().replace(/\\/g, '/');
    }
    return '';
  });

  /**
   * Available languages for TTS - based on existing language EPUBs.
   * Detects which language EPUBs exist (en.epub, de.epub, etc.) and makes those available.
   */
  readonly availableTtsLanguages = computed(() => {
    const sourceLang = this.detectedSourceLang();
    const epubs = this.availableEpubs();
    const languageMap = new Map<string, string>();

    // Always include source language
    languageMap.set(sourceLang, this.getLanguageName(sourceLang));

    // Add any language EPUBs that exist (en.epub, de.epub, es.epub, etc.)
    for (const epub of epubs) {
      if (epub.isTranslated && epub.lang) {
        languageMap.set(epub.lang, this.getLanguageName(epub.lang));
      }
    }

    // Also add target languages from translation step if selected
    const targets = this.targetLangs();
    for (const code of targets) {
      if (!languageMap.has(code)) {
        languageMap.set(code, this.getLanguageName(code));
      }
    }

    // Convert to array format expected by template
    const languages: { code: string; name: string }[] = [];
    for (const [code, name] of languageMap) {
      languages.push({ code, name });
    }

    console.log('[LL-WIZARD] Available TTS languages:', languages);
    return languages;
  });

  /**
   * Filtered EPUBs for TTS step - only show language-specific EPUBs (en.epub, de.epub, etc.)
   */
  readonly ttsAvailableEpubs = computed(() => {
    const allEpubs = this.availableEpubs();
    // Only show translated EPUBs (language files like en.epub, de.epub) and cleaned/simplified EPUBs
    return allEpubs.filter(epub =>
      epub.isTranslated ||
      epub.filename === 'cleaned.epub' ||
      epub.filename === 'simplified.epub'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  private isInitializing = true;

  constructor() {
    // Re-scan project EPUBs whenever project dir changes (e.g. after exporting from PDF viewer)
    effect(() => {
      const dir = this.effectiveProjectDir();
      this.refreshTrigger();  // re-scan stages when the host bumps this (after delete/reset)
      if (dir) this.scanProjectEpubs();
    });

    // Sync TTS language rows when target languages change (bilingual pipeline only)
    effect(() => {
      // Skip during initialization to avoid conflicts
      if (this.isInitializing) return;
      if (this.pipelineMode() !== 'bilingual') return;

      const targets = this.targetLangs();
      const sourceLang = this.detectedSourceLang();
      this.syncTtsRowsWithTargets(sourceLang, targets);
    });
  }

  async ngOnInit(): Promise<void> {
    console.log('[LL-WIZARD] Component initializing with:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());

    this.detectedSourceLang.set(this.initialSourceLang());
    this.initializeFromSettings();
    // Optional engines: if a saved/default engine isn't installed, fall back to XTTS.
    await this.componentService.ensureLoaded();
    if (this.ttsEngine() === 'orpheus' && !this.componentService.isInstalled('orpheus')) {
      this.selectTtsEngine('xtts');
    }
    await this.ai.refresh();
    await this.checkOllamaConnection();
    await this.loadLocalModels();
    this.normalizeAiSelections();
    await this.loadCustomVoices();
    // EPUBs are scanned by the bfpPath effect — await a tick for it to complete
    await this.scanProjectEpubs();
    this.scanAvailableSessions();
    this.initializeDefaultTtsRows();

    console.log('[LL-WIZARD] After initialization:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());

    // Allow effects to run now that initialization is complete
    this.isInitializing = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();

    // Default to Ollama
    this.cleanupProvider.set('ollama');
    this.cleanupModel.set(config.ollama.model || 'cogito:14b');
    this.translateProvider.set('ollama');
    this.translateModel.set(config.ollama.model || 'cogito:14b');

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
    const rows: TtsLanguageRow[] = [];
    const timestamp = Date.now();

    // First row: Source language (e.g., English)
    rows.push({
      id: `tts-${timestamp}-${sourceLang}`,
      language: sourceLang,
      voice: defaultVoice,
      speed: 1.0
    });

    // Second row: First target language (if available from translation config)
    // This will be populated based on selected target languages
    // We don't need to check for EPUBs here - that happens at runtime

    console.log('[LL-WIZARD] Initialized TTS rows:', rows);
    this.ttsLanguageRows.set(rows);

    // If we have TTS rows configured, remove from skipped steps
    if (rows.length > 0) {
      this._skippedSteps.delete('tts');
    }
  }

  private syncTtsRowsWithTargets(sourceLang: string, targets: Set<string>): void {
    // Skip if we haven't initialized yet
    if (this.availableEpubs().length === 0) {
      return;
    }

    const currentRows = this.ttsLanguageRows();
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    const epubs = this.availableEpubs();

    // Ensure source language row exists
    const hasSource = currentRows.some(r => r.language === sourceLang);
    if (!hasSource && currentRows.length === 0) {
      const sourceEpub = epubs.find(e => e.isTranslated && e.lang === sourceLang);
      const sourceEpubPath = sourceEpub ? sourceEpub.path : 'latest';

      this.ttsLanguageRows.update(rows => [...rows, {
        id: `tts-${Date.now()}`,
        language: sourceLang,
        sourceEpub: sourceEpubPath,
        voice: defaultVoice,
        speed: 1.0
      }]);
    }

    // Add rows for new target languages
    for (const lang of targets) {
      const hasLang = currentRows.some(r => r.language === lang);
      if (!hasLang) {
        const targetEpub = epubs.find(e => e.isTranslated && e.lang === lang);
        const targetEpubPath = targetEpub ? targetEpub.path : 'latest';

        this.ttsLanguageRows.update(rows => [...rows, {
          id: `tts-${Date.now()}-${lang}`,
          language: lang,
          sourceEpub: targetEpubPath,
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
        const models: { value: string; label: string }[] = (data.models || []).map((m: { name: string }) => ({
          value: m.name,
          label: m.name
        }));
        this.ollamaModels.set(models);

        // If the current model isn't in the fetched list, reset to preferred default
        if (models.length > 0) {
          const preferred = models.find(m => m.value === 'cogito:14b')?.value ?? models[0].value;
          if (!this.cleanupModel() || !models.some(m => m.value === this.cleanupModel())) {
            this.cleanupModel.set(preferred);
          }
          if (!this.translateModel() || !models.some(m => m.value === this.translateModel())) {
            this.translateModel.set(preferred);
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
    const projectDir = this.effectiveProjectDir();

    if (!projectDir) {
      this.availableEpubs.set([]);
      return;
    }

    console.log('[LL-WIZARD] Scanning for EPUBs in unified structure:', projectDir);
    this.scanningEpubs.set(true);
    try {
      const epubs: AvailableEpub[] = [];

      // Scan translation stage for language EPUBs
      try {
        const translationDir = `${projectDir}/stages/02-translate`;
        const translationFiles = await this.electronService.listDirectory(translationDir);
        for (const file of translationFiles) {
          if (file.endsWith('.epub') && !file.startsWith('._') && !file.startsWith('.')) {
            const filePath = `${translationDir}/${file}`;
            const lang = this.detectLanguageFromFilename(file);
            const isLangEpub = /^[a-z]{2}\.epub$/i.test(file);

            epubs.push({
              path: filePath,
              filename: file,
              lang: lang,
              isSource: false,
              isTranslated: isLangEpub,
              isCleaned: false
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No translation stage found');
      }

      // Scan cleanup stage
      try {
        const cleanupDir = `${projectDir}/stages/01-cleanup`;
        const cleanupFiles = await this.electronService.listDirectory(cleanupDir);
        for (const file of cleanupFiles) {
          if (file === 'cleaned.epub' || file === 'simplified.epub') {
            const filePath = `${cleanupDir}/${file}`;
            epubs.push({
              path: filePath,
              filename: file,
              lang: 'en',
              isSource: false,
              isTranslated: false,
              isCleaned: true
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No cleanup stage found');
      }

      // Scan source folder
      try {
        const sourceDir = `${projectDir}/source`;
        const sourceFiles = await this.electronService.listDirectory(sourceDir);
        for (const file of sourceFiles) {
          if ((file === 'original.epub' || file === 'exported.epub') && !file.startsWith('._')) {
            const filePath = `${sourceDir}/${file}`;
            epubs.push({
              path: filePath,
              filename: file,
              lang: 'en',
              isSource: true,
              isTranslated: false,
              isCleaned: false
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No source folder found');
      }

      // Enrich with mtime for "Latest" resolution
      if (epubs.length > 0) {
        const statResults = await this.electronService.fsBatchStat(epubs.map(e => e.path));
        for (const epub of epubs) {
          const stat = statResults[epub.path];
          if (stat) {
            epub.mtimeMs = stat.mtimeMs;
            epub.modifiedAt = new Date(stat.mtimeMs).toISOString();
          }
        }
      }

      console.log('[LL-WIZARD] Scanned EPUBs:', epubs.map(e => ({
        filename: e.filename,
        lang: e.lang,
        isTranslated: e.isTranslated,
        isSource: e.isSource,
        mtimeMs: e.mtimeMs
      })));
      this.availableEpubs.set(epubs);

      // Detect which stages have existing data
      const dataSet = new Set<string>();
      if (epubs.some(e => e.isCleaned)) {
        dataSet.add('cleanup');
      }
      if (epubs.some(e => e.isTranslated)) {
        dataSet.add('translate');
      }

      // Check TTS cache and output via batch exists
      const ttsDir = `${projectDir}/stages/03-tts/sessions`;
      const outputDir = `${projectDir}/output`;
      const existsMap = await this.electronService.fsBatchExists([ttsDir, outputDir]);
      if (existsMap[ttsDir]) dataSet.add('tts');
      if (existsMap[outputDir]) dataSet.add('assembly');

      this.stagesWithData.set(dataSet);
    } catch (err) {
      console.error('Failed to scan project EPUBs:', err);
      this.availableEpubs.set([]);
    } finally {
      this.scanningEpubs.set(false);
    }
  }

  /** Delete existing cleanup output so the next run starts fresh */
  /** Open the AI Setup wizard from the cleanup-step layover. */
  openAiSetup(): void {
    void this.router.navigate(['/ai-setup']);
  }

  async clearCleanupStage(): Promise<void> {
    const projectDir = this.effectiveProjectDir();
    if (!projectDir) return;

    const electron = (window as any).electron;
    if (!electron?.pipeline?.deleteCleanup) return;

    const result = await electron.pipeline.deleteCleanup(projectDir);
    if (result.success) {
      console.log('[LLWizard] Cleanup stage cleared:', result.message);
      await this.scanProjectEpubs();
    } else {
      console.error('[LLWizard] Failed to clear cleanup stage:', result.error);
    }
  }

  private detectLanguageFromFilename(filename: string): string {
    const match = filename.match(/^([a-z]{2})\.epub$/i);
    if (match) {
      return match[1].toLowerCase();
    }
    return this.initialSourceLang();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Scanning (for Assembly)
  // ─────────────────────────────────────────────────────────────────────────

  async scanAvailableSessions(): Promise<void> {
    this.availableSessions.set([]);

    // Scan project directory for cached TTS sessions
    const projectDir = this.effectiveProjectDir();
    if (projectDir) {
      try {
        const electron = (window as any).electron;
        if (electron?.sessionCache?.scanProject) {
          const result = await electron.sessionCache.scanProject(projectDir);
          if (result.success && result.sessions.length > 0) {
            const sessions: SessionCache[] = result.sessions.map((s: any) => ({
              language: s.language,
              sessionDir: s.sentencesDir, // Use sentences dir as the session path for assembly
              sentenceCount: s.sentenceCount,
              createdAt: s.createdAt,
            }));
            this.availableSessions.set(sessions);
            console.log('[LL-WIZARD] Found cached sessions:', sessions.map(s => `${s.language} (${s.sentenceCount} sentences)`));
          }
        }
      } catch (err) {
        console.error('[LL-WIZARD] Error scanning sessions:', err);
      }
    }

    // Auto-populate assembly source/target from available sessions or TTS rows
    const sourceLang = this.detectedSourceLang();

    if (!this.assemblySourceLang()) {
      const sourceSession = this.availableSessions().find(s => s.language === sourceLang);
      const sourceRow = this.ttsLanguageRows().find(r => r.language === sourceLang);
      if (sourceSession || sourceRow) {
        this.assemblySourceLang.set(sourceLang);
      }
    }

    if (!this.assemblyTargetLang()) {
      const targetSession = this.availableSessions().find(s => s.language !== sourceLang);
      const targetRow = this.ttsLanguageRows().find(r => r.language !== sourceLang);
      if (targetSession) {
        this.assemblyTargetLang.set(targetSession.language);
      } else if (targetRow) {
        this.assemblyTargetLang.set(targetRow.language);
      }
    }

    // If both are now set, remove from skipped steps
    if (this.assemblySourceLang() && this.assemblyTargetLang()) {
      this._skippedSteps.delete('assembly');
    }
  }

  hasSessionForLang(lang: string): boolean {
    return this.availableSessions().some(s => s.language === lang);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Selection
  // ─────────────────────────────────────────────────────────────────────────

  /** Parse a `${provider}::${model}` dropdown value. */
  private parseSelection(value: string): { provider: AIProvider; model: string } {
    const i = value.indexOf('::');
    const provider = (i >= 0 ? value.slice(0, i) : value) as AIProvider;
    const model = i >= 0 ? value.slice(i + 2) : '';
    return { provider, model };
  }

  onCleanupModelChange(value: string): void {
    const { provider, model } = this.parseSelection(value);
    this.cleanupProvider.set(provider);
    this.cleanupModel.set(model);
    // Bundled llama.cpp serves whichever model is "active" — selecting one here
    // promotes it so the cleanup job actually runs against that model.
    if (provider === 'local') void this.ai.setActiveModel(model);
  }

  onTranslateModelChange(value: string): void {
    const { provider, model } = this.parseSelection(value);
    this.translateProvider.set(provider);
    this.translateModel.set(model);
    if (provider === 'local') void this.ai.setActiveModel(model);
  }

  /** Load downloaded bundled (llama.cpp) models into the unified picker. */
  private async loadLocalModels(): Promise<void> {
    const models = await this.ai.listLocalModels();
    this.localModels.set(
      models
        .filter((m) => m.downloaded)
        .map((m) => ({ value: m.id, label: `${m.name} · ${m.sizeGB} GB`, active: m.isActive }))
    );
  }

  /**
   * Ensure each step's saved provider/model still points at an available option;
   * if not, fall back to the active bundled model, else the first available source.
   * (The default from settings may name an unconfigured provider.)
   */
  private normalizeAiSelections(): void {
    const groups = this.aiSourceGroups();
    if (groups.length === 0) return;
    const has = (provider: string, model: string) =>
      groups.some((g) => g.provider === provider && g.models.some((m) => m.value === model));

    const localGroup = groups.find((g) => g.provider === 'local');
    const def = localGroup
      ? { provider: 'local' as AIProvider, model: (localGroup.models.find((m) => m.active) ?? localGroup.models[0]).value }
      : { provider: groups[0].provider, model: groups[0].models[0]?.value ?? '' };

    if (!has(this.cleanupProvider(), this.cleanupModel())) {
      this.cleanupProvider.set(def.provider);
      this.cleanupModel.set(def.model);
    }
    if (!has(this.translateProvider(), this.translateModel())) {
      this.translateProvider.set(def.provider);
      this.translateModel.set(def.model);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation
  // ─────────────────────────────────────────────────────────────────────────

  /** Picking a mode opts into translation; re-clicking it deselects (= no translation) */
  selectTranslateMode(mode: 'whole-book' | 'sentence'): void {
    if (this.translateMode() === mode) {
      this.translateMode.set(null);
    } else {
      this.translateMode.set(mode);
      this._skippedSteps.delete('translate');
    }
  }

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

    // If we have target languages selected, remove 'translate' from skipped steps
    if (current.size > 0) {
      this._skippedSteps.delete('translate');
    }
  }

  async deleteTranslationEpub(epub: AvailableEpub): Promise<void> {
    const projectDir = this.effectiveProjectDir();
    if (!projectDir) return;

    // Delete the EPUB file
    await this.electronService.deleteFile(epub.path);

    // Delete the corresponding sentence cache
    await this.electronService.deleteFile(`${projectDir}/stages/02-translate/sentences/${epub.lang}.json`);

    // Delete the TTS session folder for this language (contains wav/flac audio)
    await this.electronService.deleteDirectory(`${projectDir}/stages/03-tts/sessions/${epub.lang}`);

    // Delete the sentence pairs file (may be stale)
    await this.electronService.deleteFile(`${projectDir}/stages/02-translate/sentence_pairs_${epub.lang}.json`);

    // Re-scan EPUBs and sessions to update all UI
    await this.scanProjectEpubs();
    await this.scanAvailableSessions();
  }

  async deleteAllTranslationEpubs(): Promise<void> {
    const epubs = [...this.existingTranslationEpubs()];
    for (const epub of epubs) {
      await this.deleteTranslationEpub(epub);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TTS
  // ─────────────────────────────────────────────────────────────────────────

  selectTtsEngine(engine: 'xtts' | 'orpheus'): void {
    this.ttsEngine.set(engine);
    if (engine === 'orpheus') {
      this.ttsWorkers.set(1);
    }

    // Update all rows (and the mono voice) to the new engine's default voice
    const defaultVoice = engine === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    this.monoTtsVoice.set(defaultVoice);
    this.ttsLanguageRows.update(rows =>
      rows.map(row => ({ ...row, voice: defaultVoice }))
    );
  }

  /** Load user-added custom XTTS voices into the picker (alongside the catalog). */
  private async loadCustomVoices(): Promise<void> {
    try {
      const api = (window as any).electron?.customVoices;
      if (!api?.list) return;
      const res = await api.list();
      if (res?.success && Array.isArray(res.data)) {
        this.customXttsVoices.set(
          res.data.map((v: { id: string; name: string }) => ({ value: v.id, label: `${v.name} (custom)` }))
        );
      }
    } catch {
      /* no custom voices available */
    }
  }

  getVoicesForEngine(): { value: string; label: string }[] {
    return this.ttsEngine() === 'orpheus'
      ? this.orpheusVoices
      : [...this.xttsVoices, ...this.customXttsVoices()];
  }

  /**
   * Scan for partial TTS sessions in the project's stages/03-tts/sessions/.
   */
  private async scanForPartialTtsSessions(): Promise<void> {
    const electron = window.electron as any;
    this.continueTts.set(false);
    this.partialTtsSessions.set([]);

    if (!electron?.sessionCache?.scanProject) return;
    const projectDir = this.projectDir();
    if (!projectDir) return;

    try {
      const result = await electron.sessionCache.scanProject(projectDir);
      if (result.success && result.sessions?.length) {
        // Filter for partial sessions only (not 100% complete)
        // We need to check each session — scanProject returns sentenceCount (files on disk)
        // but we need totalSentences from session-state.json to know if it's partial
        const partials: { language: string; completedSentences: number; totalSentences: number; sessionDir: string; sentencesDir: string }[] = [];
        for (const session of result.sessions) {
          // Use checkResumeFromDir to get total and completed counts
          if (electron?.parallelTts?.checkResumeFromDir) {
            try {
              // sessionDir from scanProject is the ebook-{uuid} dir — find processDir inside it
              const resumeResult = await electron.parallelTts.checkResumeFromDir(session.sessionDir);
              if (resumeResult.success && resumeResult.data?.success) {
                const data = resumeResult.data;
                if (data.completedSentences > 0 && !data.complete) {
                  partials.push({
                    language: session.language,
                    completedSentences: data.completedSentences,
                    totalSentences: data.totalSentences,
                    sessionDir: session.sessionDir,
                    sentencesDir: session.sentencesDir,
                  });
                }
              }
            } catch (err) {
              console.error(`[LL-WIZARD] Error checking session for ${session.language}:`, err);
            }
          }
        }
        this.partialTtsSessions.set(partials);
      }
    } catch (err) {
      console.error('[LL-WIZARD] Error scanning for partial TTS sessions:', err);
    }
  }

  addTtsRow(): void {
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';
    const existingLangs = new Set(this.ttsLanguageRows().map(r => r.language));
    const availableLangs = this.availableTtsLanguages();

    // Remove TTS from skipped steps since we're configuring it
    this._skippedSteps.delete('tts');

    // Find a language that's not already added from available languages
    let newLang = this.detectedSourceLang();
    for (const lang of availableLangs) {
      if (!existingLangs.has(lang.code)) {
        newLang = lang.code;
        break;
      }
    }

    this.ttsLanguageRows.update(rows => [...rows, {
      id: `tts-${Date.now()}-${newLang}`,
      language: newLang,
      voice: defaultVoice,
      speed: newLang === this.detectedSourceLang() ? 1.0 : 0.85
    }]);
  }

  removeTtsRow(index: number): void {
    this.ttsLanguageRows.update(rows => rows.filter((_, i) => i !== index));
  }

  updateTtsRow(index: number, field: keyof TtsLanguageRow, value: any): void {
    this.ttsLanguageRows.update(rows =>
      rows.map((row, i) => {
        if (i !== index) return row;
        // Simple update - EPUB resolution happens at runtime
        return { ...row, [field]: value };
      })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Assembly
  // ─────────────────────────────────────────────────────────────────────────

  setAssemblySourceLang(lang: string): void {
    this.assemblySourceLang.set(lang);
    // If we have both source and target configured, remove from skipped steps
    if (lang && this.assemblyTargetLang()) {
      this._skippedSteps.delete('assembly');
    }
  }

  setAssemblyTargetLang(lang: string): void {
    this.assemblyTargetLang.set(lang);
    // If we have both source and target configured, remove from skipped steps
    if (lang && this.assemblySourceLang()) {
      this._skippedSteps.delete('assembly');
    }
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

  hasStageData(step: string): boolean {
    return this.stagesWithData().has(step);
  }

  toggleAiCleanup(): void {
    if (!this.enableAiCleanup()) {
      this.enableAiCleanup.set(true);
      // Remove cleanup from skipped steps since we're configuring it
      this._skippedSteps.delete('cleanup');
    } else {
      this.enableAiCleanup.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI Prompt Editor (edits the global cleanup prompt file)
  // ─────────────────────────────────────────────────────────────────────────

  async togglePromptAccordion(): Promise<void> {
    const opening = !this.promptAccordionOpen();
    this.promptAccordionOpen.set(opening);
    if (opening && !this.promptText() && !this.loadingPrompt()) {
      await this.loadPrompt();
    }
  }

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
    this.promptText.set((event.target as HTMLTextAreaElement).value);
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

  toggleSimplify(): void {
    if (!this.simplifyForLearning()) {
      this.simplifyForLearning.set(true);
      // Remove cleanup from skipped steps since we're configuring it
      this._skippedSteps.delete('cleanup');
    } else {
      this.simplifyForLearning.set(false);
    }
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
      const active = this.translateMode() === 'sentence'
        ? this.targetLangs().size > 0
        : this.translateMode() === 'whole-book';
      if (!active) return true; // Can skip
      const provider = this.translateProvider();
      if (provider === 'ollama') return this.ollamaConnected() && !!this.translateModel();
      return !!this.translateModel();
    }
    if (step === 'tts') {
      if (this.pipelineMode() === 'mono') return true; // single voice always configured
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

  async goNext(): Promise<void> {
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

      // Check if TTS is configured when entering the step
      if (nextStep === 'tts') {
        // Re-scan for EPUBs to pick up newly created language files from Translation
        // IMPORTANT: Must await to ensure scan completes before TTS configuration
        await this.scanProjectEpubs();
        // Scan for partial TTS sessions (for Continue button)
        this.scanForPartialTtsSessions();

        if (this.pipelineMode() === 'mono' || this.ttsLanguageRows().length > 0) {
          // TTS is configured, remove from skipped
          this._skippedSteps.delete('tts');
        }
      }

      // Check if assembly is configured when entering the step
      if (nextStep === 'assembly') {
        if (this.pipelineMode() === 'mono') {
          if (!this._skippedSteps.has('tts') || this.cachedSession()) {
            this._skippedSteps.delete('assembly');
          }
        } else if (this.assemblySourceLang() && this.assemblyTargetLang()) {
          // Assembly has both languages configured, remove from skipped
          this._skippedSteps.delete('assembly');
        }
        // Rescan sessions when entering assembly step
        this.scanAvailableSessions();
      }

      // When entering review, un-skip steps that were auto-skipped but now have config.
      // Only un-skip if the user didn't explicitly skip the step (completedSteps tracks
      // steps the user passed through without skipping).
      if (nextStep === 'review') {
        // Check cleanup — only un-skip if user visited the step (completed it)
        if ((this.enableAiCleanup() || this.simplifyForLearning()) && this.completedSteps.has('cleanup')) {
          this._skippedSteps.delete('cleanup');
        }
        // Check translation
        const translationConfigured = this.translateMode() === 'sentence'
          ? this.targetLangs().size > 0
          : this.monoTranslationActive();
        if (translationConfigured && this.completedSteps.has('translate')) {
          this._skippedSteps.delete('translate');
        }
        // Check TTS — don't un-skip if user explicitly skipped it
        if ((this.pipelineMode() === 'mono' || this.ttsLanguageRows().length > 0) && this.completedSteps.has('tts')) {
          this._skippedSteps.delete('tts');
        }
        // Check assembly
        const assemblyConfigured = this.pipelineMode() === 'mono'
          ? (!this._skippedSteps.has('tts') || !!this.cachedSession())
          : !!(this.assemblySourceLang() && this.assemblyTargetLang());
        if (assemblyConfigured && this.completedSteps.has('assembly')) {
          this._skippedSteps.delete('assembly');
        }
      }

      // Auto-skip assembly if it has nothing to work with
      if (step === 'assembly') {
        if (this.pipelineMode() === 'mono') {
          if (this._skippedSteps.has('tts') && !this.cachedSession()) {
            this._skippedSteps.add('assembly');
          }
        } else if (!this.assemblySourceLang() || !this.assemblyTargetLang()) {
          this._skippedSteps.add('assembly');
        }
      }

      this.currentStep.set(nextStep);
    }
  }

  goBack(): void {
    const stepOrder: LLWizardStep[] = ['cleanup', 'translate', 'tts', 'assembly', 'review'];
    const currentIndex = stepOrder.indexOf(this.currentStep());
    if (currentIndex > 0) {
      const prevStep = stepOrder[currentIndex - 1];
      this.currentStep.set(prevStep);
      if (prevStep === 'tts') {
        this.scanForPartialTtsSessions();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Review Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getTotalJobCount(): number {
    if (this.pipelineMode() === 'mono') {
      let count = 0;
      // Mono cleanup is a single job (handles cleanup and/or simplify internally)
      if (!this._skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning())) count += 1;
      if (!this._skippedSteps.has('translate') && this.monoTranslationActive()) count += 1;
      const hasTts = !this._skippedSteps.has('tts');
      if (hasTts) count += 1;
      const hasAssembly = !this._skippedSteps.has('assembly') && (hasTts || !!this.cachedSession());
      if (hasAssembly) count += 1;
      if (hasAssembly && this.generateVideo()) count += 1;
      return count;
    }

    let count = 0;

    // Cleanup + Simplify jobs (independent, can both be enabled)
    if (!this._skippedSteps.has('cleanup')) {
      if (this.enableAiCleanup()) count += 1;
      if (this.simplifyForLearning()) count += 1;
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
    if (this.pipelineMode() === 'mono') {
      const warnings: string[] = [];
      if (!this._skippedSteps.has('assembly') && this._skippedSteps.has('tts') && !this.cachedSession()) {
        warnings.push('Assembly enabled but there is no TTS job or cached session to assemble from');
      }
      return warnings;
    }

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

  /**
   * Pre-flight: if a selected XTTS voice isn't downloaded yet, offer a one-click
   * download before queuing. Declining still proceeds — the voice then downloads
   * on demand when the job runs (with progress in the queue). Voices that aren't
   * downloadable components (the stock voice / voice-library clones, which use
   * the base model) are left to that on-demand path.
   */
  private async ensureSelectedVoicesAvailable(): Promise<void> {
    if (this._skippedSteps.has('tts') || this.ttsEngine() !== 'xtts') return;
    await this.componentService.ensureLoaded();

    const ids = this.pipelineMode() === 'mono'
      ? [this.monoTtsVoice()]
      : this.ttsLanguageRows().map(r => r.voice);

    const statuses = this.componentService.components();
    const missing = [...new Set(ids)]
      .map(id => statuses.find(s => s.component.id === id && s.component.kind === 'tts-model'))
      .filter((s): s is NonNullable<typeof s> => !!s && !this.componentService.isInstalled(s!.component.id));

    if (missing.length === 0) return;

    const names = missing.map(s => s.component.name).join(', ');
    const plural = missing.length > 1;
    const { confirmed } = await this.electronService.showConfirmDialog({
      type: 'question',
      title: plural ? 'Download voices?' : 'Download voice?',
      message: `${names} ${plural ? "aren't" : "isn't"} downloaded yet (~1.7 GB each).`,
      detail: 'Download now, or choose “Queue anyway” to fetch it automatically when the job runs.',
      confirmLabel: 'Download now',
      cancelLabel: 'Queue anyway',
    });
    if (!confirmed) return; // proceed; the on-demand fallback handles it at job time

    for (const s of missing) {
      this.voiceDownloadMsg.set(`Downloading ${s.component.name}…`);
      try {
        await this.componentService.install(s.component.id);
      } catch (err) {
        console.error('[LL-WIZARD] Voice download failed (will retry at job time):', err);
      }
    }
    this.voiceDownloadMsg.set(null);
  }

  async addToQueue(): Promise<void> {
    if (this.getTotalJobCount() === 0) return;

    const projectDir = this.effectiveProjectDir();
    if (!projectDir) {
      console.error('[LLWizard] No project directory available');
      return;
    }

    await this.ensureSelectedVoicesAvailable();

    if (this.pipelineMode() === 'mono') {
      return this.addMonoJobsToQueue(projectDir);
    }

    this.addingToQueue.set(true);

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();

      // Track what the cleanup step will produce (for downstream jobs to reference)
      let cleanupWillProduce: 'cleaned' | 'simplified' | null = null;

      // 1. Cleanup + Simplify jobs (independent, can both be enabled)
      if (!this._skippedSteps.has('cleanup')) {
        const cleanupValue = this.enableAiCleanup();
        const simplifyValue = this.simplifyForLearning();

        // Shared AI config for both jobs
        const baseConfig = {
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
          cleanupPrompt: undefined as string | undefined, // Backend loads from file
          customInstructions: this.customInstructions() || undefined,
        };

        // Resolve cleanup source from stage picker
        const cleanupSource = this.resolveLatestSource('cleanup');

        // Job 1a: AI Cleanup
        if (cleanupValue) {
          console.log('[LL-WIZARD] Creating AI Cleanup job');
          await this.queueService.addJob({
            type: 'bilingual-cleanup',
            epubPath: cleanupSource,
            projectDir: projectDir,
            metadata: {
              title: 'AI Cleanup',
            },
            config: { ...baseConfig, simplifyForLearning: false },
            workflowId,
          });
          cleanupWillProduce = 'cleaned';
        }

        // Job 1b: Simplify (uses cleaned.epub as input if cleanup also enabled)
        if (simplifyValue) {
          const simplifySource = cleanupValue
            ? `${projectDir}/stages/01-cleanup/cleaned.epub`
            : cleanupSource;
          console.log('[LL-WIZARD] Creating Simplify job, source:', simplifySource);
          await this.queueService.addJob({
            type: 'bilingual-cleanup',
            epubPath: simplifySource,
            projectDir: projectDir,
            metadata: {
              title: 'Simplify for Learning',
            },
            config: { ...baseConfig, simplifyForLearning: true },
            workflowId,
          });
          cleanupWillProduce = 'simplified';
        }
      }

      // 2. Translation jobs (if not skipped, one per target language)
      if (!this._skippedSteps.has('translate') && this.targetLangs().size > 0) {
        // If cleanup/simplify is in the pipeline, use the expected output path
        // (the file won't exist yet but will by the time translate runs)
        let translateSource: string;
        if (cleanupWillProduce) {
          translateSource = `${projectDir}/stages/01-cleanup/${cleanupWillProduce}.epub`;
          console.log('[LL-WIZARD] Translate will use expected cleanup output:', translateSource);
        } else {
          translateSource = this.resolveLatestSource('translate');
        }

        for (const targetLang of this.targetLangs()) {
          await this.queueService.addJob({
            type: 'bilingual-translation',
            epubPath: translateSource,
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
              customInstructions: this.translateCustomInstructions() || undefined,
            },
            workflowId,
          });
        }
      }

      // 3. TTS jobs (one per language row, or resume partial sessions)
      if (!this._skippedSteps.has('tts')) {
       // Check if assembly chaining is needed (TTS → Assembly via bilingual workflow pattern)
       const assemblyChained = !this._skippedSteps.has('assembly')
         && !!this.assemblySourceLang() && !!this.assemblyTargetLang();

       if (this.continueTts() && this.partialTtsSessions().length) {
        // Continue mode: resume partial TTS sessions
        console.log(`[LL-WIZARD] Creating TTS resume jobs for ${this.partialTtsSessions().length} partial sessions`);
        const electron = window.electron as any;
        for (const session of this.partialTtsSessions()) {
          const resumeCheck = await electron.parallelTts.checkResumeFromDir(session.sessionDir);
          const resumeData = resumeCheck?.data;
          if (!resumeData?.success) {
            console.error(`[LL-WIZARD] Failed to get resume info for ${session.language}:`, resumeCheck?.data?.error);
            continue;
          }

          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: resumeData.sourceEpubPath || '',
            projectDir,
            metadata: { title: `TTS Continue (${session.language.toUpperCase()})`, coverPath: this.coverPath() || undefined },
            config: {
              type: 'tts-conversion',
              language: session.language,
              useParallel: true,
              parallelMode: 'sentences',
              parallelWorkers: this.ttsWorkers(),
              skipAssembly: true,
              sentencePerParagraph: true,
              skipHeadings: true,
              outputDir: `/tmp/bookforge-tts-${Date.now()}`,
            },
            resumeInfo: {
              success: true,
              sessionId: resumeData.sessionId,
              sessionDir: resumeData.sessionDir,
              processDir: resumeData.processDir || session.sessionDir,
              totalSentences: resumeData.totalSentences,
              totalChapters: resumeData.totalChapters,
              completedSentences: resumeData.completedSentences,
              missingSentences: resumeData.missingSentences,
              missingRanges: resumeData.missingRanges,
              chapters: resumeData.chapters,
            },
            workflowId,
          });
        }
       } else {
        console.log(`[LL-WIZARD] Creating TTS jobs. ProjectDir: ${projectDir}`);

        const asmSourceLang = this.assemblySourceLang();
        const asmTargetLang = this.assemblyTargetLang();

        // Resolve EPUBs for all TTS rows
        // When translation is in the pipeline, use the expected output path (file won't exist yet)
        const translationActive = !this._skippedSteps.has('translate') && this.targetLangs().size > 0;
        const resolvedEpubs = new Map<string, { path: string; source: string; exists: boolean }>();
        for (const row of this.ttsLanguageRows()) {
          if (translationActive) {
            // Translation will create {lang}.epub in stages/02-translate/ before TTS runs
            const expectedPath = `${projectDir}/stages/02-translate/${row.language}.epub`;
            resolvedEpubs.set(row.language, { path: expectedPath, source: 'language', exists: false });
          } else {
            const resolved = await this.epubResolver.resolveEpub({
              projectDir: projectDir,
              audiobookDir: '',
              pipeline: 'language-learning',
              language: row.language
            });
            resolvedEpubs.set(row.language, resolved);
          }
        }

        const audiobooksDir = '';
        const targetEpubPath = assemblyChained ? resolvedEpubs.get(asmTargetLang)?.path : undefined;
        const targetRow = assemblyChained
          ? this.ttsLanguageRows().find(r => r.language === asmTargetLang)
          : undefined;

        // Detect "solo TTS + cached partner" scenario:
        // One assembly language is in TTS rows, the other is already cached
        const ttsRowLangs = new Set(this.ttsLanguageRows().map(r => r.language));
        const sourceInTts = ttsRowLangs.has(asmSourceLang);
        const targetInTts = ttsRowLangs.has(asmTargetLang);
        const soloTts = assemblyChained && (sourceInTts !== targetInTts); // exactly one is in TTS

        // Get cached session dir for the partner language (if solo)
        let cachedPartnerDir = '';
        if (soloTts) {
          const cachedLang = sourceInTts ? asmTargetLang : asmSourceLang;
          const cachedSession = this.availableSessions().find(s => s.language === cachedLang);
          cachedPartnerDir = cachedSession?.sessionDir || '';
          console.log(`[LL-WIZARD] Solo TTS: ${sourceInTts ? asmSourceLang : asmTargetLang} will be TTS'd, ${cachedLang} cached at: ${cachedPartnerDir}`);
        }

        for (const row of this.ttsLanguageRows()) {
          const resolved = resolvedEpubs.get(row.language)!;

          console.log(`[LL-WIZARD] RESOLVED EPUB for ${row.language}:`, {
            resolvedPath: resolved.path,
            source: resolved.source,
            exists: resolved.exists
          });

          // Build metadata with chaining info when assembly is enabled
          const metadata: any = {
            title: `TTS (${row.language.toUpperCase()})`,
            coverPath: this.coverPath() || undefined,
          };

          if (soloTts && (row.language === asmSourceLang || row.language === asmTargetLang)) {
            // Solo TTS: one assembly language being TTS'd, the other is cached
            // This job runs immediately (no placeholder) and chains directly to assembly
            const isSourceLang = row.language === asmSourceLang;
            metadata.bilingualWorkflow = {
              role: 'solo',
              // Pre-fill the cached dir; leave the other empty (filled from TTS output)
              assemblySourceSentencesDir: isSourceLang ? '' : cachedPartnerDir,
              assemblyTargetSentencesDir: isSourceLang ? cachedPartnerDir : '',
              assemblyConfig: {
                projectId: this.projectId(),
                audiobooksDir: audiobooksDir || projectDir,
                bfpPath: this.bfpPath(),
                sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${asmTargetLang}.json`,
                pauseDuration: this.pauseDuration(),
                gapDuration: this.gapDuration(),
                title: this.projectTitle() || this.title(),
                sourceLang: asmSourceLang,
                targetLang: asmTargetLang,
                pattern: this.assemblyPattern(),
              }
            };
          } else if (assemblyChained && !soloTts && row.language === asmSourceLang && targetEpubPath && targetRow) {
            // Source TTS: carries chaining config for target TTS + assembly
            metadata.bilingualWorkflow = {
              role: 'source',
              targetEpubPath,
              targetConfig: {
                epubPath: targetEpubPath,
                language: asmTargetLang,
                ttsEngine: this.ttsEngine(),
                voice: targetRow.voice,
                speed: targetRow.speed,
                device: this.ttsDevice(),
                workerCount: this.ttsWorkers(),
                outputDir: '',
              },
              assemblyConfig: {
                projectId: this.projectId(),
                audiobooksDir: audiobooksDir || projectDir,
                bfpPath: this.bfpPath(),
                sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${asmTargetLang}.json`,
                pauseDuration: this.pauseDuration(),
                gapDuration: this.gapDuration(),
                title: this.projectTitle() || this.title(),
                sourceLang: asmSourceLang,
                targetLang: asmTargetLang,
                pattern: this.assemblyPattern(),
              }
            };
          } else if (assemblyChained && !soloTts && row.language === asmTargetLang) {
            // Target TTS: placeholder — skipped by processNext() until source TTS completes
            metadata.bilingualPlaceholder = { role: 'target', projectId: this.projectId() };
          }

          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: resolved.path,
            projectDir: projectDir,
            bfpPath: undefined,
            metadata,
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
              testMode: this.ttsTestMode(),
              testSentences: this.ttsTestSentences(),
              // Skip assembly - only generate sentence audio files
              skipAssembly: true,
              // Output to temp directory
              outputDir: `/tmp/bookforge-tts-${Date.now()}`,
            },
            workflowId,
          });
        }
       }
      }

      // 4. Assembly job
      if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
        const sourceLang = this.assemblySourceLang();
        const targetLang = this.assemblyTargetLang();
        const audiobooksDir = '';

        if (!this._skippedSteps.has('tts')) {
          // Assembly chained to TTS — placeholder activated by target TTS completion handler
          await this.queueService.addJob({
            type: 'bilingual-assembly',
            projectDir: projectDir,
            metadata: {
              title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
              bilingualPlaceholder: { role: 'assembly', projectId: this.projectId() },
            },
            config: {
              type: 'bilingual-assembly',
              projectId: this.projectId(),
              bfpPath: this.bfpPath(),
              sourceSentencesDir: '',  // Filled by TTS completion handler
              targetSentencesDir: '',  // Filled by TTS completion handler
              sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
              outputDir: audiobooksDir || projectDir,
              pauseDuration: this.pauseDuration(),
              gapDuration: this.gapDuration(),
              sourceLang,
              targetLang,
              title: this.projectTitle() || this.title(),
              pattern: this.assemblyPattern(),
            },
            workflowId,
          });
        } else {
          // TTS skipped — standalone assembly (sentences must already exist in project sessions dir)
          await this.queueService.addJob({
            type: 'bilingual-assembly',
            projectDir: projectDir,
            metadata: {
              title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
            },
            config: {
              type: 'bilingual-assembly',
              projectId: this.projectId(),
              bfpPath: this.bfpPath(),
              sourceSentencesDir: this.availableSessions().find(s => s.language === sourceLang)?.sessionDir
                || `${projectDir}/stages/03-tts/sessions/${sourceLang}/sentences`,
              targetSentencesDir: this.availableSessions().find(s => s.language === targetLang)?.sessionDir
                || `${projectDir}/stages/03-tts/sessions/${targetLang}/sentences`,
              sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
              outputDir: audiobooksDir || projectDir,
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
      }

      // 5. Video Assembly job (optional)
      if (this.generateVideo() && !this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
        const sourceLang = this.assemblySourceLang();
        const targetLang = this.assemblyTargetLang();
        const videoTitle = this.projectTitle() || this.title();

        // Build external filename: "{Title}. {Author} (language learning, en-de)"
        const langNames: Record<string, string> = {
          en: 'english', de: 'german', es: 'spanish', fr: 'french', it: 'italian',
          pt: 'portuguese', nl: 'dutch', pl: 'polish', ru: 'russian',
          ja: 'japanese', zh: 'chinese', ko: 'korean', ar: 'arabic',
        };
        const srcName = langNames[sourceLang] || sourceLang;
        const tgtName = langNames[targetLang] || targetLang;
        let videoOutputFilename = videoTitle;
        const author = this.author?.() || '';
        if (author && author !== 'Unknown' && !videoTitle.includes(author)) {
          videoOutputFilename += `. ${author}`;
        }
        videoOutputFilename += ` (language learning, ${srcName}-${tgtName})`;

        await this.queueService.addJob({
          type: 'video-assembly',
          projectDir,
          metadata: { title: `Video (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})` },
          config: {
            type: 'video-assembly',
            projectId: this.projectId(),
            bfpPath: this.bfpPath(),
            mode: 'bilingual',
            m4bPath: `${this.bfpPath()}/output/bilingual-${sourceLang}-${targetLang}.m4b`,
            vttPath: `${this.bfpPath()}/output/bilingual-${sourceLang}-${targetLang}.vtt`,
            sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
            title: videoTitle,
            sourceLang,
            targetLang,
            resolution: this.videoResolution(),
            outputFilename: videoOutputFilename,
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
        video: this.generateVideo(),
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
   * Mono (whole-book) pipeline submission — submits the same job set the old
   * standalone process-wizard submitted: master 'audiobook' job, ocr-cleanup
   * (books) / bilingual-cleanup (articles), whole-book bilingual-translation
   * (monoTranslation flag), single tts-conversion, reassembly (chained or from
   * cached session), and optional monolingual video-assembly.
   */
  private async addMonoJobsToQueue(projectDir: string): Promise<void> {
    this.addingToQueue.set(true);

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();
      const isArticle = this.itemType() === 'article';
      const bfpPath = this.bfpPath() || projectDir;
      const outputDir = this.libraryService.audiobooksPath() || '';
      const cleanupSource = this.resolveLatestSource('cleanup');

      // Master job groups the pipeline in the queue UI
      const masterJob = await this.queueService.addJob({
        type: 'audiobook',
        epubPath: cleanupSource,
        projectDir: isArticle ? projectDir : undefined,
        metadata: { title: this.title(), author: this.author() },
        config: { type: 'audiobook' },
        workflowId,
      });
      const masterJobId = masterJob.id;

      // 1. AI Cleanup (single job; handles cleanup and/or simplify internally)
      if (!this._skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning())) {
        if (isArticle) {
          await this.queueService.addJob({
            type: 'bilingual-cleanup',
            epubPath: cleanupSource,
            projectDir,
            metadata: { title: 'AI Cleanup' },
            config: {
              type: 'bilingual-cleanup',
              projectId: this.projectId(),
              projectDir,
              sourceLang: this.detectedSourceLang(),
              aiProvider: this.cleanupProvider(),
              aiModel: this.cleanupModel(),
              ollamaBaseUrl: aiConfig.ollama?.baseUrl,
              claudeApiKey: aiConfig.claude?.apiKey,
              openaiApiKey: aiConfig.openai?.apiKey,
              testMode: this.testMode(),
              testModeChunks: this.testModeChunks(),
              customInstructions: this.customInstructions() || undefined,
              simplifyForLearning: this.simplifyForLearning(),
            },
            workflowId,
            parentJobId: masterJobId,
          });
        } else {
          const cleanupConfig: Partial<OcrCleanupConfig> = {
            type: 'ocr-cleanup',
            aiProvider: this.cleanupProvider(),
            aiModel: this.cleanupModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
            enableAiCleanup: this.enableAiCleanup(),
            simplifyForLearning: this.simplifyForLearning(),
            simplifyMode: 'plain' as const,
            testMode: this.testMode(),
            testModeChunks: this.testMode() ? this.testModeChunks() : undefined,
            cleanupPrompt: this.promptModified() ? this.promptText() : undefined,  // Only override when user customized
            customInstructions: this.customInstructions() || undefined,
            // Only cloud APIs parallelize; ollama + bundled local AI run one server.
            useParallel: this.cleanupProvider() === 'claude' || this.cleanupProvider() === 'openai',
            parallelWorkers: this.cleanupParallelWorkers(),
          };

          await this.queueService.addJob({
            type: 'ocr-cleanup',
            epubPath: cleanupSource,
            bfpPath,
            metadata: { title: 'AI Cleanup' },
            config: cleanupConfig,
            workflowId,
            parentJobId: masterJobId,
          });
        }
      }

      // 2. Whole-book translation
      if (!this._skippedSteps.has('translate') && this.monoTranslationActive()) {
        const willProduce = this.cleanupWillProduce();
        const translateEpubPath = willProduce
          ? `${projectDir}/stages/01-cleanup/${willProduce}`
          : this.resolveLatestSource('translate');

        await this.queueService.addJob({
          type: 'bilingual-translation',
          epubPath: translateEpubPath,
          bfpPath: isArticle ? undefined : bfpPath,
          projectDir: isArticle ? projectDir : undefined,
          metadata: { title: 'Translation' },
          config: {
            type: 'bilingual-translation',
            projectId: isArticle ? this.projectId() : undefined,
            projectDir: isArticle ? projectDir : undefined,
            sourceLang: this.detectedSourceLang(),
            targetLang: this.monoTargetLang(),
            aiProvider: this.translateProvider(),
            aiModel: this.translateModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
            monoTranslation: true,  // Full-book translation (not bilingual interleave)
            customInstructions: this.translateCustomInstructions() || undefined,
          },
          workflowId,
          parentJobId: masterJobId,
        });
      }

      // 3. TTS (single voice)
      if (!this._skippedSteps.has('tts')) {
        const skipAssembly = !this._skippedSteps.has('assembly'); // e2a produces sentences only; we reassemble ourselves
        const partial = this.partialTtsSessions()[0];

        if (this.continueTts() && partial) {
          const electron = window.electron as any;
          const resumeCheck = await electron.parallelTts.checkResumeFromDir(partial.sessionDir);
          const resumeData = resumeCheck?.data;
          if (!resumeData?.success) {
            throw new Error('Failed to get resume info for partial session');
          }

          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: resumeData.sourceEpubPath || '',
            bfpPath,
            metadata: {
              title: 'TTS (Continue)',
              bookTitle: this.title(),
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
              outputFilename: this.generateOutputFilename(),
            },
            config: {
              type: 'tts-conversion',
              useParallel: true,
              parallelMode: 'sentences',
              parallelWorkers: this.ttsEngine() === 'xtts' ? this.ttsWorkers() : 1,
              outputDir,
              skipAssembly,
            },
            resumeInfo: {
              success: true,
              sessionId: resumeData.sessionId,
              sessionDir: resumeData.sessionDir,
              processDir: resumeData.processDir || partial.sessionDir,
              totalSentences: resumeData.totalSentences,
              totalChapters: resumeData.totalChapters,
              completedSentences: resumeData.completedSentences,
              missingSentences: resumeData.missingSentences,
              missingRanges: resumeData.missingRanges,
              chapters: resumeData.chapters,
            },
            workflowId,
            parentJobId: masterJobId,
          });
        } else {
          const ttsConfig: Partial<TtsConversionConfig> = {
            type: 'tts-conversion',
            device: this.ttsDevice(),
            language: this.monoTtsLanguage(),
            ttsEngine: this.ttsEngine(),
            fineTuned: this.monoTtsVoice(),
            temperature: this.ttsTemperature(),
            topP: this.ttsTopP(),
            topK: 50,
            repetitionPenalty: 1.0,
            speed: this.monoTtsSpeed(),
            enableTextSplitting: true,
            useParallel: true,
            parallelMode: 'sentences',
            parallelWorkers: this.ttsEngine() === 'xtts' ? this.ttsWorkers() : 1,
            testMode: this.ttsTestMode(),
            testSentences: this.ttsTestSentences(),
            outputDir,
            skipAssembly,
          };

          await this.queueService.addJob({
            type: 'tts-conversion',
            epubPath: this.resolveLatestSource('tts'),
            projectDir: isArticle ? projectDir : undefined,
            bfpPath: isArticle ? undefined : bfpPath,
            metadata: {
              title: 'TTS',
              bookTitle: this.title(),
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
              outputFilename: this.generateOutputFilename(),
            },
            config: ttsConfig,
            workflowId,
            parentJobId: masterJobId,
          });
        }
      }

      // 4. Assembly (reassembly into M4B + VTT)
      if (!this._skippedSteps.has('assembly')) {
        const audiobookDir = `${bfpPath.replace(/\\/g, '/')}/output`;

        if (!this._skippedSteps.has('tts')) {
          // MODE A: TTS + Assembly chained — session data discovered at runtime by queue service
          await this.queueService.addJob({
            type: 'reassembly',
            bfpPath,
            config: {
              type: 'reassembly',
              sessionId: '',   // filled at runtime via session discovery
              sessionDir: '',
              processDir: '',
              outputDir: audiobookDir,
              metadata: {
                title: this.title() || '',
                author: this.author() || '',
                coverPath: this.coverPath() || undefined,
                year: this.year() || undefined,
                outputFilename: this.generateOutputFilename(),
              },
              excludedChapters: [],
            },
            metadata: {
              title: this.title(),
              author: this.author(),
              year: this.year() || undefined,
            },
            workflowId,
            parentJobId: masterJobId,
          });
        } else if (this.cachedSession()) {
          // MODE B: TTS skipped, standalone reassembly from cached session
          const session = this.cachedSession();
          const totalChapters = session.chapters?.filter((ch: any) => !ch.excluded)?.length || 0;

          const reassemblyConfig: ReassemblyJobConfig = {
            type: 'reassembly',
            sessionId: session.sessionId,
            sessionDir: session.sessionDir,
            processDir: session.processDir,
            outputDir: audiobookDir,
            totalChapters,
            metadata: {
              title: this.title() || session.metadata?.title || '',
              author: this.author() || session.metadata?.author || '',
              year: this.year() || session.metadata?.year,
              coverPath: this.coverPath() || session.metadata?.coverPath,
              outputFilename: this.generateOutputFilename(),
            },
            excludedChapters: [],
          };

          await this.queueService.addJob({
            type: 'reassembly',
            epubPath: session.processDir,
            bfpPath,
            config: reassemblyConfig,
            metadata: { title: reassemblyConfig.metadata.title, author: reassemblyConfig.metadata.author, year: reassemblyConfig.metadata.year },
            workflowId,
            parentJobId: masterJobId,
          });
        }
      }

      // 5. Video Assembly (optional, after audio assembly)
      if (this.generateVideo() && !this._skippedSteps.has('assembly')) {
        let videoOutputFilename = this.title() || 'audiobook';
        const videoAuthor = this.author() || '';
        if (videoAuthor && videoAuthor !== 'Unknown' && !videoOutputFilename.includes(videoAuthor)) {
          videoOutputFilename += `. ${videoAuthor}`;
        }

        await this.queueService.addJob({
          type: 'video-assembly',
          bfpPath,
          metadata: { title: 'Video' },
          config: {
            type: 'video-assembly',
            projectId: bfpPath,
            bfpPath,
            mode: 'monolingual',
            m4bPath: `${bfpPath}/output/audiobook.m4b`,
            vttPath: `${bfpPath}/output/audiobook.vtt`,
            title: this.title(),
            sourceLang: this.monoTtsLanguage(),
            resolution: this.videoResolution(),
            outputFilename: videoOutputFilename,
          },
          workflowId,
          parentJobId: masterJobId,
        });
      }

      console.log('[PipelineWizard] Mono jobs added to queue:', {
        workflowId,
        masterJobId,
        isArticle,
        cleanup: !this._skippedSteps.has('cleanup') && (this.enableAiCleanup() || this.simplifyForLearning()),
        translate: !this._skippedSteps.has('translate') && this.monoTranslationActive(),
        tts: !this._skippedSteps.has('tts'),
        assembly: !this._skippedSteps.has('assembly'),
        video: this.generateVideo(),
        assemblyMode: !this._skippedSteps.has('assembly')
          ? (!this._skippedSteps.has('tts') ? 'chained' : (this.cachedSession() ? 'standalone' : 'none'))
          : 'skipped',
      });

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[PipelineWizard] Failed to add mono jobs to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  /**
   * M4B filename: respects the manifest's saved outputFilename when present,
   * otherwise derives "Title. LastName, FirstName. (Year).m4b".
   */
  private generateOutputFilename(): string {
    const saved = this.outputFilename().trim();
    if (saved) return saved;

    let name = this.title() || 'Audiobook';

    let authorPart = '';
    const contribs = this.contributors();
    if (contribs && contribs.length > 0) {
      const c = contribs[0];
      if (c.last && c.first) authorPart = `${c.last}, ${c.first}`;
      else authorPart = c.last || c.first || '';
    } else if (this.author()) {
      const parts = this.author().trim().split(/\s+/);
      authorPart = parts.length >= 2 ? `${parts.pop()}, ${parts.join(' ')}` : this.author();
    }

    if (authorPart) name += `. ${authorPart}`;
    if (this.year()) name += `. (${this.year()})`;
    return `${name}.m4b`;
  }

  /**
   * Resolve "latest" source EPUB based on pipeline stage
   */
  private resolveLatestSource(stage: 'cleanup' | 'translate' | 'tts'): string {
    const source = this.sourceSignalFor(stage)();

    if (source !== 'latest') {
      return source;
    }

    const epubs = this.availableEpubs();
    const projectDir = this.effectiveProjectDir();

    if (stage === 'tts') {
      // Mono TTS input: pipeline intent first — earlier steps in this run will
      // produce files that don't exist on disk yet
      if (this.monoTranslationActive()) {
        return `${projectDir}/stages/02-translate/translated.epub`;
      }
      const willProduce = this.cleanupWillProduce();
      if (willProduce && !epubs.some(e => e.filename === willProduce)) {
        return `${projectDir}/stages/01-cleanup/${willProduce}`;
      }
      const exclude = new Set<string>();
      for (const e of epubs) { if (e.isTranslated) exclude.add(e.filename); }
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.path;
      for (const name of ['translated.epub', 'simplified.epub', 'cleaned.epub', 'exported.epub', 'original.epub']) {
        const found = epubs.find(e => e.filename === name);
        if (found) return found.path;
      }
      return `${projectDir}/source/original.epub`;
    }

    if (stage === 'cleanup') {
      // Cleanup input: most recently modified source file
      // Exclude cleanup/translation outputs — we're producing those, not consuming them
      const sourceOnly = new Set(['cleaned.epub', 'simplified.epub', 'translated.epub']);
      for (const e of epubs) { if (e.isTranslated) sourceOnly.add(e.filename); }
      const best = this.getMostRecentEpub(epubs, sourceOnly);
      if (best) return best.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub');
      if (original) return original.path;
    } else if (stage === 'translate') {
      // Translate input: most recently modified wins (exclude translation outputs)
      const exclude = new Set<string>();
      for (const e of epubs) {
        if (e.isTranslated || e.filename === 'translated.epub') exclude.add(e.filename);
      }
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.path;
      const simplified = epubs.find(e => e.filename === 'simplified.epub');
      if (simplified) return simplified.path;
      const cleaned = epubs.find(e => e.filename === 'cleaned.epub');
      if (cleaned) return cleaned.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub');
      if (original) return original.path;
    }

    // Fallback: first available EPUB
    if (epubs.length > 0) {
      return epubs[0].path;
    }

    // Ultimate fallback
    return `${projectDir}/source/original.epub`;
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

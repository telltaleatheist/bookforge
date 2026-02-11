/**
 * BilingualWizardComponent - Full workflow for bilingual audiobook production
 *
 * Steps:
 * 1. Source - Show current book/article info, extract sentences
 * 2. Languages - Select source + target language(s)
 * 3. Processing - AI cleanup (optional) + translation config
 * 4. TTS - Per-language voice/speed settings
 * 5. Review - Summary and add to queue
 *
 * Works for both books and articles, producing interleaved or sequential
 * bilingual audiobooks.
 */

import { Component, input, output, signal, computed, inject, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../../core/services/settings.service';
import { LibraryService } from '../../../../core/services/library.service';
import { QueueService } from '../../../queue/services/queue.service';
import { AIProvider } from '../../../../core/models/ai-config.types';
import { CachedLanguageInfo } from '../../models/sentence-cache.types';
import { TtsConversionConfig, BilingualTranslationJobConfig, BilingualAssemblyJobConfig } from '../../../queue/models/queue.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WizardStep = 'source' | 'languages' | 'processing' | 'tts' | 'review';

interface LanguageOption {
  code: string;
  name: string;
  flagCss: string;
}

interface PerLanguageTtsConfig {
  voice: string;
  speed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-bilingual-wizard',
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
        <div class="step" [class.active]="currentStep() === 'languages'" [class.completed]="isStepCompleted('languages')">
          <span class="step-num">2</span>
          <span class="step-label">Languages</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'processing'" [class.completed]="isStepCompleted('processing')" [class.skipped]="isStepSkipped('processing')">
          <span class="step-num">3</span>
          <span class="step-label">Processing</span>
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'tts'" [class.completed]="isStepCompleted('tts')">
          <span class="step-num">4</span>
          <span class="step-label">TTS</span>
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
          @case ('source') {
            <div class="step-panel scrollable">
              <h3>Source Content</h3>
              <p class="step-desc">Extract sentences from your {{ itemType() }} for bilingual processing.</p>

              <div class="source-info">
                <div class="info-row">
                  <span class="info-label">Title:</span>
                  <span class="info-value">{{ title() || 'Untitled' }}</span>
                </div>
                @if (author()) {
                  <div class="info-row">
                    <span class="info-label">Author:</span>
                    <span class="info-value">{{ author() }}</span>
                  </div>
                }
                <div class="info-row">
                  <span class="info-label">Type:</span>
                  <span class="info-value type-badge">{{ itemType() === 'book' ? 'Book' : 'Article' }}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Source:</span>
                  <span class="info-value">{{ epubFilename() }}</span>
                </div>
              </div>

              <!-- Cached Languages Status -->
              @if (loading()) {
                <div class="loading-state">
                  <div class="spinner"></div>
                  <span>Loading cache...</span>
                </div>
              } @else if (cachedLanguages().length > 0) {
                <div class="cache-status">
                  <h4>Cached Sentences</h4>
                  <div class="cached-list">
                    @for (lang of cachedLanguages(); track lang.code) {
                      <div class="cached-item" [class.has-audio]="lang.hasAudio">
                        <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                        <span class="lang-name">{{ lang.name }}</span>
                        <span class="sentence-count">{{ lang.sentenceCount }} sentences</span>
                        @if (lang.hasAudio) {
                          <span class="audio-badge">Audio Ready</span>
                        }
                      </div>
                    }
                  </div>
                  <p class="hint">You can continue from existing cache or start fresh.</p>
                </div>
              } @else {
                <div class="no-cache-status">
                  <p>No cached sentences found. Sentences will be extracted in the Processing step.</p>
                </div>
              }
            </div>
          }

          @case ('languages') {
            <div class="step-panel scrollable">
              <h3>Language Selection</h3>
              <p class="step-desc">Choose the source language and target language(s) for translation.</p>

              <div class="config-section">
                <label class="field-label">Source Language</label>
                <div class="language-grid">
                  @for (lang of availableLanguages; track lang.code) {
                    <button
                      class="language-btn"
                      [class.selected]="sourceLang() === lang.code"
                      [class.disabled]="targetLangs().has(lang.code)"
                      (click)="setSourceLang(lang.code)"
                    >
                      <span class="lang-flag" [style.background]="lang.flagCss"></span>
                      <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                      <span class="lang-name">{{ lang.name }}</span>
                      @if (sourceLang() === lang.code) {
                        <span class="lang-check">✓</span>
                      }
                    </button>
                  }
                </div>
              </div>

              <div class="config-section">
                <label class="field-label">Target Language(s)</label>
                <p class="section-hint">Select one or more languages to translate into.</p>
                <div class="language-grid">
                  @for (lang of availableLanguages; track lang.code) {
                    <button
                      class="language-btn"
                      [class.selected]="targetLangs().has(lang.code)"
                      [class.disabled]="sourceLang() === lang.code"
                      (click)="toggleTargetLang(lang.code)"
                    >
                      <span class="lang-flag" [style.background]="lang.flagCss"></span>
                      <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                      <span class="lang-name">{{ lang.name }}</span>
                      @if (targetLangs().has(lang.code)) {
                        <span class="lang-check">✓</span>
                      }
                    </button>
                  }
                </div>
              </div>
            </div>
          }

          @case ('processing') {
            <div class="step-panel scrollable">
              <h3>AI Processing</h3>
              <p class="step-desc">Configure AI cleanup and translation settings.</p>

              <!-- AI Provider Selection -->
              <div class="config-section">
                <label class="field-label">AI Provider</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="aiProvider() === 'ollama'"
                    (click)="selectProvider('ollama')"
                  >
                    <span class="provider-icon">🦙</span>
                    <span class="provider-name">Ollama</span>
                    <span class="provider-status">Local</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="aiProvider() === 'claude'"
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
                    [class.selected]="aiProvider() === 'openai'"
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

                <label class="field-label">Model</label>
                <select class="select-input" [value]="aiModel()" (change)="aiModel.set($any($event.target).value)">
                  @for (model of availableModels(); track model.value) {
                    <option [value]="model.value">{{ model.label }}</option>
                  }
                </select>
              </div>

              <!-- Optional AI Cleanup -->
              <div class="config-section">
                <div class="toggle-row">
                  <label class="toggle-label">
                    <input type="checkbox" [checked]="enableCleanup()" (change)="enableCleanup.set($any($event.target).checked)" />
                    <span>Enable AI Cleanup</span>
                  </label>
                  <span class="toggle-hint">Fix OCR errors and formatting before translation</span>
                </div>
              </div>

              <!-- Segment Size -->
              <div class="config-section">
                <label class="field-label">Segment Size</label>
                <p class="section-hint">How to split text for alternating audio.</p>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="splitGranularity() === 'sentence'"
                    (click)="splitGranularity.set('sentence')"
                  >
                    <span class="provider-name">Sentences</span>
                    <span class="provider-status">Recommended</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="splitGranularity() === 'paragraph'"
                    (click)="splitGranularity.set('paragraph')"
                  >
                    <span class="provider-name">Paragraphs</span>
                    <span class="provider-status">Longer</span>
                  </button>
                </div>
              </div>
            </div>
          }

          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">Configure voice settings for each language.</p>

              <!-- TTS Engine -->
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

              <!-- Device -->
              <div class="config-section">
                <label class="field-label">Device</label>
                <div class="provider-buttons compact">
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'cpu'" (click)="ttsDevice.set('cpu')">CPU</button>
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'mps'" (click)="ttsDevice.set('mps')">MPS</button>
                  <button class="provider-btn" [class.selected]="ttsDevice() === 'gpu'" (click)="ttsDevice.set('gpu')">GPU</button>
                </div>
              </div>

              <!-- Workers (XTTS only) -->
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
                  <span class="hint">More workers = faster, but uses ~3GB RAM each</span>
                </div>
              }

              <!-- Per-Language Voice Settings -->
              <div class="config-section">
                <label class="field-label">Voice Settings</label>
                <div class="voice-settings">
                  <!-- Source language -->
                  <div class="voice-row">
                    <span class="voice-lang source">{{ sourceLang().toUpperCase() }} (Source)</span>
                    <select
                      class="select-input voice-select"
                      [value]="getVoiceForLang(sourceLang())"
                      (change)="setVoiceForLang(sourceLang(), $any($event.target).value)"
                    >
                      @for (voice of getVoicesForEngine(); track voice.value) {
                        <option [value]="voice.value">{{ voice.label }}</option>
                      }
                    </select>
                    <input
                      type="range"
                      min="0.5" max="2" step="0.05"
                      class="speed-slider"
                      [value]="getSpeedForLang(sourceLang())"
                      (input)="setSpeedForLang(sourceLang(), +$any($event.target).value)"
                    >
                    <span class="speed-label">{{ getSpeedForLang(sourceLang()).toFixed(2) }}x</span>
                  </div>
                  <!-- Target languages -->
                  @for (langCode of targetLangs(); track langCode) {
                    <div class="voice-row">
                      <span class="voice-lang target">{{ langCode.toUpperCase() }} (Target)</span>
                      <select
                        class="select-input voice-select"
                        [value]="getVoiceForLang(langCode)"
                        (change)="setVoiceForLang(langCode, $any($event.target).value)"
                      >
                        @for (voice of getVoicesForEngine(); track voice.value) {
                          <option [value]="voice.value">{{ voice.label }}</option>
                        }
                      </select>
                      <input
                        type="range"
                        min="0.5" max="2" step="0.05"
                        class="speed-slider"
                        [value]="getSpeedForLang(langCode)"
                        (input)="setSpeedForLang(langCode, +$any($event.target).value)"
                      >
                      <span class="speed-label">{{ getSpeedForLang(langCode).toFixed(2) }}x</span>
                    </div>
                  }
                </div>
              </div>

              <!-- Assembly Settings -->
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
                    <span class="provider-status">All EN, then DE</span>
                  </button>
                </div>

                <label class="field-label">Pause Between Languages</label>
                <select class="select-input" [(ngModel)]="pauseDuration">
                  <option [value]="0.3">0.3 sec</option>
                  <option [value]="0.5">0.5 sec</option>
                  <option [value]="1.0">1 sec</option>
                  <option [value]="1.5">1.5 sec</option>
                  <option [value]="2.0">2 sec</option>
                </select>
              </div>
            </div>
          }

          @case ('review') {
            <div class="step-panel">
              <h3>Review & Queue</h3>
              <p class="step-desc">Review your settings before adding to queue.</p>

              <div class="review-section">
                <div class="review-item">
                  <span class="review-label">Source:</span>
                  <span class="review-value">{{ title() || epubFilename() }}</span>
                </div>
                <div class="review-item">
                  <span class="review-label">Languages:</span>
                  <span class="review-value">{{ sourceLang().toUpperCase() }} → {{ getTargetLangsDisplay() }}</span>
                </div>
                <div class="review-item">
                  <span class="review-label">AI Processing:</span>
                  <span class="review-value">
                    {{ aiProvider() }} / {{ aiModel() }}
                    @if (enableCleanup()) { (with cleanup) }
                  </span>
                </div>
                <div class="review-item">
                  <span class="review-label">TTS:</span>
                  <span class="review-value">{{ ttsEngine() }} ({{ ttsDevice() }})</span>
                </div>
                <div class="review-item">
                  <span class="review-label">Assembly:</span>
                  <span class="review-value">{{ assemblyPattern() }}, {{ pauseDuration }}s pause</span>
                </div>
              </div>

              <div class="jobs-preview">
                <h4>Jobs to be created:</h4>
                <ul class="job-list">
                  @if (enableCleanup()) {
                    <li>AI Cleanup</li>
                  }
                  @for (lang of targetLangs(); track lang) {
                    <li>Translation ({{ sourceLang().toUpperCase() }} → {{ lang.toUpperCase() }})</li>
                  }
                  <li>TTS - {{ sourceLang().toUpperCase() }}</li>
                  @for (lang of targetLangs(); track lang) {
                    <li>TTS - {{ lang.toUpperCase() }}</li>
                  }
                  @for (lang of targetLangs(); track lang) {
                    <li>Assembly ({{ sourceLang().toUpperCase() }}-{{ lang.toUpperCase() }})</li>
                  }
                </ul>
              </div>
            </div>
          }
        }
      </div>

      <!-- Navigation -->
      <div class="wizard-nav">
        @if (currentStep() !== 'source') {
          <button class="btn-back" (click)="goBack()">← Back</button>
        } @else {
          <div></div>
        }

        <div class="nav-right">
          @if (currentStep() === 'processing') {
            <button class="btn-skip" (click)="skipStep()">Skip Processing</button>
          }
          @if (currentStep() !== 'review') {
            <button class="btn-next" (click)="goNext()" [disabled]="!canProceed()">
              Next →
            </button>
          } @else {
            <button
              class="btn-queue"
              [class.added]="addedToQueue()"
              [disabled]="addingToQueue() || addedToQueue()"
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
      border: 1px solid var(--border-default);
      border-radius: 12px;
      margin-bottom: 16px;
      flex-shrink: 0;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 16px;
      transition: all 0.15s ease;

      &.active {
        background: rgba(6, 182, 212, 0.15);

        .step-num {
          background: var(--color-primary);
          color: white;
        }
        .step-label {
          color: var(--color-primary);
          font-weight: 600;
        }
      }

      &.completed .step-num {
        background: #22c55e;
        color: white;
      }

      &.skipped {
        opacity: 0.5;
      }
    }

    .step-num {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .step-label {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .step-connector {
      width: 20px;
      height: 2px;
      background: var(--border-default);
    }

    /* Step Content */
    .step-content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .step-panel {
      height: 100%;
      padding: 20px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      overflow: hidden;

      &.scrollable {
        overflow-y: auto;
      }

      h3 {
        margin: 0 0 8px;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .step-desc {
        margin: 0 0 20px;
        font-size: 14px;
        color: var(--text-secondary);
      }
    }

    /* Source Info */
    .source-info {
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .info-row {
      display: flex;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .info-label {
      min-width: 80px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    .info-value {
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;

      &.type-badge {
        background: rgba(6, 182, 212, 0.15);
        color: var(--color-primary);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
      }
    }

    /* Cache Status */
    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 40px;
      color: var(--text-secondary);
    }

    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-default);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .cache-status, .no-cache-status {
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 16px;

      h4 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
      }
    }

    .cached-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .cached-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: var(--bg-elevated);
      border-radius: 6px;

      &.has-audio {
        border-left: 3px solid #22c55e;
      }
    }

    .lang-code {
      font-weight: 600;
      font-size: 13px;
      min-width: 28px;
    }

    .lang-name {
      color: var(--text-secondary);
      font-size: 13px;
    }

    .sentence-count {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .audio-badge {
      font-size: 11px;
      padding: 2px 8px;
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
      border-radius: 10px;
    }

    /* Config Sections */
    .config-section {
      margin-bottom: 24px;
    }

    .field-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

    .section-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0 0 12px;
    }

    /* Language Grid */
    .language-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }

    .language-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(.disabled) {
        border-color: var(--color-primary);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.1);
        border-color: var(--color-primary);
      }

      &.disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .lang-flag {
        width: 24px;
        height: 16px;
        border-radius: 3px;
        flex-shrink: 0;
      }

      .lang-code {
        font-weight: 600;
        font-size: 12px;
      }

      .lang-name {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .lang-check {
        margin-left: auto;
        color: var(--color-primary);
        font-weight: bold;
      }
    }

    /* Provider Buttons */
    .provider-buttons {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;

      &.compact {
        .provider-btn {
          padding: 8px 16px;
          .provider-name { font-size: 13px; }
        }
      }
    }

    .provider-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 16px;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(.disabled) {
        border-color: var(--color-primary);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.1);
        border-color: var(--color-primary);
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .provider-icon {
        font-size: 24px;
      }

      .provider-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .provider-status {
        font-size: 11px;
        color: var(--text-muted);
      }
    }

    .select-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;

      &:focus {
        outline: none;
        border-color: var(--color-primary);
      }
    }

    /* Toggle Row */
    .toggle-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .toggle-label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 14px;
      color: var(--text-primary);

      input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
      }
    }

    .toggle-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: 26px;
    }

    /* Worker Options */
    .worker-options {
      display: flex;
      gap: 8px;
    }

    .worker-btn {
      width: 48px;
      height: 36px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-base);
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--color-primary);
      }

      &.selected {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }
    }

    /* Voice Settings */
    .voice-settings {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .voice-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
    }

    .voice-lang {
      min-width: 100px;
      font-weight: 600;
      font-size: 13px;

      &.source {
        color: var(--color-primary);
      }

      &.target {
        color: #22c55e;
      }
    }

    .voice-select {
      flex: 1;
      max-width: 180px;
    }

    .speed-slider {
      width: 100px;
      cursor: pointer;
    }

    .speed-label {
      min-width: 50px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: right;
    }

    /* Review Section */
    .review-section {
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .review-item {
      display: flex;
      padding: 10px 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .review-label {
      min-width: 120px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .review-value {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .jobs-preview {
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 16px;

      h4 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
      }
    }

    .job-list {
      margin: 0;
      padding: 0 0 0 20px;

      li {
        padding: 6px 0;
        font-size: 13px;
        color: var(--text-secondary);
      }
    }

    /* Navigation */
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0 0;
      margin-top: 16px;
      border-top: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .nav-right {
      display: flex;
      gap: 12px;
    }

    .btn-back, .btn-skip, .btn-next, .btn-queue {
      padding: 10px 20px;
      border-radius: 8px;
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
        border-color: var(--color-primary);
        color: var(--color-primary);
      }
    }

    .btn-next {
      background: var(--color-primary);
      border: none;
      color: white;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-queue {
      background: #22c55e;
      border: none;
      color: white;
      min-width: 140px;

      &:hover:not(:disabled) {
        background: #16a34a;
      }

      &:disabled {
        opacity: 0.7;
        cursor: not-allowed;
      }

      &.added {
        background: #22c55e;
      }
    }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 8px;
    }
  `]
})
export class BilingualWizardComponent implements OnInit, OnChanges {
  private readonly settingsService = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);

  // ─────────────────────────────────────────────────────────────────────────
  // Inputs
  // ─────────────────────────────────────────────────────────────────────────

  readonly epubPath = input.required<string>();
  readonly originalEpubPath = input<string>('');
  readonly title = input<string>('');
  readonly author = input<string>('');
  readonly itemType = input<'book' | 'article'>('book');
  readonly bfpPath = input<string>('');
  readonly projectId = input<string>('');
  readonly projectDir = input<string>('');
  readonly audiobookFolder = input<string>('');

  // ─────────────────────────────────────────────────────────────────────────
  // Outputs
  // ─────────────────────────────────────────────────────────────────────────

  readonly queued = output<void>();

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────

  readonly currentStep = signal<WizardStep>('source');
  readonly completedSteps = new Set<WizardStep>();
  readonly skippedSteps = new Set<WizardStep>();

  readonly loading = signal(true);
  readonly cachedLanguages = signal<CachedLanguageInfo[]>([]);

  // Language selection
  readonly sourceLang = signal('en');
  readonly targetLangs = signal<Set<string>>(new Set(['de']));

  // AI Processing
  readonly aiProvider = signal<AIProvider>('ollama');
  readonly aiModel = signal('llama3.2');
  readonly enableCleanup = signal(false);
  readonly splitGranularity = signal<'sentence' | 'paragraph'>('sentence');

  // TTS Settings
  readonly ttsEngine = signal<'xtts' | 'orpheus'>('xtts');
  readonly ttsDevice = signal<'cpu' | 'mps' | 'gpu'>('cpu');
  readonly ttsWorkers = signal(2);
  readonly languageVoices: Record<string, PerLanguageTtsConfig> = {};
  readonly assemblyPattern = signal<'interleaved' | 'sequential'>('interleaved');
  pauseDuration = 1.0;

  // Queue state
  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // Model lists
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  ]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ]);

  // Available languages
  readonly availableLanguages: LanguageOption[] = [
    { code: 'en', name: 'English', flagCss: 'linear-gradient(to bottom, #012169 50%, transparent 50%), linear-gradient(to right, #C8102E 33.3%, #FFF 33.3% 66.6%, #C8102E 66.6%)' },
    { code: 'de', name: 'German', flagCss: 'linear-gradient(to bottom, #000 33.3%, #DD0000 33.3% 66.6%, #FFCE00 66.6%)' },
    { code: 'es', name: 'Spanish', flagCss: 'linear-gradient(to bottom, #AA151B 25%, #F1BF00 25% 75%, #AA151B 75%)' },
    { code: 'fr', name: 'French', flagCss: 'linear-gradient(to right, #002395 33.3%, #FFF 33.3% 66.6%, #ED2939 66.6%)' },
    { code: 'it', name: 'Italian', flagCss: 'linear-gradient(to right, #008C45 33.3%, #F4F5F0 33.3% 66.6%, #CD212A 66.6%)' },
    { code: 'pt', name: 'Portuguese', flagCss: 'linear-gradient(to right, #006600 40%, #FF0000 40%)' },
    { code: 'nl', name: 'Dutch', flagCss: 'linear-gradient(to bottom, #AE1C28 33.3%, #FFF 33.3% 66.6%, #21468B 66.6%)' },
    { code: 'pl', name: 'Polish', flagCss: 'linear-gradient(to bottom, #FFF 50%, #DC143C 50%)' },
    { code: 'ru', name: 'Russian', flagCss: 'linear-gradient(to bottom, #FFF 33.3%, #0039A6 33.3% 66.6%, #D52B1E 66.6%)' },
    { code: 'ja', name: 'Japanese', flagCss: 'radial-gradient(circle, #BC002D 25%, #FFF 25%)' },
    { code: 'zh', name: 'Chinese', flagCss: 'radial-gradient(circle at 28% 35%, #FFDE00 8%, #DE2910 8%)' },
    { code: 'ko', name: 'Korean', flagCss: 'radial-gradient(circle at 50% 40%, #CD2E3A 18%, transparent 18%), radial-gradient(circle at 50% 60%, #0047A0 18%, transparent 18%), linear-gradient(#FFF, #FFF)' },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // Computed
  // ─────────────────────────────────────────────────────────────────────────

  readonly epubFilename = computed(() => {
    const path = this.epubPath();
    return path ? path.split('/').pop() || path : '';
  });

  readonly availableModels = computed(() => {
    const provider = this.aiProvider();
    if (provider === 'ollama') return this.ollamaModels();
    if (provider === 'claude') return this.claudeModels();
    if (provider === 'openai') return this.openaiModels();
    return [];
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.loadCache();
    this.checkOllamaConnection();
    this.initializeDefaultVoices();
  }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['audiobookFolder'] && !changes['audiobookFolder'].firstChange) {
      await this.loadCache();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cache Loading
  // ─────────────────────────────────────────────────────────────────────────

  async loadCache(): Promise<void> {
    const folder = this.audiobookFolder();
    if (!folder) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    try {
      const electron = (window as any).electron;
      if (electron?.sentenceCache) {
        const result = await electron.sentenceCache.list(folder);
        if (result.success) {
          this.cachedLanguages.set(result.languages);
        }
      }
    } catch (err) {
      console.error('[BilingualWizard] Error loading cache:', err);
    } finally {
      this.loading.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // API Key Checks
  // ─────────────────────────────────────────────────────────────────────────

  hasClaudeKey(): boolean {
    return !!this.settingsService.getAIConfig().claude?.apiKey;
  }

  hasOpenAIKey(): boolean {
    return !!this.settingsService.getAIConfig().openai?.apiKey;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider & Model
  // ─────────────────────────────────────────────────────────────────────────

  selectProvider(provider: AIProvider): void {
    if (provider === 'claude' && !this.hasClaudeKey()) return;
    if (provider === 'openai' && !this.hasOpenAIKey()) return;

    this.aiProvider.set(provider);

    // Set default model for provider
    const models = this.availableModels();
    if (models.length > 0) {
      this.aiModel.set(models[0].value);
    }
  }

  async checkOllamaConnection(): Promise<void> {
    try {
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      if (response?.ok) {
        const data = await response.json();
        const models = (data.models || []).map((m: { name: string }) => ({
          value: m.name,
          label: m.name
        }));
        this.ollamaModels.set(models);
        if (models.length > 0 && !this.aiModel()) {
          this.aiModel.set(models[0].value);
        }
      }
    } catch {
      // Ollama not available
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Language Selection
  // ─────────────────────────────────────────────────────────────────────────

  setSourceLang(code: string): void {
    if (this.targetLangs().has(code)) return;
    this.sourceLang.set(code);
    this.initializeVoiceForLang(code);
  }

  toggleTargetLang(code: string): void {
    if (code === this.sourceLang()) return;

    const current = new Set(this.targetLangs());
    if (current.has(code)) {
      if (current.size > 1) {
        current.delete(code);
      }
    } else {
      current.add(code);
      this.initializeVoiceForLang(code);
    }
    this.targetLangs.set(current);
  }

  getTargetLangsDisplay(): string {
    return Array.from(this.targetLangs()).map(c => c.toUpperCase()).join(', ');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TTS Settings
  // ─────────────────────────────────────────────────────────────────────────

  selectTtsEngine(engine: 'xtts' | 'orpheus'): void {
    this.ttsEngine.set(engine);
    if (engine === 'orpheus') {
      this.ttsWorkers.set(1);
    }
    // Re-initialize voices for new engine
    this.initializeDefaultVoices();
  }

  initializeDefaultVoices(): void {
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson';

    // Initialize source
    this.initializeVoiceForLang(this.sourceLang(), defaultVoice);

    // Initialize targets
    for (const lang of this.targetLangs()) {
      this.initializeVoiceForLang(lang, defaultVoice);
    }
  }

  initializeVoiceForLang(code: string, voice?: string): void {
    if (!this.languageVoices[code]) {
      const defaultVoice = voice || (this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson');
      this.languageVoices[code] = {
        voice: defaultVoice,
        speed: code === this.sourceLang() ? 1.25 : 1.0
      };
    }
  }

  getVoiceForLang(code: string): string {
    return this.languageVoices[code]?.voice || (this.ttsEngine() === 'orpheus' ? 'tara' : 'ScarlettJohansson');
  }

  setVoiceForLang(code: string, voice: string): void {
    if (!this.languageVoices[code]) {
      this.languageVoices[code] = { voice, speed: 1.0 };
    } else {
      this.languageVoices[code].voice = voice;
    }
  }

  getSpeedForLang(code: string): number {
    return this.languageVoices[code]?.speed || 1.0;
  }

  setSpeedForLang(code: string, speed: number): void {
    if (!this.languageVoices[code]) {
      this.languageVoices[code] = { voice: this.getVoiceForLang(code), speed };
    } else {
      this.languageVoices[code].speed = speed;
    }
  }

  getVoicesForEngine(): { value: string; label: string }[] {
    if (this.ttsEngine() === 'orpheus') {
      return [
        { value: 'tara', label: 'Tara' },
        { value: 'leah', label: 'Leah' },
        { value: 'jess', label: 'Jess' },
        { value: 'leo', label: 'Leo' },
        { value: 'dan', label: 'Dan' },
        { value: 'mia', label: 'Mia' },
        { value: 'zac', label: 'Zac' },
        { value: 'zoe', label: 'Zoe' },
      ];
    }
    return [
      { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
      { value: 'MorganFreeman', label: 'Morgan Freeman' },
      { value: 'DavidAttenborough', label: 'David Attenborough' },
      { value: 'NeilGaiman', label: 'Neil Gaiman' },
      { value: 'RayPorter', label: 'Ray Porter' },
      { value: 'RosamundPike', label: 'Rosamund Pike' },
      { value: 'en_default', label: 'English Default' },
      { value: 'de_default', label: 'German Default' },
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step Navigation
  // ─────────────────────────────────────────────────────────────────────────

  isStepCompleted(step: WizardStep): boolean {
    return this.completedSteps.has(step);
  }

  isStepSkipped(step: WizardStep): boolean {
    return this.skippedSteps.has(step);
  }

  canProceed(): boolean {
    switch (this.currentStep()) {
      case 'source':
        return !!this.epubPath();
      case 'languages':
        return !!this.sourceLang() && this.targetLangs().size > 0;
      case 'processing':
        return !!this.aiModel();
      case 'tts':
        return true;
      default:
        return true;
    }
  }

  goNext(): void {
    const step = this.currentStep();
    if (!this.skippedSteps.has(step)) {
      this.completedSteps.add(step);
    }

    switch (step) {
      case 'source':
        this.currentStep.set('languages');
        break;
      case 'languages':
        this.currentStep.set('processing');
        break;
      case 'processing':
        this.currentStep.set('tts');
        break;
      case 'tts':
        this.currentStep.set('review');
        break;
    }
  }

  goBack(): void {
    switch (this.currentStep()) {
      case 'languages':
        this.currentStep.set('source');
        break;
      case 'processing':
        this.currentStep.set('languages');
        break;
      case 'tts':
        this.currentStep.set('processing');
        break;
      case 'review':
        this.currentStep.set('tts');
        break;
    }
  }

  skipStep(): void {
    const step = this.currentStep();
    this.skippedSteps.add(step);
    this.goNext();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue
  // ─────────────────────────────────────────────────────────────────────────

  async addToQueue(): Promise<void> {
    this.addingToQueue.set(true);

    try {
      const workflowId = `bilingual-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const aiConfig = this.settingsService.getAIConfig();
      const isArticle = this.itemType() === 'article';
      const currentEpubPath = this.originalEpubPath() || this.epubPath();

      // Get external audiobooks directory for TTS jobs
      const externalDir = this.settingsService.get('externalAudiobooksDir') as string | undefined;
      const outputDir = externalDir || this.libraryService.audiobooksPath() || '';

      // Use the directory where the EPUB is located
      const epubPathNorm = currentEpubPath.replace(/\\/g, '/');
      const bookProjectDir = isArticle ? this.projectDir() : epubPathNorm.substring(0, epubPathNorm.lastIndexOf('/'));

      // Master job (container for the workflow)
      const masterJob = await this.queueService.addJob({
        type: 'audiobook',
        epubPath: currentEpubPath,
        projectDir: bookProjectDir,
        metadata: {
          title: `${this.title()} [Bilingual]`,
          author: this.author(),
        },
        config: {
          type: 'audiobook',
        },
        workflowId,
      });

      const masterJobId = masterJob.id;

      // 1. Optional cleanup job
      if (this.enableCleanup() && !this.skippedSteps.has('processing')) {
        await this.queueService.addJob({
          type: 'bilingual-cleanup',
          epubPath: currentEpubPath,
          projectDir: bookProjectDir,
          metadata: { title: 'AI Cleanup' },
          config: {
            type: 'bilingual-cleanup',
            projectId: this.projectId() || workflowId,
            projectDir: bookProjectDir,
            sourceLang: this.sourceLang(),
            aiProvider: this.aiProvider(),
            aiModel: this.aiModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
          },
          workflowId,
          parentJobId: masterJobId,
        });
      }

      // 2. Translation jobs for each target language
      for (const targetLang of this.targetLangs()) {
        const sourceEpubForTranslation = this.enableCleanup() && !this.skippedSteps.has('processing')
          ? `${bookProjectDir}/cleaned.epub`
          : currentEpubPath;

        await this.queueService.addJob({
          type: 'bilingual-translation',
          epubPath: currentEpubPath,
          projectDir: bookProjectDir,
          bfpPath: isArticle ? undefined : this.bfpPath(),
          metadata: {
            title: `Translation (${this.getLanguageName(targetLang)})`,
          },
          config: {
            type: 'bilingual-translation',
            projectId: this.projectId() || workflowId,
            projectDir: bookProjectDir,
            cleanedEpubPath: sourceEpubForTranslation,
            sourceLang: this.sourceLang(),
            targetLang,
            title: this.title(),
            aiProvider: this.aiProvider(),
            aiModel: this.aiModel(),
            ollamaBaseUrl: aiConfig.ollama?.baseUrl,
            claudeApiKey: aiConfig.claude?.apiKey,
            openaiApiKey: aiConfig.openai?.apiKey,
            splitGranularity: this.splitGranularity(),
          } as BilingualTranslationJobConfig,
          workflowId,
          parentJobId: masterJobId,
        });
      }

      // Worker count for TTS
      const workerCount = this.ttsEngine() === 'orpheus' ? 1 : this.ttsWorkers();

      // 3. Source language TTS (placeholder)
      const sourceTtsConfig: Partial<TtsConversionConfig> = {
        type: 'tts-conversion',
        device: this.ttsDevice(),
        language: this.sourceLang(),
        ttsEngine: this.ttsEngine(),
        fineTuned: this.getVoiceForLang(this.sourceLang()),
        temperature: 0.75,
        topP: 0.85,
        topK: 50,
        repetitionPenalty: 5.0,
        speed: this.getSpeedForLang(this.sourceLang()),
        enableTextSplitting: true,
        useParallel: true,
        parallelMode: 'sentences',
        parallelWorkers: workerCount,
        outputDir,
        sentencePerParagraph: true,
        skipHeadings: true,
        skipAssembly: true,
      };

      await this.queueService.addJob({
        type: 'tts-conversion',
        projectDir: bookProjectDir,
        metadata: {
          title: `${this.sourceLang().toUpperCase()} TTS`,
          bilingualPlaceholder: {
            role: 'source',
            projectId: this.projectId() || workflowId,
            targetLang: Array.from(this.targetLangs())[0],
          },
        },
        config: sourceTtsConfig,
        workflowId,
        parentJobId: masterJobId,
      });

      // 4. Target TTS + Assembly jobs for each language
      for (const targetLang of this.targetLangs()) {
        const targetTtsConfig: Partial<TtsConversionConfig> = {
          type: 'tts-conversion',
          device: this.ttsDevice(),
          language: targetLang,
          ttsEngine: this.ttsEngine(),
          fineTuned: this.getVoiceForLang(targetLang),
          temperature: 0.75,
          topP: 0.85,
          topK: 50,
          repetitionPenalty: 5.0,
          speed: this.getSpeedForLang(targetLang),
          enableTextSplitting: true,
          useParallel: true,
          parallelMode: 'sentences',
          parallelWorkers: workerCount,
          outputDir,
          sentencePerParagraph: true,
          skipHeadings: true,
          skipAssembly: true,
        };

        await this.queueService.addJob({
          type: 'tts-conversion',
          projectDir: bookProjectDir,
          metadata: {
            title: `${this.getLanguageName(targetLang)} TTS`,
            bilingualPlaceholder: {
              role: 'target',
              projectId: this.projectId() || workflowId,
              targetLang,
            },
          },
          config: targetTtsConfig,
          workflowId,
          parentJobId: masterJobId,
        });

        // Assembly job
        await this.queueService.addJob({
          type: 'bilingual-assembly',
          projectDir: bookProjectDir,
          bfpPath: isArticle ? undefined : this.bfpPath(),
          metadata: {
            title: `Assembly (${this.sourceLang().toUpperCase()}-${targetLang.toUpperCase()})`,
            bilingualPlaceholder: {
              role: 'assembly',
              projectId: this.projectId() || workflowId,
              targetLang,
            },
          },
          config: {
            type: 'bilingual-assembly',
            projectId: this.projectId() || workflowId,
            targetLang,
            outputDir,
            pauseDuration: this.pauseDuration,
            gapDuration: this.assemblyPattern() === 'interleaved' ? 1.0 : 0.5,
            sourceLang: this.sourceLang(),
            title: this.title(),
            pattern: this.assemblyPattern(),
            bfpPath: isArticle ? undefined : this.bfpPath(),
          } as BilingualAssemblyJobConfig,
          workflowId,
          parentJobId: masterJobId,
        });
      }

      console.log('[BilingualWizard] Jobs added to queue:', {
        workflowId,
        masterJobId,
        sourceLang: this.sourceLang(),
        targetLangs: Array.from(this.targetLangs()),
        cleanup: this.enableCleanup(),
      });

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[BilingualWizard] Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  getLanguageName(code: string): string {
    const lang = this.availableLanguages.find(l => l.code === code);
    return lang?.name || code.toUpperCase();
  }
}

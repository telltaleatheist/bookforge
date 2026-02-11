import { Component, inject, signal, computed, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem
} from '../../creamsicle-desktop';
import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { QueueService } from '../queue/services/queue.service';
import { SettingsService } from '../../core/services/settings.service';
import {
  LanguageLearningProject,
  WorkflowState,
  SUPPORTED_LANGUAGES,
  FetchUrlResult,
  EditAction,
  ProjectAnalytics
} from './models/language-learning.types';
import { UrlInputComponent } from './components/url-input/url-input.component';
import { ArticlePreviewComponent } from './components/article-preview/article-preview.component';
import { LanguageSelectorComponent } from './components/language-selector/language-selector.component';
import { BilingualPlayerComponent } from './components/bilingual-player/bilingual-player.component';
import { LLWizardComponent } from './components/ll-wizard/ll-wizard.component';

@Component({
  selector: 'app-language-learning',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    UrlInputComponent,
    ArticlePreviewComponent,
    LanguageSelectorComponent,
    BilingualPlayerComponent,
    LLWizardComponent
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="language-learning-container">
      <desktop-split-pane [primarySize]="280" [minSize]="200" [maxSize]="500">
        <!-- Left Panel: Projects List -->
        <div pane-primary class="projects-panel">
          <div class="panel-header">
            <h3>Language Projects</h3>
            <button class="btn-icon" (click)="startNewProject()" title="New Project">
              +
            </button>
          </div>
          <div class="projects-list">
            @for (project of projects(); track project.id) {
              <div
                class="project-item"
                [class.selected]="selectedProjectId() === project.id"
                (click)="selectProject(project.id)"
                (contextmenu)="showProjectContextMenu($event, project)"
              >
                <div class="project-content">
                  <div class="project-title">{{ project.title || 'Untitled' }}</div>
                  <div class="project-meta">
                    <span class="status-badge" [class]="project.status">
                      {{ project.status }}
                    </span>
                    <span class="lang-badge">{{ project.targetLang | uppercase }}</span>
                  </div>
                </div>
                <button
                  class="btn-delete"
                  (click)="confirmDeleteProject(project, $event)"
                  title="Delete project"
                >
                  ✕
                </button>
              </div>
            } @empty {
              <div class="empty-state">
                <p>No projects yet</p>
                <button class="btn-primary" (click)="startNewProject()">
                  Create New Project
                </button>
              </div>
            }
          </div>

          <!-- Context Menu -->
          @if (contextMenuVisible()) {
            <div
              class="context-menu"
              [style.top.px]="contextMenuY()"
              [style.left.px]="contextMenuX()"
            >
              <button class="context-menu-item" (click)="showAnalytics()">
                Analytics
              </button>
              <div class="context-menu-divider"></div>
              <button class="context-menu-item" (click)="startOverProject()">
                Start Over
              </button>
              <button class="context-menu-item danger" (click)="deleteContextMenuProject()">
                Delete
              </button>
            </div>
          }
        </div>

        <!-- Right Panel: Workflow -->
        <div pane-secondary class="workflow-panel">
          <!-- Step Indicator (shown when project is selected and editable) -->
          @if (selectedProject() && (workflowState() === 'select' || workflowState() === 'settings')) {
            <div class="step-indicator">
              <button
                class="step-btn"
                [class.active]="workflowState() === 'select'"
                [class.completed]="workflowState() === 'settings'"
                (click)="setWorkflowState('select')"
              >
                <span class="step-num">1</span>
                <span class="step-label">Edit Content</span>
              </button>
              <div class="step-connector" [class.active]="workflowState() === 'settings'"></div>
              <button
                class="step-btn"
                [class.active]="workflowState() === 'settings'"
                (click)="workflowState() === 'settings' ? null : null"
                [disabled]="workflowState() !== 'settings'"
              >
                <span class="step-num">2</span>
                <span class="step-label">Settings</span>
              </button>
              <div class="step-connector"></div>
              <div class="step-btn" [class.disabled]="true">
                <span class="step-num">3</span>
                <span class="step-label">Convert</span>
              </div>
            </div>
          }

          @if (workflowState() === 'projects' && !selectedProject()) {
            <!-- Welcome state -->
            <div class="welcome-state">
              <h2>Language Learning Pipeline</h2>
              <p>Convert web articles into bilingual audiobooks for language learning.</p>
              <div class="steps">
                <div class="step">
                  <span class="step-number">1</span>
                  <span class="step-text">Paste article URL</span>
                </div>
                <div class="step">
                  <span class="step-number">2</span>
                  <span class="step-text">Remove ads and unwanted content</span>
                </div>
                <div class="step">
                  <span class="step-number">3</span>
                  <span class="step-text">Select target language</span>
                </div>
                <div class="step">
                  <span class="step-number">4</span>
                  <span class="step-text">Generate bilingual audiobook</span>
                </div>
              </div>
              <button class="btn-primary btn-large" (click)="startNewProject()">
                Start New Project
              </button>
            </div>
          }

          @if (workflowState() === 'fetch') {
            <!-- URL Input Component -->
            <app-url-input
              #urlInputComponent
              (fetch)="onFetchUrl($event)"
            />
          }

          @if (workflowState() === 'select' && selectedProject()) {
            <!-- Block Selection with Article Preview -->
            <div class="select-panel-wrapper">
              <app-article-preview
                [htmlPath]="selectedProject()!.htmlPath"
                [title]="selectedProject()!.title"
                [byline]="selectedProject()!.byline || ''"
                [initialDeletedSelectors]="selectedProject()!.deletedSelectors"
                [initialUndoStack]="selectedProject()!.undoStack || []"
                [initialRedoStack]="selectedProject()!.redoStack || []"
                (deletedSelectorsChange)="onDeletedSelectorsChange($event)"
                (undoStackChange)="onUndoStackChange($event)"
                (redoStackChange)="onRedoStackChange($event)"
                (projectChanged)="onProjectChanged()"
              />
              <div class="action-bar">
                <button class="btn-secondary" (click)="setWorkflowState('fetch')">
                  Back
                </button>
                <button class="btn-primary" (click)="saveAndContinue()">
                  Continue to Settings
                </button>
              </div>
            </div>
          }

          @if (workflowState() === 'settings' && selectedProject()) {
            <!-- Conversion Settings -->
            <div class="settings-panel-scroll">
              <div class="settings-panel-content">
                <h2>Conversion Settings</h2>

                <!-- Language Selection -->
                <div class="settings-section">
                  <h3>Target Language</h3>
                  <app-language-selector
                    [value]="selectedProject()!.targetLang"
                    (valueChange)="onTargetLangChange($event)"
                  />
                </div>

                <!-- AI Provider Section -->
                <div class="settings-section">
                  <h3>AI Translation</h3>
                  <p class="settings-note">Select the AI provider for translation.</p>

                  <div class="provider-buttons">
                    <button
                      class="provider-btn"
                      [class.selected]="selectedProvider() === 'ollama'"
                      (click)="selectProvider('ollama')"
                    >
                      <span class="provider-icon">🦙</span>
                      <span class="provider-name">Ollama</span>
                      <span class="provider-desc">Local, free</span>
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="selectedProvider() === 'claude'"
                      (click)="selectProvider('claude')"
                    >
                      <span class="provider-icon">🧠</span>
                      <span class="provider-name">Claude</span>
                      <span class="provider-desc">Best quality</span>
                    </button>
                    <button
                      class="provider-btn"
                      [class.selected]="selectedProvider() === 'openai'"
                      (click)="selectProvider('openai')"
                    >
                      <span class="provider-icon">🤖</span>
                      <span class="provider-name">OpenAI</span>
                      <span class="provider-desc">GPT models</span>
                    </button>
                  </div>

                  <div class="form-group">
                    <label>Model</label>
                    <select class="select-input" [value]="selectedModel()" (change)="onModelChange($event)">
                      @for (model of availableModels(); track model.value) {
                        <option [value]="model.value">{{ model.label }}</option>
                      }
                    </select>
                  </div>
                </div>

                <!-- Segment Size Section -->
                <div class="settings-section">
                  <h3>Segment Size</h3>
                  <p class="settings-note">How to split text for alternating audio. Sentences are best for learning.</p>

                  <div class="granularity-buttons">
                    <button
                      class="granularity-btn"
                      [class.selected]="splitGranularity() === 'sentence'"
                      (click)="selectSplitGranularity('sentence')"
                    >
                      <span class="granularity-name">Sentences</span>
                      <span class="granularity-desc">Recommended</span>
                    </button>
                    <button
                      class="granularity-btn"
                      [class.selected]="splitGranularity() === 'paragraph'"
                      (click)="selectSplitGranularity('paragraph')"
                    >
                      <span class="granularity-name">Paragraphs</span>
                      <span class="granularity-desc">Longer segments</span>
                    </button>
                  </div>
                </div>

                <!-- AI Prompts Section -->
                <div class="settings-section">
                  <h3>AI Processing</h3>

                  <!-- Translation Prompt -->
                  <div class="form-group">
                    <label>Translation</label>
                    <div class="prompt-toggle-row">
                      <button
                        class="prompt-toggle-btn selected"
                      >
                        <div class="toggle-text">
                          <span class="toggle-name">Translation Prompt</span>
                          <span class="toggle-desc">Batched sentence translation with context</span>
                        </div>
                      </button>
                      <button
                        class="expand-btn"
                        [class.expanded]="translationAccordionOpen()"
                        (click)="toggleTranslationAccordion()"
                        title="Edit translation prompt"
                      >
                        <span class="expand-icon">{{ translationAccordionOpen() ? '▼' : '▶' }}</span>
                      </button>
                    </div>
                    @if (translationAccordionOpen()) {
                      <div class="prompt-content">
                        <p class="prompt-hint">Variables: {{ '{' }}sourceLang{{ '}' }}, {{ '{' }}targetLang{{ '}' }}, {{ '{' }}count{{ '}' }}, {{ '{' }}sentences{{ '}' }}, {{ '{' }}context{{ '}' }}</p>
                        <textarea
                          class="prompt-textarea"
                          [value]="translationPrompt()"
                          (input)="onTranslationPromptChange($event)"
                          rows="8"
                        ></textarea>
                      </div>
                    }
                  </div>

                  <!-- Source Cleanup -->
                  <div class="form-group">
                    <label>Source Cleanup</label>
                    <div class="prompt-toggle-row">
                      <button
                        class="prompt-toggle-btn"
                        [class.selected]="enableCleanup()"
                        (click)="toggleCleanupEnabled()"
                      >
                        <div class="toggle-text">
                          <span class="toggle-name">Source Cleanup</span>
                          <span class="toggle-desc">{{ enableCleanup() ? 'Clean text before translation' : 'Click to enable' }}</span>
                        </div>
                      </button>
                      <button
                        class="expand-btn"
                        [class.expanded]="cleanupAccordionOpen()"
                        (click)="toggleCleanupAccordion()"
                        title="Edit cleanup prompt"
                      >
                        <span class="expand-icon">{{ cleanupAccordionOpen() ? '▼' : '▶' }}</span>
                      </button>
                    </div>
                    @if (cleanupAccordionOpen()) {
                      <div class="prompt-content">
                        <p class="prompt-hint">Cleans OCR artifacts, formatting, abbreviations. Runs before sentence splitting.</p>
                        <textarea
                          class="prompt-textarea"
                          [value]="cleanupPrompt()"
                          (input)="onCleanupPromptChange($event)"
                          rows="10"
                        ></textarea>
                      </div>
                    }
                  </div>
                </div>

                <!-- TTS Engine Section -->
                <div class="settings-section">
                  <h3>Text-to-Speech</h3>

                  <div class="form-group">
                    <label>TTS Engine</label>
                    <div class="engine-buttons">
                      <button
                        class="engine-btn"
                        [class.selected]="selectedEngine() === 'xtts'"
                        (click)="selectEngine('xtts')"
                      >
                        <span class="engine-name">XTTS</span>
                        <span class="engine-desc">Faster, multi-worker</span>
                      </button>
                      <button
                        class="engine-btn"
                        [class.selected]="selectedEngine() === 'orpheus'"
                        (click)="selectEngine('orpheus')"
                      >
                        <span class="engine-name">Orpheus</span>
                        <span class="engine-desc">Best quality</span>
                      </button>
                    </div>
                  </div>

                  <div class="form-group">
                    <label>Voice</label>
                    <select class="select-input" [value]="selectedVoice" (change)="onVoiceChange($event)">
                      @if (selectedEngine() === 'orpheus') {
                        <option value="tara">Tara (natural, default)</option>
                        <option value="leah">Leah</option>
                        <option value="jess">Jess</option>
                        <option value="leo">Leo</option>
                        <option value="dan">Dan</option>
                        <option value="mia">Mia</option>
                        <option value="zac">Zac</option>
                        <option value="zoe">Zoe</option>
                      } @else {
                        <option value="ScarlettJohansson">Scarlett Johansson</option>
                      }
                    </select>
                  </div>

                  <!-- TTS Speed Settings -->
                  <div class="form-group">
                    <label>TTS Speed - {{ getLanguageName(selectedProject()?.sourceLang || 'en') }}</label>
                    <div class="speed-slider-container">
                      <input
                        type="range"
                        class="speed-slider"
                        min="0.5"
                        max="2.0"
                        step="0.05"
                        [value]="sourceTtsSpeed()"
                        (input)="setSourceTtsSpeed($event)"
                      />
                      <span class="speed-value">{{ sourceTtsSpeed().toFixed(2) }}x</span>
                    </div>
                  </div>

                  <div class="form-group">
                    <label>TTS Speed - {{ getLanguageName(selectedProject()?.targetLang || 'de') }}</label>
                    <div class="speed-slider-container">
                      <input
                        type="range"
                        class="speed-slider"
                        min="0.5"
                        max="2.0"
                        step="0.05"
                        [value]="targetTtsSpeed()"
                        (input)="setTargetTtsSpeed($event)"
                      />
                      <span class="speed-value">{{ targetTtsSpeed().toFixed(2) }}x</span>
                    </div>
                    <p class="settings-note">Slow down target language for easier comprehension</p>
                  </div>

                  <div class="form-group">
                    <label>Processing Device</label>
                    <div class="device-buttons">
                      <button
                        class="device-btn"
                        [class.selected]="selectedDevice() === 'mps'"
                        (click)="selectDevice('mps')"
                      >
                        MPS (Mac)
                      </button>
                      <button
                        class="device-btn"
                        [class.selected]="selectedDevice() === 'gpu'"
                        (click)="selectDevice('gpu')"
                      >
                        GPU (CUDA)
                      </button>
                      <button
                        class="device-btn"
                        [class.selected]="selectedDevice() === 'cpu'"
                        (click)="selectDevice('cpu')"
                      >
                        CPU
                      </button>
                    </div>
                  </div>

                  @if (selectedEngine() === 'xtts') {
                    <div class="form-group">
                      <label>Parallel Workers</label>
                      <p class="settings-note">More workers = faster, but uses more memory.</p>
                      <div class="worker-buttons">
                        @for (count of [1, 2, 3, 4]; track count) {
                          <button
                            class="worker-btn"
                            [class.selected]="selectedWorkers() === count"
                            (click)="selectWorkers(count)"
                          >
                            {{ count }}
                          </button>
                        }
                      </div>
                    </div>
                  } @else {
                    <p class="settings-note orpheus-note">
                      Orpheus uses 1 worker (multi-worker not beneficial).
                    </p>
                  }
                </div>

                <!-- Alignment Settings Section -->
                <div class="settings-section">
                  <h3>Alignment Verification</h3>
                  <div class="checkbox-group">
                    <label class="checkbox-label">
                      <input
                        type="checkbox"
                        [checked]="autoApproveAlignment()"
                        (change)="toggleAutoApproveAlignment()"
                      />
                      <span class="checkbox-text">
                        Auto-approve when aligned
                        <span class="checkbox-hint">Skip preview window if source/target sentence counts match</span>
                      </span>
                    </label>
                  </div>
                </div>

                <!-- Test Mode Section -->
                <div class="settings-section">
                  <h3>Test Mode</h3>
                  <button
                    class="option-toggle"
                    [class.active]="testMode()"
                    (click)="testMode.set(!testMode())"
                  >
                    <span class="toggle-icon">🧪</span>
                    <span class="toggle-label">Test mode</span>
                    <span class="toggle-sublabel">First {{ testModeChunks() }} sentences only</span>
                  </button>
                  @if (testMode()) {
                    <div class="test-mode-config">
                      <label>Sentences to process:</label>
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
                  <p class="settings-hint">
                    Process only a few sentences to test translation and voice quality.
                  </p>
                </div>

                <div class="action-bar settings-actions">
                  <button class="btn-secondary" (click)="setWorkflowState('select')">
                    Back
                  </button>
                  <button class="btn-primary" (click)="startProcessing()">
                    @if (testMode()) {
                      Add Test Job ({{ testModeChunks() }} sentences)
                    } @else {
                      Add to Queue
                    }
                  </button>
                </div>
              </div>
            </div>
          }

          @if (workflowState() === 'player') {
            <!-- Player View - shows directly when project has audio -->
            <div class="player-view">
              <div class="player-header-bar">
                <button class="btn-secondary btn-small" (click)="editAndRegenerate()">
                  Edit & Re-generate
                </button>
              </div>
              <div class="player-container-full">
                <app-bilingual-player
                  [audiobook]="playerAudiobook()"
                />
              </div>
            </div>
          }

          @if (workflowState() === 'wizard') {
            <!-- LL Wizard - 4-step pipeline -->
            <app-ll-wizard
              [projectId]="selectedProject()!.id"
              [projectDir]="getProjectDir(selectedProject()!.id)"
              [projectTitle]="selectedProject()!.title"
              [initialSourceLang]="selectedProject()!.sourceLang"
              (queued)="onWizardQueued()"
              (back)="workflowState.set('select')"
            />
          }
        </div>
      </desktop-split-pane>
    </div>

    <!-- Analytics Modal -->
    @if (analyticsVisible()) {
      <div class="modal-overlay" (click)="hideAnalytics()">
        <div class="analytics-modal" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h2>Analytics</h2>
            <button class="btn-close" (click)="hideAnalytics()">✕</button>
          </div>

          @if (analyticsLoading()) {
            <div class="modal-loading">
              <div class="spinner"></div>
              <span>Loading analytics...</span>
            </div>
          } @else if (analyticsData()) {
            <div class="modal-content">
              <div class="analytics-summary">
                <h3>{{ analyticsData()!.projectTitle }}</h3>
                <div class="summary-stats">
                  <div class="stat">
                    <span class="stat-label">Status</span>
                    <span class="stat-value status-badge" [class]="analyticsData()!.status">
                      {{ analyticsData()!.status }}
                    </span>
                  </div>
                  <div class="stat">
                    <span class="stat-label">Total Time</span>
                    <span class="stat-value">{{ formatDuration(analyticsData()!.totalDurationMs) }}</span>
                  </div>
                  @if (analyticsData()!.summary?.totalSentences) {
                    <div class="stat">
                      <span class="stat-label">Sentences</span>
                      <span class="stat-value">{{ analyticsData()!.summary!.totalSentences }}</span>
                    </div>
                  }
                </div>
              </div>

              <div class="analytics-stages">
                <h4>Processing Stages</h4>
                @if (analyticsData()!.stages.length === 0) {
                  <div class="empty-stages">
                    <p>No processing data yet.</p>
                    <p class="hint">Analytics will be recorded when you process this project.</p>
                  </div>
                } @else {
                  <div class="stages-list">
                    @for (stage of analyticsData()!.stages; track stage.name) {
                      <div class="stage-row" [class]="stage.status">
                        <div class="stage-icon">
                          @switch (stage.status) {
                            @case ('completed') { ✓ }
                            @case ('running') { ⟳ }
                            @case ('error') { ✕ }
                            @case ('skipped') { ○ }
                            @default { ○ }
                          }
                        </div>
                        <div class="stage-info">
                          <span class="stage-name">{{ stage.name }}</span>
                          @if (stage.error) {
                            <span class="stage-error">{{ stage.error }}</span>
                          }
                        </div>
                        <div class="stage-duration">
                          {{ formatDuration(stage.durationMs) }}
                        </div>
                        @if (stage.metrics) {
                          <div class="stage-metrics">
                            @if (stage.metrics.sentenceCount) {
                              <span class="metric">{{ stage.metrics.sentenceCount }} sentences</span>
                            }
                            @if (stage.metrics.batchCount) {
                              <span class="metric">{{ stage.metrics.batchCount }} batches</span>
                            }
                            @if (stage.metrics.workerCount) {
                              <span class="metric">{{ stage.metrics.workerCount }} workers</span>
                            }
                          </div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          } @else {
            <div class="modal-empty">
              <p>No analytics available for this project.</p>
            </div>
          }

          <div class="modal-footer">
            <button class="btn-secondary" (click)="hideAnalytics()">Close</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    .language-learning-container {
      flex: 1;
      overflow: hidden;
    }

    .projects-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-icon {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 16px;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .projects-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .project-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 4px;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);

        .btn-delete {
          opacity: 1;
        }
      }

      &.selected {
        background: var(--bg-selected);
      }
    }

    .project-content {
      flex: 1;
      min-width: 0;
    }

    .btn-delete {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      opacity: 0;
      transition: all 0.15s;

      &:hover {
        background: var(--color-error-bg);
        color: var(--color-error);
      }
    }

    .project-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-meta {
      display: flex;
      gap: 8px;
      font-size: 12px;
    }

    .status-badge {
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-muted);
      color: var(--text-secondary);

      &.fetched { background: var(--color-info-bg); color: var(--color-info); }
      &.selected { background: var(--color-warning-bg); color: var(--color-warning); }
      &.processing { background: var(--color-primary-bg); color: var(--color-primary); }
      &.completed { background: var(--color-success-bg); color: var(--color-success); }
      &.error { background: var(--color-error-bg); color: var(--color-error); }
    }

    .lang-badge {
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-weight: 500;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
      color: var(--text-secondary);

      p {
        margin-bottom: 16px;
      }
    }

    .workflow-panel {
      height: 100%;
      overflow-y: auto;
      background: var(--bg-base);
      display: flex;
      flex-direction: column;
    }

    .step-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px 24px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      gap: 8px;
      flex-shrink: 0;
    }

    .step-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-base);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover:not(:disabled):not(.disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: color-mix(in srgb, #06b6d4 15%, transparent);
        border-color: #06b6d4;
        color: #06b6d4;

        .step-num {
          background: #06b6d4;
          color: white;
        }
      }

      &.completed {
        color: var(--text-primary);

        .step-num {
          background: var(--color-success);
          color: white;
        }
      }

      &:disabled, &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
    }

    .step-label {
      font-size: 13px;
      font-weight: 500;
    }

    .step-connector {
      width: 24px;
      height: 2px;
      background: var(--border-default);

      &.active {
        background: #06b6d4;
      }
    }

    .welcome-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 40px;
      text-align: center;

      h2 {
        margin: 0 0 12px;
        font-size: 28px;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 32px;
        color: var(--text-secondary);
        max-width: 400px;
      }
    }

    .steps {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 32px;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 12px;
      text-align: left;
    }

    .step-number {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--color-primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
    }

    .step-text {
      color: var(--text-primary);
    }

    .btn-primary {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      background: var(--color-primary);
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.btn-large {
        padding: 14px 28px;
        font-size: 16px;
      }
    }

    .btn-secondary {
      padding: 10px 20px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .select-panel-wrapper {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;

      app-article-preview {
        flex: 1;
        overflow: hidden;
        min-height: 0;
      }

      .action-bar {
        flex-shrink: 0;
        padding: 16px 24px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        display: flex;
        justify-content: space-between;
      }
    }

    .fetch-panel, .settings-panel, .processing-panel, .completed-panel {
      flex: 1;
      padding: 24px;
      max-width: 600px;
      margin: 0 auto;
      overflow-y: auto;

      h2 {
        margin: 0 0 8px;
        font-size: 24px;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 24px;
        color: var(--text-secondary);
      }
    }

    .url-input-container {
      display: flex;
      gap: 12px;
    }

    .url-input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;

      &:focus {
        outline: none;
        border-color: var(--color-primary);
      }
    }

    .error-message {
      margin-top: 12px;
      padding: 12px;
      border-radius: 6px;
      background: var(--color-error-bg);
      color: var(--color-error);
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .pdf-viewer-placeholder {
      height: 400px;
      border: 2px dashed var(--border-default);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      margin-bottom: 24px;

      .path-info {
        font-size: 12px;
        font-family: monospace;
        margin-top: 8px;
      }
    }

    .action-bar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .settings-section {
      margin-bottom: 24px;

      h3 {
        margin: 0 0 12px;
        font-size: 16px;
        color: var(--text-primary);
      }

      .settings-note {
        font-size: 13px;
        margin-bottom: 12px;
      }

      .settings-hint {
        font-size: 12px;
        color: var(--text-tertiary);
        margin-top: 8px;
      }
    }

    .option-toggle {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 16px;
      background: var(--bg-subtle);
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
        background: color-mix(in srgb, #06b6d4 10%, var(--bg-subtle));

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
      background: var(--bg-subtle);
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
      background: var(--bg-elevated);
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
        background: color-mix(in srgb, #06b6d4 15%, var(--bg-elevated));
        color: #06b6d4;
      }
    }

    .accordion {
      margin-bottom: 12px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      overflow: hidden;
    }

    .accordion-header {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-subtle);
      border: none;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .accordion-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .accordion-icon {
      font-size: 10px;
      color: var(--text-tertiary);
    }

    .prompt-toggle-row {
      display: flex;
      gap: 8px;
    }

    .prompt-toggle-btn {
      flex: 1;
      display: flex;
      align-items: center;
      padding: 14px 16px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-surface);
      cursor: pointer;
      transition: all 0.15s;
      text-align: left;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 10%, var(--bg-surface));

        .toggle-name, .toggle-desc {
          color: #06b6d4;
        }
      }

      .toggle-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .toggle-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .toggle-desc {
        font-size: 12px;
        color: var(--text-tertiary);
      }
    }

    .expand-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      padding: 12px 8px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-surface);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      &.expanded {
        background: var(--bg-hover);
      }

      .expand-icon {
        font-size: 10px;
        color: var(--text-tertiary);
      }
    }

    .prompt-content {
      margin-top: 12px;
      padding: 16px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 8px;
    }

    .accordion-content {
      padding: 16px;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
    }

    .prompt-hint {
      font-size: 12px;
      color: var(--text-tertiary);
      margin: 0 0 8px;
    }

    .prompt-textarea {
      width: 100%;
      padding: 12px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-subtle);
      color: var(--text-primary);
      font-family: 'SF Mono', 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
      min-height: 100px;

      &:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .select-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;

      &:focus {
        outline: none;
        border-color: var(--color-primary);
      }
    }

    .settings-panel-scroll {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }

    .settings-panel-content {
      padding: 24px;
      max-width: 600px;
      margin: 0 auto;

      h2 {
        margin: 0 0 24px;
        font-size: 24px;
        color: var(--text-primary);
      }
    }

    .settings-actions {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--border-subtle);
    }

    .form-group {
      margin-bottom: 16px;

      label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
    }

    .speed-slider-container {
      display: flex;
      align-items: center;
      gap: 12px;

      .speed-slider {
        flex: 1;
        height: 20px;
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
        cursor: pointer;

        &::-webkit-slider-runnable-track {
          height: 4px;
          background: var(--bg-muted, #444);
          border-radius: 2px;
        }

        &::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--color-primary, #06b6d4);
          cursor: pointer;
          margin-top: -6px;
          transition: transform 0.1s;

          &:hover {
            transform: scale(1.2);
          }
        }

        &::-moz-range-track {
          height: 4px;
          background: var(--bg-muted, #444);
          border-radius: 2px;
        }

        &::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border: none;
          border-radius: 50%;
          background: var(--color-primary, #06b6d4);
          cursor: pointer;
        }
      }

      .speed-value {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-secondary);
        min-width: 48px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    }

    .provider-buttons, .engine-buttons, .granularity-buttons {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .provider-btn, .engine-btn, .granularity-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 16px 12px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-surface);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 10%, var(--bg-surface));

        .provider-name, .provider-desc, .provider-icon,
        .engine-name, .engine-desc,
        .granularity-name, .granularity-desc {
          color: #06b6d4;
        }
      }
    }

    .provider-icon {
      font-size: 24px;
    }

    .provider-name, .engine-name, .granularity-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .provider-desc, .engine-desc, .granularity-desc {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .device-buttons, .worker-buttons {
      display: flex;
      gap: 8px;
    }

    .device-btn, .worker-btn {
      flex: 1;
      padding: 10px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.selected {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 15%, var(--bg-surface));
        color: #06b6d4;
      }
    }

    .worker-btn {
      flex: 0;
      min-width: 48px;
    }

    .orpheus-note {
      font-style: italic;
      color: var(--text-muted);
      margin-top: 8px;
    }

    .checkbox-group {
      padding: 8px 0;
    }

    .checkbox-label {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      cursor: pointer;

      input[type="checkbox"] {
        width: 18px;
        height: 18px;
        margin-top: 2px;
        cursor: pointer;
        accent-color: #06b6d4;
      }
    }

    .checkbox-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 14px;
      color: var(--text-primary);
    }

    .checkbox-hint {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .progress-stages {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .stage {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border-radius: 6px;
      background: var(--bg-surface);
      opacity: 0.5;

      &.active {
        opacity: 1;
        background: var(--color-primary-bg);
      }

      &.done {
        opacity: 1;
      }
    }

    .stage-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--bg-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
    }

    .stage.active .stage-icon {
      background: var(--color-primary);
      color: white;
    }

    .progress-bar-container {
      height: 8px;
      background: var(--bg-muted);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .progress-bar {
      height: 100%;
      background: var(--color-primary);
      transition: width 0.3s;
    }

    .progress-message {
      text-align: center;
      color: var(--text-secondary);
    }

    .processing-info {
      text-align: center;
      color: var(--text-secondary);
      margin-bottom: 32px;
    }

    .processing-actions {
      justify-content: center;
      gap: 16px;
      border-top: none;
      background: transparent;
    }

    .completed-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .audiobook-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      border-radius: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
    }

    .audiobook-title {
      font-weight: 500;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .audiobook-meta {
      display: flex;
      gap: 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .audiobook-actions {
      display: flex;
      gap: 8px;
    }

    .player-view {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .player-header-bar {
      display: flex;
      justify-content: flex-end;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 12px;
    }

    .player-container-full {
      flex: 1;
      min-height: 0;
      background: var(--bg-base);
    }

    /* Context Menu */
    .context-menu {
      position: fixed;
      z-index: 1000;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      padding: 4px 0;
      min-width: 160px;
    }

    .context-menu-item {
      display: block;
      width: 100%;
      padding: 8px 16px;
      text-align: left;
      background: none;
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
    }

    .context-menu-item:hover {
      background: var(--bg-hover);
    }

    .context-menu-item.danger {
      color: var(--status-error);
    }

    .context-menu-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 4px 0;
    }

    /* Analytics Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1001;
    }

    .analytics-modal {
      background: var(--bg-surface);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      min-width: 500px;
      max-width: 700px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: 18px;
        color: var(--text-primary);
      }
    }

    .btn-close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 16px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .modal-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
    }

    .modal-loading, .modal-empty {
      padding: 40px 20px;
      text-align: center;
      color: var(--text-secondary);

      .spinner {
        margin-bottom: 12px;
      }
    }

    .modal-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      justify-content: flex-end;
    }

    .analytics-summary {
      margin-bottom: 24px;

      h3 {
        margin: 0 0 16px;
        font-size: 16px;
        color: var(--text-primary);
      }
    }

    .summary-stats {
      display: flex;
      gap: 24px;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-label {
      font-size: 12px;
      color: var(--text-secondary);
      text-transform: uppercase;
    }

    .stat-value {
      font-size: 16px;
      font-weight: 500;
      color: var(--text-primary);

      &.status-badge {
        font-size: 13px;
        padding: 2px 8px;
        border-radius: 4px;
        display: inline-block;

        &.running { background: var(--color-info-bg); color: var(--color-info); }
        &.completed { background: var(--color-success-bg); color: var(--color-success); }
        &.error { background: var(--color-error-bg); color: var(--color-error); }
      }
    }

    .analytics-stages {
      h4 {
        margin: 0 0 12px;
        font-size: 14px;
        color: var(--text-secondary);
      }
    }

    .empty-stages {
      padding: 24px;
      text-align: center;
      background: var(--bg-subtle);
      border-radius: 8px;

      p {
        margin: 0;
        color: var(--text-secondary);
      }

      .hint {
        font-size: 12px;
        margin-top: 8px;
        color: var(--text-muted);
      }
    }

    .stages-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .stage-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-subtle);
      border-radius: 8px;
      border-left: 3px solid var(--border-default);

      &.completed {
        border-left-color: var(--color-success);
      }

      &.running {
        border-left-color: var(--color-info);
      }

      &.error {
        border-left-color: var(--color-error);
      }

      &.skipped {
        opacity: 0.6;
      }
    }

    .stage-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--bg-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;

      .stage-row.completed & {
        background: var(--color-success);
        color: white;
      }

      .stage-row.running & {
        background: var(--color-info);
        color: white;
        animation: spin 1s linear infinite;
      }

      .stage-row.error & {
        background: var(--color-error);
        color: white;
      }
    }

    .stage-info {
      flex: 1;
      min-width: 0;
    }

    .stage-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      text-transform: capitalize;
    }

    .stage-error {
      display: block;
      font-size: 12px;
      color: var(--color-error);
      margin-top: 2px;
    }

    .stage-duration {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      font-family: 'SF Mono', monospace;
    }

    .stage-metrics {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .metric {
      padding: 2px 6px;
      background: var(--bg-muted);
      border-radius: 4px;
    }
  `]
})
export class LanguageLearningComponent implements OnInit, OnDestroy {
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly settingsService = inject(SettingsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // State signals
  readonly projects = signal<LanguageLearningProject[]>([]);
  readonly selectedProjectId = signal<string | null>(null);
  readonly workflowState = signal<WorkflowState>('projects');
  readonly urlInput = signal<string>('');
  readonly isFetching = signal<boolean>(false);
  readonly fetchError = signal<string | null>(null);
  readonly completedAudiobooks = signal<any[]>([]);

  // Context menu state
  readonly contextMenuVisible = signal<boolean>(false);
  readonly contextMenuX = signal<number>(0);
  readonly contextMenuY = signal<number>(0);
  readonly contextMenuProject = signal<LanguageLearningProject | null>(null);

  // Analytics dialog state
  readonly analyticsVisible = signal<boolean>(false);
  readonly analyticsData = signal<ProjectAnalytics | null>(null);
  readonly analyticsLoading = signal<boolean>(false);

  // Processing state
  readonly processingStage = signal<string>('extract');
  readonly processingProgress = signal<number>(0);
  readonly processingMessage = signal<string>('');

  // Player state - computed from selected project
  readonly playerAudiobook = computed(() => {
    const project = this.selectedProject();
    if (!project) return null;
    return {
      id: project.id,
      title: project.title,
      sourceLang: project.sourceLang,
      targetLang: project.targetLang
    };
  });

  // Legacy - keep for backwards compatibility
  readonly selectedAudiobook = signal<any | null>(null);

  // Settings
  selectedVoice = 'ScarlettJohansson'; // XTTS default voice (matches default engine)
  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  // AI Settings
  readonly selectedProvider = signal<'ollama' | 'claude' | 'openai'>('ollama');
  readonly selectedModel = signal<string>('');
  readonly availableModels = signal<{ value: string; label: string }[]>([]);
  readonly loadingModels = signal(false);
  readonly ollamaConnected = signal(false);

  // TTS Settings
  readonly selectedEngine = signal<'xtts' | 'orpheus'>('xtts');
  readonly selectedDevice = signal<'mps' | 'gpu' | 'cpu'>('cpu');  // CPU is better for XTTS on Mac
  readonly selectedWorkers = signal<number>(4);
  readonly sourceTtsSpeed = signal<number>(1.0);
  readonly targetTtsSpeed = signal<number>(0.75);

  // Alignment Settings
  readonly autoApproveAlignment = signal<boolean>(true); // Skip preview if counts match

  // Test Mode Settings (only process first X sentences)
  readonly testMode = signal<boolean>(false);
  readonly testModeChunks = signal<number>(5);

  // Sentence Splitting Settings
  readonly splitGranularity = signal<'sentence' | 'paragraph'>('sentence');

  // AI Prompts (accordion state and content)
  readonly translationAccordionOpen = signal(false);
  readonly cleanupAccordionOpen = signal(false);
  readonly enableCleanup = signal(true); // ON by default
  readonly translationPrompt = signal(`Translate each sentence from {sourceLang} to {targetLang}.
Return exactly {count} translations, one per line, in the same order.
Do NOT include numbers, explanations, or original text - only the translations.

Context (previous sentences, for reference only - do NOT translate):
{context}

Sentences to translate:
{sentences}

Translations ({count} lines):`);
  readonly cleanupPrompt = signal(`You are preparing text for text-to-speech (TTS) audiobook narration.

OUTPUT FORMAT: Respond with ONLY the processed text. Start immediately with the content.
FORBIDDEN: Never write "Here is", "I'll help", or ANY conversational language.

CRITICAL RULES:
- NEVER summarize. Output must be the same length as input (with minor variations from edits).
- NEVER paraphrase or rewrite sentences unless fixing an error.
- NEVER skip or omit any content.
- Process the text LINE BY LINE, making only the specific fixes below.

EDGE CASES:
- Empty/whitespace input → output: [SKIP]
- Garbage/unreadable characters → output: [SKIP]

NUMBERS → SPOKEN WORDS:
- Years: "1923" → "nineteen twenty-three", "2001" → "two thousand one"
- Decades: "the 1930s" → "the nineteen thirties"
- Ordinals: "1st" → "first", "21st" → "twenty-first"
- Cardinals: "3 men" → "three men"
- Currency: "$5.50" → "five dollars and fifty cents"
- Percentages: "25%" → "twenty-five percent"

EXPAND ABBREVIATIONS:
- Titles: "Mr." → "Mister", "Dr." → "Doctor", "Mrs." → "Missus"
- Common: "e.g." → "for example", "i.e." → "that is", "etc." → "and so on", "vs." → "versus"

FIX: broken words, OCR errors, stylistic spacing issues.
REMOVE: stray artifacts, leftover HTML entities.

Start your response with the first word of the text. No introduction.`);

  // Computed
  readonly selectedProject = computed(() => {
    const id = this.selectedProjectId();
    return this.projects().find(p => p.id === id) || null;
  });

  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const items: ToolbarItem[] = [
      { id: 'new', type: 'button', icon: '+', label: 'New Project' },
      { id: 'refresh', type: 'button', icon: '↻', label: 'Refresh' },
    ];

    if (this.selectedProject()) {
      items.push(
        { id: 'spacer', type: 'spacer' },
        { id: 'delete', type: 'button', icon: '🗑', label: 'Delete' }
      );
    }

    return items;
  });

  ngOnInit(): void {
    this.loadProjects();
    this.loadCompletedAudiobooks();
    this.fetchOllamaModels(); // Fetch Ollama models on init

    // Handle query param for returning home
    this.route.queryParams.subscribe(params => {
      if (params['home']) {
        this.selectedProjectId.set(null);
        this.workflowState.set('projects');
      }
    });
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  async loadProjects(): Promise<void> {
    const result = await this.electronService.languageLearningListProjects();
    if (result.success && result.projects) {
      this.projects.set(result.projects);
    }
  }

  async loadCompletedAudiobooks(): Promise<void> {
    const result = await this.electronService.languageLearningListCompleted();
    if (result.success && result.audiobooks) {
      this.completedAudiobooks.set(result.audiobooks);
    }
  }

  async selectProject(id: string): Promise<void> {
    this.selectedProjectId.set(id);
    const project = this.projects().find(p => p.id === id);
    if (project) {
      // Check if audio file exists for this project
      const hasAudioResult = await this.electronService.languageLearningHasAudio(id);
      if (hasAudioResult.success && hasAudioResult.hasAudio) {
        // Audio exists - go directly to player
        this.workflowState.set('player');
      } else {
        // No audio - go to content editing
        this.workflowState.set('select');
      }
    }
  }

  startNewProject(): void {
    this.selectedProjectId.set(null);
    this.urlInput.set('');
    this.fetchError.set(null);
    this.workflowState.set('fetch');
  }

  // Called from UrlInputComponent
  async onFetchUrl(url: string): Promise<void> {
    console.log('[LANGUAGE-LEARNING] onFetchUrl called with:', url);
    this.urlInput.set(url);
    this.isFetching.set(true);
    this.fetchError.set(null);

    try {
      console.log('[LANGUAGE-LEARNING] Calling electronService.languageLearningFetchUrl...');
      const result = await this.electronService.languageLearningFetchUrl(url);
      console.log('[LANGUAGE-LEARNING] Fetch result:', result);

      if (result.success && result.htmlPath) {
        // Extract project ID from path: .../projects/<id>/article.html
        const pathParts = result.htmlPath.replace(/\\/g, '/').split('/');
        const projectId = pathParts[pathParts.length - 2];

        // Create new project
        const project: LanguageLearningProject = {
          id: projectId,
          sourceUrl: url,
          title: result.title || 'Untitled',
          byline: result.byline,
          excerpt: result.excerpt,
          wordCount: result.wordCount,
          sourceLang: 'en',
          targetLang: 'de', // Default to German
          status: 'fetched',
          htmlPath: result.htmlPath,
          content: result.content,
          textContent: result.textContent,
          deletedSelectors: [],
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        };

        // Save project
        await this.electronService.languageLearningSaveProject(project);

        // Reload projects and select the new one
        await this.loadProjects();
        this.selectProject(project.id);
      } else {
        this.fetchError.set(result.error || 'Failed to fetch URL');
      }
    } catch (error) {
      this.fetchError.set((error as Error).message);
    } finally {
      this.isFetching.set(false);
    }
  }

  // Called from ArticlePreviewComponent
  onDeletedSelectorsChange(selectors: string[]): void {
    const project = this.selectedProject();
    if (project) {
      project.deletedSelectors = selectors;
    }
  }

  onUndoStackChange(stack: { type: string; selectors: string[]; timestamp: string }[]): void {
    const project = this.selectedProject();
    if (project) {
      project.undoStack = stack as EditAction[];
    }
  }

  onRedoStackChange(stack: { type: string; selectors: string[]; timestamp: string }[]): void {
    const project = this.selectedProject();
    if (project) {
      project.redoStack = stack as EditAction[];
    }
  }

  // Called when project data changes - save to disk immediately
  async onProjectChanged(): Promise<void> {
    const project = this.selectedProject();
    if (project) {
      project.modifiedAt = new Date().toISOString();
      await this.electronService.languageLearningSaveProject(project);
      // Don't reload projects to avoid resetting selection state
    }
  }

  // Save deleted blocks and continue to wizard
  async saveAndContinue(): Promise<void> {
    const project = this.selectedProject();
    if (project) {
      project.status = 'selected';
      project.modifiedAt = new Date().toISOString();
      await this.electronService.languageLearningSaveProject(project);
      await this.loadProjects();
      this.workflowState.set('wizard');
    }
  }

  setWorkflowState(state: WorkflowState): void {
    this.workflowState.set(state);
  }

  goToQueue(): void {
    this.router.navigate(['/queue']);
  }

  goToSettings(): void {
    // Go directly to settings without resetting status
    this.workflowState.set('settings');
  }

  async resetProjectStatus(): Promise<void> {
    const project = this.selectedProject();
    if (project) {
      // Reset status to 'selected' so user can edit and resubmit
      project.status = 'selected';
      project.modifiedAt = new Date().toISOString();
      await this.electronService.languageLearningSaveProject(project);
      await this.loadProjects();
      this.workflowState.set('select');
    }
  }

  // Called from LanguageSelectorComponent
  async onTargetLangChange(langCode: string): Promise<void> {
    const project = this.selectedProject();
    if (project) {
      project.targetLang = langCode;
      await this.electronService.languageLearningSaveProject(project);
      await this.loadProjects();
    }
  }

  onVoiceChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedVoice = select.value;
  }

  // AI Settings methods
  selectProvider(provider: 'ollama' | 'claude' | 'openai'): void {
    this.selectedProvider.set(provider);
    // Fetch available models based on provider
    if (provider === 'ollama') {
      this.fetchOllamaModels();
    } else if (provider === 'claude') {
      this.fetchClaudeModels();
    } else {
      this.fetchOpenAIModels();
    }
  }

  async fetchOllamaModels(): Promise<void> {
    this.loadingModels.set(true);
    try {
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      if (response?.ok) {
        this.ollamaConnected.set(true);
        const data = await response.json();
        const models = (data.models || []).map((m: { name: string }) => ({
          value: m.name,
          label: m.name
        }));
        this.availableModels.set(models);
        // Set first model if none selected or current not in list
        const currentModel = this.selectedModel();
        const modelExists = models.some((m: { value: string }) => m.value === currentModel);
        if (!currentModel || !modelExists) {
          if (models.length > 0) {
            this.selectedModel.set(models[0].value);
          }
        }
      } else {
        this.ollamaConnected.set(false);
        // Fallback models if Ollama not running
        this.availableModels.set([
          { value: 'llama3.2', label: 'Ollama not connected' }
        ]);
      }
    } catch {
      this.ollamaConnected.set(false);
      this.availableModels.set([
        { value: 'llama3.2', label: 'Ollama not connected' }
      ]);
    } finally {
      this.loadingModels.set(false);
    }
  }

  async fetchClaudeModels(): Promise<void> {
    const config = this.settingsService.getAIConfig();
    if (!config.claude.apiKey) {
      this.availableModels.set([
        { value: '', label: 'No API key configured' }
      ]);
      return;
    }

    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getClaudeModels(config.claude.apiKey);
      if (result.success && result.models) {
        this.availableModels.set(result.models);
        // Set first model if none selected or current not in list
        const currentModel = this.selectedModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!currentModel || !modelExists) {
          if (result.models.length > 0) {
            this.selectedModel.set(result.models[0].value);
          }
        }
      } else {
        this.availableModels.set([
          { value: 'claude-sonnet-4-20250514', label: 'Failed to load models' }
        ]);
        this.selectedModel.set('claude-sonnet-4-20250514');
      }
    } catch {
      this.availableModels.set([
        { value: 'claude-sonnet-4-20250514', label: 'Failed to load models' }
      ]);
      this.selectedModel.set('claude-sonnet-4-20250514');
    } finally {
      this.loadingModels.set(false);
    }
  }

  async fetchOpenAIModels(): Promise<void> {
    const config = this.settingsService.getAIConfig();
    if (!config.openai.apiKey) {
      this.availableModels.set([
        { value: '', label: 'No API key configured' }
      ]);
      return;
    }

    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getOpenAIModels(config.openai.apiKey);
      if (result.success && result.models) {
        this.availableModels.set(result.models);
        // Set first model if none selected or current not in list
        const currentModel = this.selectedModel();
        const modelExists = result.models.some(m => m.value === currentModel);
        if (!currentModel || !modelExists) {
          if (result.models.length > 0) {
            this.selectedModel.set(result.models[0].value);
          }
        }
      } else {
        this.availableModels.set([
          { value: 'gpt-4o', label: 'Failed to load models' }
        ]);
        this.selectedModel.set('gpt-4o');
      }
    } catch {
      this.availableModels.set([
        { value: 'gpt-4o', label: 'Failed to load models' }
      ]);
      this.selectedModel.set('gpt-4o');
    } finally {
      this.loadingModels.set(false);
    }
  }

  onModelChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedModel.set(select.value);
  }

  // TTS Settings methods
  selectEngine(engine: 'xtts' | 'orpheus'): void {
    this.selectedEngine.set(engine);
    // Update default voice and workers for engine
    if (engine === 'orpheus') {
      this.selectedVoice = 'tara';
      this.selectedWorkers.set(1); // Orpheus only uses 1 worker
    } else {
      this.selectedVoice = 'ScarlettJohansson';
      // MPS: 4 workers, GPU: 1 worker (VRAM limited), CPU: 2 workers
      const device = this.selectedDevice();
      const defaultWorkers = device === 'mps' ? 4 : device === 'gpu' ? 1 : 2;
      this.selectedWorkers.set(defaultWorkers);
    }
  }

  selectDevice(device: 'mps' | 'gpu' | 'cpu'): void {
    this.selectedDevice.set(device);
    // Update default workers for XTTS based on device
    if (this.selectedEngine() === 'xtts') {
      // MPS: 4 workers, GPU: 1 worker (VRAM limited), CPU: 2 workers
      const defaultWorkers = device === 'mps' ? 4 : device === 'gpu' ? 1 : 2;
      this.selectedWorkers.set(defaultWorkers);
    }
  }

  toggleTranslationAccordion(): void {
    this.translationAccordionOpen.update(v => !v);
  }

  toggleCleanupAccordion(): void {
    this.cleanupAccordionOpen.update(v => !v);
  }

  onTranslationPromptChange(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    this.translationPrompt.set(textarea.value);
  }

  onCleanupPromptChange(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    this.cleanupPrompt.set(textarea.value);
  }

  toggleCleanupEnabled(): void {
    this.enableCleanup.set(!this.enableCleanup());
  }

  selectWorkers(count: number): void {
    this.selectedWorkers.set(count);
  }

  setSourceTtsSpeed(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.sourceTtsSpeed.set(parseFloat(input.value));
  }

  setTargetTtsSpeed(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.targetTtsSpeed.set(parseFloat(input.value));
  }

  toggleAutoApproveAlignment(): void {
    this.autoApproveAlignment.update(v => !v);
  }

  selectSplitGranularity(granularity: 'sentence' | 'paragraph'): void {
    this.splitGranularity.set(granularity);
  }

  // Get human-readable language name from code
  getLanguageName(langCode: string): string {
    const lang = this.supportedLanguages.find(l => l.code === langCode);
    return lang?.name || langCode.toUpperCase();
  }

  // Get selected voice for source language (currently same as selectedVoice)
  private selectedSourceVoice(): string {
    return this.selectedVoice;
  }

  // Get selected voice for target language (currently same as selectedVoice)
  private selectedTargetVoice(): string {
    return this.selectedVoice;
  }

  async startProcessing(): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;

    try {
      // Use local settings
      const provider = this.selectedProvider();
      const aiConfig = this.settingsService.getAIConfig();
      // Normalize backslashes for cross-platform path manipulation
      const htmlPathNorm = project.htmlPath.replace(/\\/g, '/');
      const projectDir = htmlPathNorm.substring(0, htmlPathNorm.lastIndexOf('/'));

      // Step 1: Extract text from HTML (applying user deletions)
      console.log('[LL] Extracting text from HTML with deletions:', project.deletedSelectors);
      const extractResult = await this.electronService.languageLearningExtractText(
        project.htmlPath,
        project.deletedSelectors
      );

      if (!extractResult.success || !extractResult.text) {
        throw new Error(extractResult.error || 'Failed to extract text from article');
      }

      const extractedText = extractResult.text;
      console.log(`[LL] Extracted ${extractedText.length} chars of text`);

      // Prepare output paths - cleanup creates cleaned.epub, translation creates translated.epub
      const cleanedEpubPath = `${projectDir}/cleaned.epub`;
      const articleEpubPath = `${projectDir}/article.epub`;

      // Get audiobooks output directory (sibling to projects)
      const projectsDir = projectDir.substring(0, projectDir.lastIndexOf('/'));
      const languageLearningDir = projectsDir.substring(0, projectsDir.lastIndexOf('/'));
      const audiobooksDir = `${languageLearningDir}/audiobooks`;

      // Ensure audiobooks directory exists
      await this.electronService.languageLearningEnsureDirectory(audiobooksDir);

      // Build common AI config
      const aiCommonConfig = {
        aiProvider: provider,
        aiModel: this.selectedModel(),
        ollamaBaseUrl: provider === 'ollama' ? aiConfig.ollama.baseUrl : undefined,
        claudeApiKey: provider === 'claude' ? aiConfig.claude.apiKey : undefined,
        openaiApiKey: provider === 'openai' ? aiConfig.openai.apiKey : undefined,
      } as const;

      // Generate workflow ID for grouping related jobs
      const workflowId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Create master workflow job first (container for all steps)
      const masterJob = await this.queueService.addJob({
        type: 'audiobook',
        epubPath: project.htmlPath,
        projectDir,
        workflowId,
        metadata: {
          title: `${project.title} [Bilingual]`
        },
        config: {
          type: 'audiobook'
        }
      });
      const masterJobId = masterJob.id;

      // Step 2: Create child jobs based on whether cleanup is enabled
      if (this.enableCleanup()) {
        // Job 1: AI Cleanup (child of master)
        await this.queueService.addJob({
          type: 'bilingual-cleanup',
          epubPath: project.htmlPath,
          projectDir,
          workflowId,
          parentJobId: masterJobId,
          metadata: {
            title: 'AI Cleanup'
          },
          config: {
            type: 'bilingual-cleanup',
            projectId: project.id,
            projectDir,
            sourceLang: project.sourceLang,
            ...aiCommonConfig,
            cleanupPrompt: this.cleanupPrompt()
          }
        });

        // Job 2: Translation (child of master) - uses cleaned.epub from cleanup
        await this.queueService.addJob({
          type: 'bilingual-translation',
          epubPath: project.htmlPath,
          projectDir,
          workflowId,
          parentJobId: masterJobId,
          metadata: {
            title: 'Translation'
          },
          config: {
            type: 'bilingual-translation',
            projectId: project.id,
            projectDir,
            cleanedEpubPath,  // Uses cleaned.epub created by cleanup
            sourceLang: project.sourceLang,
            targetLang: project.targetLang,
            title: project.title,
            ...aiCommonConfig,
            translationPrompt: this.translationPrompt(),
            autoApproveAlignment: this.autoApproveAlignment(),
            splitGranularity: this.splitGranularity(),
            // Test mode options
            testMode: this.testMode(),
            testModeChunks: this.testMode() ? this.testModeChunks() : undefined
          }
        });
      } else {
        // No cleanup - translation reads directly from article.epub
        // Job 1: Translation only (child of master)
        await this.queueService.addJob({
          type: 'bilingual-translation',
          epubPath: project.htmlPath,
          projectDir,
          workflowId,
          parentJobId: masterJobId,
          metadata: {
            title: 'Translation'
          },
          config: {
            type: 'bilingual-translation',
            projectId: project.id,
            projectDir,
            cleanedEpubPath: articleEpubPath,  // Uses article.epub directly when cleanup skipped
            sourceLang: project.sourceLang,
            targetLang: project.targetLang,
            title: project.title,
            ...aiCommonConfig,
            translationPrompt: this.translationPrompt(),
            autoApproveAlignment: this.autoApproveAlignment(),
            splitGranularity: this.splitGranularity(),
            // Test mode options
            testMode: this.testMode(),
            testModeChunks: this.testMode() ? this.testModeChunks() : undefined
          }
        });
      }

      // Delete any existing audiobook files before re-running TTS
      await this.electronService.languageLearningDeleteAudiobooks(project.id);

      // Get language names for display
      const sourceLangName = this.getLanguageName(project.sourceLang);
      const targetLangName = this.getLanguageName(project.targetLang);

      // Worker count - Orpheus uses single worker, XTTS can use multiple
      const workerCount = this.selectedEngine() === 'orpheus' ? 1 : 4;

      // Create TTS sub-jobs upfront as placeholders (waiting for translation to complete)
      // These will be updated with actual EPUB paths when translation completes

      // Job 3: Source TTS (placeholder - awaiting translation)
      await this.queueService.addJob({
        type: 'tts-conversion',
        projectDir,
        workflowId,
        parentJobId: masterJobId,
        metadata: {
          title: `${sourceLangName} TTS`,
          // Mark as part of bilingual workflow, to be updated when translation completes
          bilingualPlaceholder: {
            role: 'source',
            projectId: project.id,
            targetLang: project.targetLang
          }
        },
        config: {
          type: 'tts-conversion',
          // Placeholder config - will be updated when translation completes
          device: this.selectedDevice(),
          language: project.sourceLang,
          ttsEngine: this.selectedEngine(),
          fineTuned: this.selectedSourceVoice(),
          speed: this.sourceTtsSpeed(),
          useParallel: true,
          parallelMode: 'sentences',
          parallelWorkers: workerCount,
          skipAssembly: true,
          sentencePerParagraph: true,
          skipHeadings: true,
          temperature: 0.75,
          topP: 0.85,
          topK: 50,
          repetitionPenalty: 5.0,
          enableTextSplitting: true
        }
      });

      // Job 4: Target TTS (placeholder - awaiting translation)
      await this.queueService.addJob({
        type: 'tts-conversion',
        projectDir,
        workflowId,
        parentJobId: masterJobId,
        metadata: {
          title: `${targetLangName} TTS`,
          // Mark as part of bilingual workflow, to be updated when translation completes
          bilingualPlaceholder: {
            role: 'target',
            projectId: project.id
          }
        },
        config: {
          type: 'tts-conversion',
          // Placeholder config - will be updated when translation completes
          device: this.selectedDevice(),
          language: project.targetLang,
          ttsEngine: this.selectedEngine(),
          fineTuned: this.selectedTargetVoice(),
          speed: this.targetTtsSpeed(),
          useParallel: true,
          parallelMode: 'sentences',
          parallelWorkers: workerCount,
          skipAssembly: true,
          sentencePerParagraph: true,
          skipHeadings: true,
          temperature: 0.75,
          topP: 0.85,
          topK: 50,
          repetitionPenalty: 5.0,
          enableTextSplitting: true
        }
      });

      // Navigate to queue to see progress
      this.router.navigate(['/queue']);
    } catch (err) {
      console.error('Failed to add jobs to queue:', err);
      this.fetchError.set((err as Error).message);
    }
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'new':
        this.startNewProject();
        break;
      case 'refresh':
        this.loadProjects();
        this.loadCompletedAudiobooks();
        break;
      case 'delete':
        this.deleteSelectedProject();
        break;
    }
  }

  async deleteSelectedProject(): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;

    // Use native confirmation dialog
    const result = await this.electronService.languageLearningConfirmDelete(project.title || 'Untitled');
    if (!result.confirmed) return;

    await this.electronService.languageLearningDeleteProject(project.id);
    this.selectedProjectId.set(null);
    this.workflowState.set('projects');
    await this.loadProjects();
  }

  async confirmDeleteProject(project: LanguageLearningProject, event: Event): Promise<void> {
    event.stopPropagation(); // Prevent selecting the project

    // Use native confirmation dialog
    const result = await this.electronService.languageLearningConfirmDelete(project.title || 'Untitled');
    if (!result.confirmed) return;

    await this.electronService.languageLearningDeleteProject(project.id);

    // If we deleted the selected project, clear selection
    if (this.selectedProjectId() === project.id) {
      this.selectedProjectId.set(null);
      this.workflowState.set('projects');
    }

    await this.loadProjects();
    await this.loadCompletedAudiobooks(); // Also refresh completed list
  }

  playAudiobook(audiobook: any): void {
    this.selectedAudiobook.set(audiobook);
  }

  onAudiobookSelected(audiobook: any): void {
    this.selectedAudiobook.set(audiobook);
  }

  // Context menu methods
  showProjectContextMenu(event: MouseEvent, project: LanguageLearningProject): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuProject.set(project);
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);

    // Add click listener to close menu when clicking outside
    setTimeout(() => {
      document.addEventListener('click', this.hideContextMenuHandler);
    }, 0);
  }

  private hideContextMenuHandler = () => {
    this.hideContextMenu();
  };

  hideContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuProject.set(null);
    document.removeEventListener('click', this.hideContextMenuHandler);
  }

  /**
   * Show analytics for the selected project
   */
  async showAnalytics(): Promise<void> {
    const project = this.contextMenuProject();
    if (!project) return;

    this.hideContextMenu();
    this.analyticsLoading.set(true);
    this.analyticsVisible.set(true);

    try {
      const result = await this.electronService.languageLearningGetAnalytics(project.id);
      if (result.success && result.analytics) {
        this.analyticsData.set(result.analytics);
      } else {
        // No analytics yet - show empty state
        this.analyticsData.set({
          projectId: project.id,
          projectTitle: project.title || 'Untitled',
          createdAt: project.createdAt,
          status: 'running',
          stages: []
        });
      }
    } catch (error) {
      console.error('Failed to load analytics:', error);
      this.analyticsData.set(null);
    } finally {
      this.analyticsLoading.set(false);
    }
  }

  hideAnalytics(): void {
    this.analyticsVisible.set(false);
    this.analyticsData.set(null);
  }

  /**
   * Format duration from milliseconds to human-readable string
   */
  formatDuration(ms: number | undefined): string {
    if (!ms) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Start over - delete audio and all generated data, go back to content editing
   * Keeps the original downloaded HTML
   */
  async startOverProject(): Promise<void> {
    const project = this.contextMenuProject();
    if (!project) return;

    this.hideContextMenu();

    // Confirm with native dialog
    const result = await this.electronService.showConfirmDialog({
      title: 'Start Over',
      message: `Start over with "${project.title || 'Untitled'}"?`,
      detail: 'This will delete the audiobook and let you edit the content from scratch.',
      confirmLabel: 'Start Over',
      cancelLabel: 'Cancel',
      type: 'question'
    });

    if (!result.confirmed) return;

    // Delete audio and associated files
    const deleteResult = await this.electronService.languageLearningDeleteAudio(project.id);
    if (!deleteResult.success) {
      console.error('Failed to delete audio:', deleteResult.error);
      return;
    }

    // Reset project status to 'fetched' (original state after download)
    project.status = 'fetched';
    project.deletedSelectors = [];  // Clear deleted blocks
    project.modifiedAt = new Date().toISOString();
    await this.electronService.languageLearningSaveProject(project);
    await this.loadProjects();

    // Select the project and go to content editing
    this.selectedProjectId.set(project.id);
    this.workflowState.set('select');
  }

  async deleteContextMenuProject(): Promise<void> {
    const project = this.contextMenuProject();
    if (!project) return;

    this.hideContextMenu();

    // Use native confirmation dialog
    const result = await this.electronService.showConfirmDialog({
      title: 'Delete Project',
      message: `Delete "${project.title || 'Untitled'}"?`,
      detail: 'This will permanently delete the project and all associated files.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      type: 'warning'
    });

    if (!result.confirmed) return;

    await this.electronService.languageLearningDeleteProject(project.id);

    // If we deleted the selected project, clear selection
    if (this.selectedProjectId() === project.id) {
      this.selectedProjectId.set(null);
      this.workflowState.set('projects');
    }

    await this.loadProjects();
  }

  /**
   * Delete audio and associated data, then go back to content editing
   * Called from the player view's "Edit & Re-generate" button
   */
  async editAndRegenerate(): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;

    // Confirm with native dialog
    const result = await this.electronService.showConfirmDialog({
      title: 'Start Over',
      message: 'Start over with this project?',
      detail: 'This will delete the audiobook and let you edit the content from scratch.',
      confirmLabel: 'Start Over',
      cancelLabel: 'Cancel',
      type: 'question'
    });

    if (!result.confirmed) return;

    // Delete audio and associated files
    const deleteResult = await this.electronService.languageLearningDeleteAudio(project.id);
    if (!deleteResult.success) {
      console.error('Failed to delete audio:', deleteResult.error);
      return;
    }

    // Reset project status to 'fetched' (original state after download)
    project.status = 'fetched';
    project.deletedSelectors = [];  // Clear deleted blocks
    project.modifiedAt = new Date().toISOString();
    await this.electronService.languageLearningSaveProject(project);
    await this.loadProjects();

    // Go to content editing
    this.workflowState.set('select');
  }

  showInFolder(path: string): void {
    this.electronService.showInFolder(path);
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wizard Integration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the project directory path for a project ID
   */
  getProjectDir(projectId: string): string {
    const project = this.projects().find(p => p.id === projectId);
    if (project?.htmlPath) {
      // Normalize and extract directory from htmlPath
      const htmlPathNorm = project.htmlPath.replace(/\\/g, '/');
      return htmlPathNorm.substring(0, htmlPathNorm.lastIndexOf('/'));
    }
    // Fallback: construct from library path
    return `${this.libraryService.libraryPath()}/language-learning/projects/${projectId}`;
  }

  /**
   * Called when wizard has queued jobs
   */
  async onWizardQueued(): Promise<void> {
    // Navigate to queue to see progress
    this.router.navigate(['/queue']);
  }
}

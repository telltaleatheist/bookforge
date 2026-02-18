import { Component, inject, signal, computed, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem
} from '../../creamsicle-desktop';
import { AudiobookQueueComponent, QueueItem, QueueItemStatus } from './components/audiobook-queue/audiobook-queue.component';
import { MetadataEditorComponent, EpubMetadata } from './components/metadata-editor/metadata-editor.component';
import { TranslationPanelComponent } from './components/translation-panel/translation-panel.component';
// TTSSettings type moved to studio/models/tts.types.ts
import { TTSSettings } from '../studio/models/tts.types';
import { DiffViewComponent } from './components/diff-view/diff-view.component';
import { PlayViewComponent } from './components/play-view/play-view.component';
import { SkippedChunksPanelComponent } from './components/skipped-chunks-panel/skipped-chunks-panel.component';
import { PostProcessingPanelComponent } from './components/post-processing-panel/post-processing-panel.component';
import { ChapterRecoveryComponent } from './components/chapter-recovery/chapter-recovery.component';
import { EpubService } from './services/epub.service';
import { AudiobookService } from './services/audiobook.service';
import { ElectronService } from '../../core/services/electron.service';
import { SettingsService } from '../../core/services/settings.service';
import { LibraryService } from '../../core/services/library.service';
import { QueueService } from '../queue/services/queue.service';
import { AnalyticsPanelComponent } from './components/analytics-panel/analytics-panel.component';
import { ProjectAnalytics } from '../../core/models/analytics.types';

// Workflow states for the audiobook producer
type WorkflowState = 'queue' | 'metadata' | 'translate' | 'cleanup' | 'convert' | 'play' | 'diff' | 'skipped' | 'analytics' | 'enhance' | 'chapters' | 'pipeline' | 'complete';

@Component({
  selector: 'app-audiobook',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    AudiobookQueueComponent,
    MetadataEditorComponent,
    TranslationPanelComponent,
    // AiCleanupPanelComponent - REMOVED (deprecated, use process-wizard)
    // TtsSettingsComponent - REMOVED (deprecated, use process-wizard)
    DiffViewComponent,
    PlayViewComponent,
    SkippedChunksPanelComponent,
    AnalyticsPanelComponent,
    PostProcessingPanelComponent,
    ChapterRecoveryComponent
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="audiobook-container">
      <desktop-split-pane [primarySize]="280" [minSize]="200" [maxSize]="600">
        <!-- Left Panel: Queue -->
        <div pane-primary class="queue-panel">
          <div class="panel-header">
            <h3>Audiobook Queue</h3>
          </div>
          <app-audiobook-queue
            [items]="queueItems()"
            [selectedId]="selectedItemId()"
            (select)="selectItem($event)"
            (remove)="removeFromQueue($event)"
          />
        </div>

        <!-- Right Panel: Details -->
        <div pane-secondary class="details-panel">
          @if (selectedItem()) {
            <!-- Workflow tabs -->
            <div class="workflow-tabs">
              <button
                class="tab"
                [class.active]="workflowState() === 'metadata'"
                (click)="setWorkflowState('metadata')"
              >
                Metadata
              </button>
              <button
                class="tab"
                [class.active]="workflowState() === 'translate'"
                (click)="setWorkflowState('translate')"
              >
                Translate
              </button>
              <button
                class="tab"
                [class.active]="workflowState() === 'cleanup'"
                (click)="setWorkflowState('cleanup')"
              >
                AI Cleanup
              </button>
              <button
                class="tab"
                [class.active]="workflowState() === 'convert'"
                (click)="setWorkflowState('convert')"
              >
                Convert
              </button>
              <button
                class="tab"
                [class.active]="workflowState() === 'play'"
                (click)="setWorkflowState('play')"
              >
                Play
              </button>
              @if (selectedItem()?.hasCleaned) {
                <button
                  class="tab"
                  [class.active]="workflowState() === 'diff'"
                  (click)="setWorkflowState('diff')"
                >
                  Review Changes
                </button>
              }
              @if (selectedItem()?.skippedChunksPath) {
                <button
                  class="tab warning"
                  [class.active]="workflowState() === 'skipped'"
                  (click)="setWorkflowState('skipped')"
                >
                  Skipped Chunks
                </button>
              }
              @if (hasAnalytics()) {
                <button
                  class="tab"
                  [class.active]="workflowState() === 'analytics'"
                  (click)="setWorkflowState('analytics')"
                >
                  Analytics
                </button>
              }
              @if (selectedItem()?.hasAudiobook) {
                <button
                  class="tab"
                  [class.active]="workflowState() === 'enhance'"
                  (click)="setWorkflowState('enhance')"
                >
                  Enhance
                </button>
              }
              @if (hasVttFile()) {
                <button
                  class="tab"
                  [class.active]="workflowState() === 'chapters'"
                  (click)="setWorkflowState('chapters')"
                >
                  Chapters
                </button>
              }
              <button
                class="tab"
                [class.active]="workflowState() === 'pipeline'"
                (click)="setWorkflowState('pipeline')"
              >
                Pipeline
              </button>
            </div>


            <!-- Tab content -->
            <div class="tab-content" [class.diff-tab]="workflowState() === 'diff'" [class.play-tab]="workflowState() === 'play'">
              @switch (workflowState()) {
                @case ('metadata') {
                  <app-metadata-editor
                    [metadata]="selectedMetadata()"
                    [saving]="savingMetadata()"
                    (metadataChange)="onMetadataChange($event)"
                    (coverChange)="onCoverChange($event)"
                    (save)="onSaveMetadata($event)"
                  />
                }
                @case ('translate') {
                  <app-translation-panel
                    [epubPath]="originalEpubPath()"
                    [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author }"
                    (translationQueued)="onTranslationQueued()"
                  />
                }
                @case ('cleanup') {
                  <!-- DEPRECATED: Use Studio > Process tab instead -->
                  <div class="deprecated-panel">
                    <p>This feature has moved to Studio.</p>
                    <p>Use the Process tab in Studio for AI Cleanup.</p>
                  </div>
                }
                @case ('convert') {
                  <!-- DEPRECATED: Use Studio > Process tab instead -->
                  <div class="deprecated-panel">
                    <p>This feature has moved to Studio.</p>
                    <p>Use the Process tab in Studio for TTS conversion.</p>
                  </div>
                }
                @case ('play') {
                  <app-play-view
                    [epubPath]="currentEpubPath()"
                  />
                }
                @case ('diff') {
                  @if (diffPaths()) {
                    <app-diff-view
                      [originalPath]="diffPaths()!.originalPath"
                      [cleanedPath]="diffPaths()!.cleanedPath"
                      (textEdited)="onDiffTextEdited($event)"
                    />
                  }
                }
                @case ('skipped') {
                  <app-skipped-chunks-panel
                    [skippedChunksPath]="selectedItem()?.skippedChunksPath || null"
                    [cleanedEpubPath]="currentEpubPath()"
                    [originalEpubPath]="originalEpubPath()"
                  />
                }
                @case ('analytics') {
                  <app-analytics-panel
                    [analytics]="currentAnalytics()"
                  />
                }
                @case ('enhance') {
                  <app-post-processing-panel
                    [audioFilePath]="audioFilePath()"
                    [projectId]="selectedItem()?.projectId || ''"
                    [bfpPath]="selectedItem()?.bfpPath || ''"
                    [bookTitle]="selectedItem()?.metadata?.title || ''"
                    [bookAuthor]="selectedItem()?.metadata?.author || ''"
                    [enhancementStatus]="selectedItem()?.enhancementStatus || 'none'"
                    [enhancedAt]="selectedItem()?.enhancedAt"
                    (jobQueued)="onEnhanceJobQueued($event)"
                  />
                }
                @case ('chapters') {
                  @if (hasVttFile() && audioFilePath()) {
                    <app-chapter-recovery
                      [epubPath]="currentEpubPath()"
                      [vttPath]="vttPath()!"
                      [m4bPath]="audioFilePath()!"
                      (chaptersApplied)="onChaptersApplied($event)"
                    />
                  }
                }
                @case ('pipeline') {
                  <div class="pipeline-management">
                    <h3>Pipeline Stage Management</h3>
                    <p class="pipeline-description">
                      Delete cached pipeline stages to free up disk space or reset the workflow.
                    </p>

                    <div class="pipeline-sections">
                      <!-- AI Cleanup Section -->
                      <div class="pipeline-section">
                        <div class="section-header">
                          <h4>AI Cleanup Stage</h4>
                          @if (hasPipelineCleanup()) {
                            <span class="status-badge exists">Files exist</span>
                          } @else {
                            <span class="status-badge empty">Empty</span>
                          }
                        </div>
                        <p class="section-description">
                          Cleaned EPUB files and diff data from AI processing.
                        </p>
                        <button
                          class="btn-delete"
                          [disabled]="!hasPipelineCleanup() || deletingCleanup()"
                          (click)="deleteCleanupStage()"
                        >
                          @if (deletingCleanup()) {
                            Deleting...
                          } @else {
                            Delete Cleanup Files
                          }
                        </button>
                      </div>

                      <!-- Translation Section -->
                      <div class="pipeline-section">
                        <div class="section-header">
                          <h4>Translation Stage</h4>
                          @if (hasPipelineTranslation()) {
                            <span class="status-badge exists">Files exist</span>
                          } @else {
                            <span class="status-badge empty">Empty</span>
                          }
                        </div>
                        <p class="section-description">
                          Translated EPUBs and sentence pairs for bilingual audiobooks.
                        </p>
                        <button
                          class="btn-delete"
                          [disabled]="!hasPipelineTranslation() || deletingTranslation()"
                          (click)="deleteTranslationStage()"
                        >
                          @if (deletingTranslation()) {
                            Deleting...
                          } @else {
                            Delete Translation Files
                          }
                        </button>
                      </div>

                      <!-- TTS Cache Section -->
                      <div class="pipeline-section">
                        <div class="section-header">
                          <h4>TTS Cache</h4>
                          @if (hasPipelineTTS()) {
                            <span class="status-badge exists">
                              {{ ttsCacheLanguages().length }} language(s)
                            </span>
                          } @else {
                            <span class="status-badge empty">Empty</span>
                          }
                        </div>
                        <p class="section-description">
                          Cached TTS session files for different languages.
                        </p>
                        @if (ttsCacheLanguages().length > 0) {
                          <div class="language-list">
                            @for (lang of ttsCacheLanguages(); track lang) {
                              <div class="language-item">
                                <span class="language-code">{{ lang }}</span>
                                <button
                                  class="btn-delete-small"
                                  [disabled]="deletingTTS()"
                                  (click)="deleteTTSCache(lang)"
                                  title="Delete {{ lang }} cache"
                                >
                                  ×
                                </button>
                              </div>
                            }
                          </div>
                        }
                        <button
                          class="btn-delete"
                          [disabled]="!hasPipelineTTS() || deletingTTS()"
                          (click)="deleteTTSCache()"
                        >
                          @if (deletingTTS()) {
                            Deleting...
                          } @else {
                            Delete All TTS Caches
                          }
                        </button>
                      </div>

                      <!-- Delete All Section -->
                      <div class="pipeline-section danger">
                        <div class="section-header">
                          <h4>Delete All Pipeline Stages</h4>
                        </div>
                        <p class="section-description warning">
                          ⚠️ This will delete all cached pipeline data. You'll need to re-run the entire workflow.
                        </p>
                        <button
                          class="btn-delete danger"
                          [disabled]="(!hasPipelineCleanup() && !hasPipelineTranslation() && !hasPipelineTTS()) || deletingAll()"
                          (click)="deleteAllPipelineStages()"
                        >
                          @if (deletingAll()) {
                            Deleting...
                          } @else {
                            Delete All Pipeline Stages
                          }
                        </button>
                      </div>
                    </div>
                  </div>
                }
              }
            </div>
          } @else if (preloadedResumeInfo()) {
            <!-- Resume from Past Sessions - no queue item needed -->
            <div class="resume-header">
              <div class="resume-title-row">
                <div>
                  <h2>Continue TTS Conversion</h2>
                  <p class="resume-subtitle">{{ preloadedResumeInfo()!.title }}
                    @if (preloadedResumeInfo()!.author) {
                      <span class="resume-author">by {{ preloadedResumeInfo()!.author }}</span>
                    }
                  </p>
                </div>
                <button class="back-link" (click)="clearResumeAndGoBack()">
                  ← Back to Past Sessions
                </button>
              </div>

              <!-- Session Statistics -->
              <div class="resume-stats">
                <div class="progress-row">
                  <div class="progress-bar">
                    <div class="progress-fill" [style.width.%]="preloadedResumeInfo()!.percentComplete || 0"></div>
                  </div>
                  <span class="progress-text">{{ (preloadedResumeInfo()!.percentComplete || 0) | number:'1.0-1' }}%</span>
                </div>
                <div class="stats-row">
                  <span class="stat">
                    <span class="stat-value">{{ preloadedResumeInfo()!.completedSentences || 0 | number }}</span>
                    <span class="stat-label">of {{ preloadedResumeInfo()!.totalSentences || 0 | number }} sentences</span>
                  </span>
                  <span class="stat-divider">·</span>
                  <span class="stat">
                    <span class="stat-value">{{ (preloadedResumeInfo()!.totalSentences || 0) - (preloadedResumeInfo()!.completedSentences || 0) | number }}</span>
                    <span class="stat-label">remaining</span>
                  </span>
                  @if (preloadedResumeInfo()!.modifiedAt) {
                    <span class="stat-divider">·</span>
                    <span class="stat">
                      <span class="stat-label">Last active:</span>
                      <span class="stat-value">{{ formatSessionDate(preloadedResumeInfo()!.modifiedAt!) }}</span>
                    </span>
                  }
                </div>
              </div>
            </div>
            <div class="tab-content">
              <!-- DEPRECATED: Use Studio > Process tab instead -->
              <div class="deprecated-panel">
                <p>This feature has moved to Studio.</p>
                <p>Use the Process tab in Studio for TTS conversion.</p>
              </div>
            </div>
          } @else {
            <!-- Empty state -->
            <div class="empty-state">
              <div class="empty-icon">&#127911;</div>
              <h2>Audiobook Producer</h2>
              <p>Select a book from the queue to continue, or use "Export to Audiobook" from the Library to add new books.</p>
            </div>
          }
        </div>
      </desktop-split-pane>
    </div>

  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    .audiobook-container {
      flex: 1;
      overflow: hidden;
    }

    .queue-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-subtle);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-default);

      h3 {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .details-panel {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-base);
    }

    .workflow-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-default);
      padding: 0 1rem;
      gap: 0.5rem;
    }

    .tab {
      padding: 0.75rem 1rem;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        color: var(--text-primary);
      }

      &.active {
        color: var(--accent-primary);
        border-bottom-color: var(--accent-primary);
      }

      &.warning {
        color: var(--warning, #f59e0b);

        &.active {
          color: var(--warning, #f59e0b);
          border-bottom-color: var(--warning, #f59e0b);
        }
      }
    }

    .tab-content {
      flex: 1;
      overflow: auto;
      padding: 1rem;

      &.diff-tab {
        padding: 0.5rem;
        display: flex;
        flex-direction: column;
        overflow: hidden;

        app-diff-view {
          flex: 1;
        }
      }

      &.play-tab {
        padding: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;

        app-play-view {
          flex: 1;
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);

      .empty-icon {
        font-size: 4rem;
        margin-bottom: 1rem;
      }

      h2 {
        margin: 0 0 0.5rem 0;
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 1.5rem 0;
        max-width: 300px;
      }
    }

    .resume-header {
      padding: 1rem;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-subtle);

      .resume-title-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 1rem;
      }

      h2 {
        margin: 0 0 0.25rem 0;
        font-size: 1.125rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      .resume-subtitle {
        margin: 0;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .resume-author {
        color: var(--text-muted);
        font-style: italic;
      }

      .back-link {
        background: none;
        border: none;
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        color: var(--accent-primary);
        cursor: pointer;
        text-decoration: none;
        white-space: nowrap;

        &:hover {
          text-decoration: underline;
        }
      }

      .resume-stats {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
        background: var(--bg-base);
        border-radius: 6px;
      }

      .progress-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .progress-bar {
        flex: 1;
        height: 8px;
        background: var(--bg-elevated);
        border-radius: 4px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: var(--accent-primary);
        border-radius: 4px;
        transition: width 0.3s ease;
      }

      .progress-text {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--accent-primary);
        min-width: 3rem;
        text-align: right;
      }

      .stats-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
        flex-wrap: wrap;
      }

      .stat {
        display: flex;
        gap: 0.25rem;
      }

      .stat-value {
        font-weight: 500;
        color: var(--text-primary);
      }

      .stat-label {
        color: var(--text-muted);
      }

      .stat-divider {
        color: var(--text-muted);
      }
    }

    /* Pipeline Management Styles */
    .pipeline-management {
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }

    .pipeline-management h3 {
      color: var(--text-primary);
      margin-bottom: 0.5rem;
    }

    .pipeline-description {
      color: var(--text-muted);
      margin-bottom: 2rem;
    }

    .pipeline-sections {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .pipeline-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.5rem;
    }

    .pipeline-section.danger {
      border-color: var(--danger-color, #ff4444);
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .section-header h4 {
      margin: 0;
      color: var(--text-primary);
      font-size: 1.1rem;
    }

    .status-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-size: 0.85rem;
      font-weight: 500;
    }

    .status-badge.exists {
      background: var(--success-bg, rgba(0, 200, 83, 0.1));
      color: var(--success-color, #00c853);
    }

    .status-badge.empty {
      background: var(--muted-bg, rgba(128, 128, 128, 0.1));
      color: var(--text-muted);
    }

    .section-description {
      color: var(--text-muted);
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }

    .section-description.warning {
      color: var(--warning-color, #ff9800);
    }

    .language-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .language-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.5rem;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }

    .language-code {
      font-weight: 500;
      text-transform: uppercase;
      font-size: 0.9rem;
    }

    .btn-delete,
    .btn-delete-small {
      background: var(--danger-bg, rgba(255, 68, 68, 0.1));
      color: var(--danger-color, #ff4444);
      border: 1px solid var(--danger-color, #ff4444);
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: all 0.2s;
    }

    .btn-delete-small {
      padding: 0.125rem 0.375rem;
      font-size: 1.2rem;
      line-height: 1;
      min-width: 1.5rem;
    }

    .btn-delete:hover:not(:disabled),
    .btn-delete-small:hover:not(:disabled) {
      background: var(--danger-color, #ff4444);
      color: white;
    }

    .btn-delete.danger {
      background: var(--danger-color, #ff4444);
      color: white;
      font-weight: 500;
    }

    .btn-delete.danger:hover:not(:disabled) {
      background: #cc0000;
      border-color: #cc0000;
    }

    .btn-delete:disabled,
    .btn-delete-small:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .deprecated-panel {
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
    }

    .deprecated-panel p {
      margin: 0.5rem 0;
    }

  `]
})
export class AudiobookComponent implements OnInit {
  private readonly epubService = inject(EpubService);
  private readonly audiobookService = inject(AudiobookService);
  private readonly electronService = inject(ElectronService);
  private readonly settingsService = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // Preloaded resume info from Past Sessions page
  readonly preloadedResumeInfo = signal<{
    sessionId: string;
    sessionDir: string;
    processDir: string;
    title?: string;
    author?: string;
    // Session statistics
    totalSentences?: number;
    completedSentences?: number;
    percentComplete?: number;
    modifiedAt?: string;
  } | undefined>(undefined);

  // State
  readonly queueItems = signal<QueueItem[]>([]);
  readonly selectedItemId = signal<string | null>(null);
  readonly workflowState = signal<WorkflowState>('metadata');
  readonly ttsSettings = signal<TTSSettings>({
    device: this.getDefaultDevice(),
    language: 'en',
    ttsEngine: 'xtts',
    fineTuned: 'ScarlettJohansson',  // Default to Scarlett Johansson voice
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 2.0,
    speed: 1.0,
    enableTextSplitting: false,
    useParallel: true,        // Always use parallel mode (enables resumability)
    parallelWorkers: 0,       // 0 = Auto (detect based on available RAM)
    parallelMode: 'sentences' // Always use sentence-based division
  });

  /** Get default device based on platform */
  private getDefaultDevice(): 'mps' | 'gpu' | 'cpu' {
    const platform = this.electronService.platform;
    if (platform === 'darwin') {
      return 'cpu';  // CPU is better for XTTS on Mac - same speed, less memory pressure
    } else if (platform === 'win32' || platform === 'linux') {
      return 'gpu';  // Windows/Linux use CUDA
    }
    return 'cpu';  // Fallback
  }
  readonly savingMetadata = signal(false);

  // Diff view state
  readonly diffPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);

  // Analytics state - keyed by project ID
  private readonly _projectAnalytics = signal<Map<string, ProjectAnalytics>>(new Map());

  // ViewChild reference to diff view for manual refresh
  @ViewChild(DiffViewComponent) diffViewRef?: DiffViewComponent;

  // Note: Analytics saving is now handled directly by QueueService.handleJobComplete()
  // to avoid duplicate saves from component lifecycle effects.

  // Check if we're running in Electron
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron ? (window as any).electron : null;
  }

  // Computed
  readonly selectedItem = computed(() => {
    const id = this.selectedItemId();
    if (!id) return null;
    return this.queueItems().find(item => item.id === id) || null;
  });

  readonly selectedMetadata = computed(() => {
    const item = this.selectedItem();
    if (!item) return null;
    return item.metadata;
  });

  // Path to original EPUB (always use this for cleanup)
  readonly originalEpubPath = computed(() => {
    const item = this.selectedItem();
    if (!item) return '';
    // item.path already points to original.epub
    return item.path;
  });

  // Path to best available EPUB for TTS (cleaned if exists, otherwise original)
  readonly currentEpubPath = computed(() => {
    const item = this.selectedItem();
    if (!item) return '';

    // For TTS, prefer the cleaned version if it exists
    if (item.hasCleaned && item.projectId) {
      const pathNorm = item.path.replace(/\\/g, '/');
      const originalDir = pathNorm.substring(0, pathNorm.lastIndexOf('/'));
      const cleanedName = item.cleanedFilename || 'cleaned.epub';
      return `${originalDir}/${cleanedName}`;
    }

    return item.path;
  });

  // Path to the completed audiobook m4b file for enhancement
  readonly audioFilePath = computed(() => {
    const item = this.selectedItem();
    if (!item) return '';

    // linkedAudioPath is set either by auto-detection or manual linking
    if (item.linkedAudioPath) {
      return item.linkedAudioPath.replace(/\\/g, '/');
    }

    return '';
  });

  // Whether the audio file path is valid on the current system
  readonly audioFilePathValid = computed(() => {
    const item = this.selectedItem();
    if (!item) return true;  // No item = no error to show

    // If there's a linked path, check if it's valid
    if (item.linkedAudioPath) {
      // linkedAudioPathValid is explicitly set when loading from BFP
      // If undefined, assume valid (backwards compatibility with auto-detected paths)
      return item.linkedAudioPathValid !== false;
    }

    return true;
  });

  // Generated filename from metadata (used when no custom filename set)
  readonly generatedFilename = computed(() => {
    const meta = this.selectedMetadata();
    if (!meta) return 'audiobook.m4b';

    let filename = meta.title || 'Untitled';

    if (meta.subtitle) {
      filename += ` - ${meta.subtitle}`;
    }

    filename += '.';

    // Use Last, First format
    if (meta.authorLast) {
      filename += ` ${meta.authorLast}`;
      if (meta.authorFirst) {
        filename += `, ${meta.authorFirst}`;
      }
      filename += '.';
    } else if (meta.authorFirst) {
      filename += ` ${meta.authorFirst}.`;
    } else if (meta.author) {
      // Parse author into Last, First
      const parts = meta.author.trim().split(' ');
      if (parts.length >= 2) {
        const last = parts.pop();
        filename += ` ${last}, ${parts.join(' ')}.`;
      } else {
        filename += ` ${meta.author}.`;
      }
    }

    if (meta.year) {
      filename += ` (${meta.year})`;
    }

    filename += '.m4b';

    // Clean up the filename
    return filename.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.');
  });

  // Get analytics for the currently selected item
  readonly currentAnalytics = computed((): ProjectAnalytics | undefined => {
    const item = this.selectedItem();
    if (!item?.projectId) return undefined;
    return this._projectAnalytics().get(item.projectId);
  });

  // Check if the current item has any analytics
  readonly hasAnalytics = computed(() => {
    const analytics = this.currentAnalytics();
    if (!analytics) return false;
    return (analytics.ttsJobs?.length > 0) || (analytics.cleanupJobs?.length > 0);
  });

  // VTT file path for chapter recovery
  readonly vttPath = computed(() => {
    const item = this.selectedItem();
    if (!item?.audiobookFolder) return null;
    // VTT files are stored as subtitles.vtt in the audiobook folder
    return `${item.audiobookFolder}/subtitles.vtt`;
  });

  // Check if VTT file exists (for showing Chapters tab)
  readonly hasVttFile = computed(() => {
    const item = this.selectedItem();
    // Check if vttPath is set in the BFP (populated when VTT was copied after TTS)
    // For now, we'll show the tab if there's a linked audiobook - we'll verify the file exists when opening
    return !!item?.linkedAudioPath && !!item?.audiobookFolder;
  });

  // Pipeline management signals
  readonly hasPipelineCleanup = signal(false);
  readonly hasPipelineTranslation = signal(false);
  readonly hasPipelineTTS = signal(false);
  readonly ttsCacheLanguages = signal<string[]>([]);
  readonly deletingCleanup = signal(false);
  readonly deletingTranslation = signal(false);
  readonly deletingTTS = signal(false);
  readonly deletingAll = signal(false);

  // Toolbar
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const items: ToolbarItem[] = [
      {
        id: 'refresh',
        type: 'button',
        icon: '\u21BB',
        label: 'Refresh',
        tooltip: 'Refresh queue'
      }
    ];

    // Add export button when an item is selected
    if (this.selectedItem()) {
      items.push(
        { id: 'sep2', type: 'divider' },
        {
          id: 'export-epub',
          type: 'button',
          icon: '\u2B07',
          label: 'Export EPUB',
          tooltip: 'Export as EPUB file'
        }
      );
    }

    return items;
  });

  async ngOnInit(): Promise<void> {
    // Check for resume session from Past Sessions page
    this.route.queryParams.subscribe(params => {
      if (params['resumeSession']) {
        console.log('[AUDIOBOOK] Received resume session from Past Sessions:', params);
        this.preloadedResumeInfo.set({
          sessionId: params['resumeSession'],
          sessionDir: params['resumeSessionDir'],
          processDir: params['resumeProcessDir'],
          title: params['title'],
          author: params['author'],
          // Session statistics
          totalSentences: params['totalSentences'] ? parseInt(params['totalSentences'], 10) : undefined,
          completedSentences: params['completedSentences'] ? parseInt(params['completedSentences'], 10) : undefined,
          percentComplete: params['percentComplete'] ? parseFloat(params['percentComplete']) : undefined,
          modifiedAt: params['modifiedAt']
        });
        // Switch to convert tab to show the resume option
        this.setWorkflowState('convert');
      }
    });

    await this.loadQueue();
    await this.loadCompletedAudiobooks();
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'refresh':
        this.loadQueue().then(() => this.loadCompletedAudiobooks());
        // Also refresh diff view if on the diff tab
        if (this.workflowState() === 'diff' && this.diffViewRef) {
          this.diffViewRef.refresh();
        }
        break;
      case 'export-epub':
        this.exportEpub();
        break;
    }
  }

  async loadQueue(): Promise<void> {
    // Ensure library service is ready before accessing libraryPath()
    await this.libraryService.whenReady();

    // Use unified project list - only shows projects exported to audiobook producer
    const projects = await this.audiobookService.listUnifiedProjects();

    const items: QueueItem[] = [];
    for (const project of projects) {
      // Parse EPUB to get full metadata
      const structure = await this.epubService.open(project.epubPath);
      if (structure) {
        // Parse author into first/last
        const authorParts = (project.metadata?.author || structure.metadata.author || '').trim().split(' ');
        let authorFirst = '';
        let authorLast = '';
        if (authorParts.length >= 2) {
          authorLast = authorParts.pop() || '';
          authorFirst = authorParts.join(' ');
        } else if (authorParts.length === 1) {
          authorFirst = authorParts[0];
        }

        // Resolve cover path to full filesystem path if available in BFP
        let resolvedCoverPath: string | undefined;
        if (project.metadata?.coverImagePath) {
          const libPath = this.libraryService.libraryPath();
          if (libPath) {
            resolvedCoverPath = `${libPath}/${project.metadata.coverImagePath}`;
            console.log(`[Audiobook] Resolved coverPath for "${project.name}":`, resolvedCoverPath);
          } else {
            console.warn(`[Audiobook] Cannot resolve coverPath - libraryPath is null for "${project.name}"`);
          }
        }

        let metadata: EpubMetadata = {
          title: project.metadata?.title || structure.metadata.title || project.name,
          subtitle: structure.metadata.subtitle,
          author: project.metadata?.author || structure.metadata.author || '',
          authorFirst,
          authorLast,
          year: project.metadata?.year || structure.metadata.year,
          language: structure.metadata.language,
          coverPath: resolvedCoverPath,  // Full path to cover file in media folder
          outputFilename: project.metadata?.outputFilename
        };

        // Load cover image as base64 for display in UI
        if (project.metadata?.coverImagePath && this.electron) {
          try {
            const coverResult = await this.electron.media.loadImage(project.metadata.coverImagePath);
            if (coverResult.success && coverResult.data) {
              metadata.coverData = coverResult.data;
            }
          } catch {
            // Cover image not found, continue without it
          }
        }

        // Check if cleaned EPUB exists based on project state
        const hasCleaned = !!project.cleanedAt;

        // Determine cleaned/simplified epub filename
        // Priority: simplified.epub > cleaned.epub > exported_cleaned.epub (legacy)
        let cleanedFilename: string | undefined;
        if (hasCleaned && this.electron) {
          const simplifiedPath = `${project.audiobookFolder}/simplified.epub`;
          const cleanedPath = `${project.audiobookFolder}/cleaned.epub`;
          const legacyCleanedPath = `${project.audiobookFolder}/exported_cleaned.epub`;
          if (await this.electron.fs.exists(simplifiedPath).catch(() => false)) {
            cleanedFilename = 'simplified.epub';
          } else if (await this.electron.fs.exists(cleanedPath).catch(() => false)) {
            cleanedFilename = 'cleaned.epub';
          } else if (await this.electron.fs.exists(legacyCleanedPath).catch(() => false)) {
            cleanedFilename = 'exported_cleaned.epub';
          }
        }

        // Map status from BFP audiobook state
        let status: QueueItemStatus = 'pending';
        if (project.status === 'cleaning') status = 'cleanup';
        else if (project.status === 'converting') status = 'converting';
        else if (project.status === 'complete') status = 'complete';
        else if (project.status === 'error') status = 'error';

        // Check if skipped-chunks.json actually exists (don't assume based on hasCleaned)
        const skippedChunksFile = `${project.audiobookFolder}/skipped-chunks.json`;
        const hasSkippedChunks = hasCleaned && this.electron
          ? await this.electron.fs.exists(skippedChunksFile).catch(() => false)
          : false;

        items.push({
          id: project.bfpPath,  // Use BFP path as unique ID
          path: project.epubPath,
          filename: `${project.name}.epub`,
          metadata,
          status,
          addedAt: project.exportedAt ? new Date(project.exportedAt) : new Date(),
          bfpPath: project.bfpPath,
          projectId: project.name,  // Required for currentEpubPath to use cleaned epub
          audiobookFolder: project.audiobookFolder,
          hasCleaned,
          cleanedFilename,
          linkedAudioPath: project.linkedAudioPath,  // Load manually linked path from BFP
          linkedAudioPathValid: project.linkedAudioPathValid,  // Cross-platform path validation
          skippedChunksPath: hasSkippedChunks ? skippedChunksFile : undefined
        });

        // Load analytics for this project if available (trim to last 10 of each type)
        if (project.analytics) {
          const MAX_ANALYTICS_HISTORY = 10;
          const analyticsMap = this._projectAnalytics();
          const newMap = new Map(analyticsMap);
          newMap.set(project.name, {
            ttsJobs: (project.analytics.ttsJobs || []).slice(-MAX_ANALYTICS_HISTORY),
            cleanupJobs: (project.analytics.cleanupJobs || []).slice(-MAX_ANALYTICS_HISTORY)
          });
          this._projectAnalytics.set(newMap);
        }

        await this.epubService.close();
      }
    }

    this.queueItems.set(items);

    // If there's no selection but we have items, select the first one
    // Skip auto-selection when resuming from Past Sessions (preloadedResumeInfo is set)
    if (!this.selectedItemId() && items.length > 0 && !this.preloadedResumeInfo()) {
      this.selectItem(items[0].id);
    }
  }

  async loadCompletedAudiobooks(): Promise<void> {
    if (!this.electron) return;

    try {
      // Use configured output dir, or fall back to library's audiobooks folder
      // Check external audiobooks dir and library's default folder for completed audiobooks
      const externalDir = this.settingsService.get<string>('externalAudiobooksDir');
      const outputDir = externalDir || this.libraryService.audiobooksPath() || '';
      const result = await this.electron.library.listCompleted(outputDir || undefined);

      if (result.success && result.files) {
        const completed = result.files.map((f: any) => ({
          path: f.path,
          filename: f.filename
        }));

        // Mark queue items that have completed audiobooks and store the matched paths
        this.markItemsWithAudiobooks(completed);
      }
    } catch (err) {
      console.error('Failed to load completed audiobooks:', err);
    }
  }

  /**
   * Mark queue items that have a completed audiobook and store matched paths
   */
  private markItemsWithAudiobooks(completed: { path: string; filename: string }[]): void {
    // Build lookup map of completed files (lowercase filename -> full path)
    const completedMap = new Map<string, string>();
    for (const c of completed) {
      completedMap.set(c.filename.toLowerCase(), c.path);
    }

    // Normalize function for fuzzy matching
    const normalize = (s: string) => s.toLowerCase().replace(/['']/g, '').replace(/\s+/g, ' ').trim();

    // Update queue items and sort (completed at bottom)
    this.queueItems.update(items => {
      const updated = items.map(item => {
        // Skip if already has a manually linked path that's valid on this system
        if (item.linkedAudioPath && item.linkedAudioPathValid !== false) {
          return { ...item, hasAudiobook: true };
        }

        const expectedFilename = this.generateFilenameForItem(item.metadata).toLowerCase();
        let matchedPath: string | undefined;

        // Try exact match first
        matchedPath = completedMap.get(expectedFilename);

        // If no exact match, try fuzzy matching by author + title prefix
        if (!matchedPath && item.metadata) {
          const meta = item.metadata;
          const authorLast = normalize(meta.authorLast || (meta.author || '').split(' ').pop() || '');
          const titleStart = normalize((meta.title || '').split(/[-:,]/)[0]);

          for (const [filename, path] of completedMap) {
            const cfNorm = normalize(filename);
            if (cfNorm.includes(authorLast) && cfNorm.startsWith(titleStart)) {
              matchedPath = path;
              break;
            }
          }
        }

        return {
          ...item,
          hasAudiobook: !!matchedPath,
          linkedAudioPath: matchedPath  // Store auto-detected path
        };
      });

      // Sort: items without completed audiobook first, then completed at bottom
      return updated.sort((a, b) => {
        if (a.hasAudiobook === b.hasAudiobook) return 0;
        return a.hasAudiobook ? 1 : -1;
      });
    });
  }

  /**
   * Generate the expected audiobook filename from metadata
   */
  private generateFilenameForItem(meta: EpubMetadata): string {
    if (!meta) return 'audiobook.m4b';

    // Use custom output filename if set
    if (meta.outputFilename) {
      return meta.outputFilename.endsWith('.m4b')
        ? meta.outputFilename
        : meta.outputFilename + '.m4b';
    }

    let filename = meta.title || 'Untitled';

    if (meta.subtitle) {
      filename += ` - ${meta.subtitle}`;
    }

    filename += '.';

    // Use Last, First format
    if (meta.authorLast) {
      filename += ` ${meta.authorLast}`;
      if (meta.authorFirst) {
        filename += `, ${meta.authorFirst}`;
      }
      filename += '.';
    } else if (meta.authorFirst) {
      filename += ` ${meta.authorFirst}.`;
    } else if (meta.author) {
      // Parse author into Last, First
      const parts = meta.author.trim().split(' ');
      if (parts.length >= 2) {
        const last = parts.pop();
        filename += ` ${last}, ${parts.join(' ')}.`;
      } else {
        filename += ` ${meta.author}.`;
      }
    }

    if (meta.year) {
      filename += ` (${meta.year})`;
    }

    filename += '.m4b';

    // Clean up the filename
    return filename.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.');
  }

  /**
   * Handle manual audio file linking from the Metadata tab
   */
  async onLinkAudio(audioPath: string): Promise<void> {
    console.log('[Audiobook] onLinkAudio called with:', audioPath);
    const item = this.selectedItem();
    console.log('[Audiobook] Selected item:', item?.id, 'bfpPath:', item?.bfpPath);
    if (!item?.bfpPath || !this.electron) {
      console.error('[Audiobook] Cannot link audio - missing bfpPath or electron:', {
        hasBfpPath: !!item?.bfpPath,
        hasElectron: !!this.electron
      });
      return;
    }

    try {
      console.log('[Audiobook] Calling updateState with linkedAudioPath:', audioPath);
      // Save the linked path to BFP
      const result = await this.electron.audiobook.updateState(item.bfpPath, {
        linkedAudioPath: audioPath
      });
      console.log('[Audiobook] updateState result:', result);

      if (result.success) {
        // Update local state - file was just selected via dialog so it definitely exists
        this.queueItems.update(items =>
          items.map(i =>
            i.id === item.id
              ? { ...i, linkedAudioPath: audioPath, linkedAudioPathValid: true, hasAudiobook: true }
              : i
          )
        );
        console.log('[Audiobook] Linked audio file successfully:', audioPath);
      } else {
        console.error('[Audiobook] Failed to save linked audio path:', result.error);
      }
    } catch (err) {
      console.error('[Audiobook] Error linking audio file:', err);
    }
  }

  selectItem(id: string): void {
    this.selectedItemId.set(id);
    this.workflowState.set('metadata');
    // Clear preloaded resume info when user manually selects a queue item
    if (this.preloadedResumeInfo()) {
      this.preloadedResumeInfo.set(undefined);
    }
    // Check pipeline stages for the selected item
    this.checkPipelineStages();
  }

  /**
   * Format a session date for display
   */
  formatSessionDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        // Today - show time
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } else if (diffDays === 1) {
        return 'Yesterday';
      } else if (diffDays < 7) {
        return `${diffDays} days ago`;
      } else {
        // Show date
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    } catch {
      return '';
    }
  }

  async removeFromQueue(id: string): Promise<void> {
    // Find the item to get its projectId
    const item = this.queueItems().find(i => i.id === id);

    // Remove from UI immediately
    this.queueItems.update(items => items.filter(item => item.id !== id));
    if (this.selectedItemId() === id) {
      this.selectedItemId.set(null);
    }

    // Delete the project folder from disk if it has a projectId
    if (item?.projectId) {
      const result = await this.electronService.deleteAudiobookProject(item.projectId);
      if (!result.success) {
        console.error('[Audiobook] Failed to delete project folder:', result.error);
      }
    }
  }

  setWorkflowState(state: WorkflowState): void {
    this.workflowState.set(state);

    // Set diff paths when switching to diff tab
    if (state === 'diff') {
      const item = this.selectedItem();
      console.log('[Audiobook] setWorkflowState(diff) - item:', item?.id, 'hasCleaned:', item?.hasCleaned, 'path:', item?.path);
      if (item?.hasCleaned) {
        const pathNorm = item.path.replace(/\\/g, '/');
        const originalDir = pathNorm.substring(0, pathNorm.lastIndexOf('/'));
        const cleanedName = item.cleanedFilename || 'cleaned.epub';
        const paths = {
          originalPath: `${originalDir}/exported.epub`,
          cleanedPath: `${originalDir}/${cleanedName}`
        };
        console.log('[Audiobook] Setting diffPaths:', paths);
        this.diffPaths.set(paths);
      } else {
        console.log('[Audiobook] NOT setting diffPaths - hasCleaned is false');
        this.diffPaths.set(null);
      }
    }
  }

  /**
   * Clear preloaded resume info and navigate back to Past Sessions
   */
  clearResumeAndGoBack(): void {
    this.preloadedResumeInfo.set(undefined);
    this.router.navigate(['/reassembly']);
  }

  onMetadataChange(metadata: EpubMetadata): void {
    const id = this.selectedItemId();
    if (!id) return;

    // Update metadata (audiobook status is preserved - it's based on linkedAudioPath)
    this.queueItems.update(items =>
      items.map(item =>
        item.id === id ? { ...item, metadata } : item
      )
    );
  }

  onCoverChange(coverData: string): void {
    // Cover is stored in metadata, will be saved with saveMetadata
  }

  async onSaveMetadata(metadata: EpubMetadata): Promise<void> {
    const item = this.selectedItem();
    if (!item || !this.electron) return;

    this.savingMetadata.set(true);

    try {
      // Save to BFP file if available (unified system), otherwise fall back to old project.json
      const result = item.bfpPath
        ? await this.electron.project.updateMetadata(item.bfpPath, metadata)
        : await this.electron.library.saveMetadata(item.path, metadata);
      if (result.success) {
        // Update local state
        this.onMetadataChange(metadata);
      } else {
        console.error('Failed to save metadata to project:', result.error);
      }

      // Also save metadata to the EPUB file itself (for ebook2audiobook to read)
      // This ensures the TTS conversion gets the correct metadata
      const epubMetaSaved = await this.epubService.setMetadata({
        title: metadata.title,
        author: metadata.author,
        year: metadata.year,
        language: metadata.language
      });
      if (!epubMetaSaved) {
        console.warn('[Audiobook] Failed to save metadata to EPUB - will be missing during TTS conversion');
      }
    } catch (err) {
      console.error('Failed to save metadata:', err);
    } finally {
      this.savingMetadata.set(false);
    }
  }

  onCleanupComplete(): void {
    // Move to convert step after cleanup
    this.workflowState.set('convert');
  }

  onTranslationQueued(): void {
    // Optionally move to AI Cleanup after translation is queued
    // User may want to add cleanup job next
    this.workflowState.set('cleanup');
  }

  onTtsSettingsChange(settings: TTSSettings): void {
    this.ttsSettings.set(settings);
  }

  onEnhanceJobQueued(jobId: string): void {
    // Update the item's enhancement status to pending
    const id = this.selectedItemId();
    if (!id) return;

    this.queueItems.update(items =>
      items.map(item =>
        item.id === id
          ? { ...item, enhancementStatus: 'pending' as const, enhancementJobId: jobId }
          : item
      )
    );

    console.log('[Audiobook] Enhancement job queued:', jobId);
  }

  onChaptersApplied(result: { success: boolean; outputPath?: string; chaptersApplied?: number; error?: string }): void {
    if (result.success) {
      console.log('[Audiobook] Chapters applied successfully:', result.chaptersApplied, 'chapters');
      // Optionally refresh the queue to update UI
      this.loadQueue();
    } else {
      console.error('[Audiobook] Failed to apply chapters:', result.error);
    }
  }

  async onDiffTextEdited(event: { chapterId: string; oldText: string; newText: string }): Promise<void> {
    const paths = this.diffPaths();
    if (!paths?.cleanedPath || !this.electron) return;

    // Save the edit to the cleaned EPUB
    const result = await this.electron.epub.editText(
      paths.cleanedPath,
      event.chapterId,
      event.oldText,
      event.newText
    );

    if (result.success) {
      console.log('Text edit saved to EPUB');
    } else {
      console.error('Failed to save text edit:', result.error);
    }
  }

  async onShowInFinder(): Promise<void> {
    if (!this.electron) return;

    try {
      const item = this.selectedItem();

      // Show the specific audiobook file in its BFP folder
      if (item?.linkedAudioPath) {
        await this.electron.shell.showItemInFolder(item.linkedAudioPath);
      } else if (item?.audiobookFolder) {
        await this.electron.shell.openPath(item.audiobookFolder);
      }
    } catch (err) {
      console.error('Error opening audiobook location:', err);
    }
  }

  async exportEpub(): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    // Determine which EPUB to export (cleaned if available, otherwise original)
    const epubPath = this.currentEpubPath();
    if (!epubPath) return;

    // Generate default filename from metadata
    const meta = this.selectedMetadata();
    let defaultName = 'book.epub';
    if (meta?.title) {
      defaultName = meta.title;
      if (meta.author) {
        defaultName += ` - ${meta.author}`;
      }
      defaultName += '.epub';
      // Clean filename of invalid characters
      defaultName = defaultName.replace(/[<>:"/\\|?*]/g, '');
    }

    // Show save dialog
    const dialogResult = await this.electronService.showSaveEpubDialog(defaultName);
    if (!dialogResult.success || dialogResult.canceled || !dialogResult.filePath) {
      return;
    }

    // Copy the EPUB to the selected location
    const copyResult = await this.electronService.copyFile(epubPath, dialogResult.filePath);
    if (copyResult.success) {
      console.log('EPUB exported to:', dialogResult.filePath);
    } else {
      console.error('Failed to export EPUB:', copyResult.error);
    }
  }

  /**
   * Get the cover path for the currently selected item
   * Cover path is already resolved to full filesystem path in metadata
   */
  getSelectedCoverPath(): string | undefined {
    const item = this.selectedItem();
    // coverPath in metadata is now the full filesystem path
    return item?.metadata?.coverPath;
  }

  // Pipeline Management Methods

  /**
   * Check and update pipeline stages when an item is selected
   */
  private async checkPipelineStages(): Promise<void> {
    const item = this.selectedItem();
    if (!item?.bfpPath) return;

    const projectPath = item.bfpPath; // bfpPath is actually the project directory

    // Check for cleanup stage
    const cleanupPath = `${projectPath}/stages/01-cleanup`;
    const hasCleanup = await this.electron?.fs.exists(cleanupPath) ?? false;
    this.hasPipelineCleanup.set(hasCleanup);

    // Check for translation stage
    const translatePath = `${projectPath}/stages/02-translate`;
    const hasTranslation = await this.electron?.fs.exists(translatePath) ?? false;
    this.hasPipelineTranslation.set(hasTranslation);

    // Check for TTS cache and get languages
    const ttsPath = `${projectPath}/stages/03-tts/sessions`;
    const ttsList = await this.electron?.fs.listDir(ttsPath);
    if (ttsList?.success && ttsList.files) {
      const languages = ttsList.files
        .filter((f: any) => f.isDirectory)
        .map((f: any) => f.name);
      this.ttsCacheLanguages.set(languages);
      this.hasPipelineTTS.set(languages.length > 0);
    } else {
      this.ttsCacheLanguages.set([]);
      this.hasPipelineTTS.set(false);
    }
  }

  /**
   * Delete AI cleanup stage files
   */
  async deleteCleanupStage(): Promise<void> {
    const item = this.selectedItem();
    if (!item?.bfpPath || !this.electron) return;

    this.deletingCleanup.set(true);
    try {
      const result = await this.electron.pipeline.deleteCleanup(item.bfpPath);
      if (result.success) {
        console.log('[PIPELINE] Cleanup stage deleted:', result.message);
        this.hasPipelineCleanup.set(false);
        // Also update the item to reflect the change
        item.hasCleaned = false;
        item.cleanedFilename = undefined;
        item.skippedChunksPath = undefined;
      } else {
        console.error('[PIPELINE] Failed to delete cleanup stage:', result.error);
      }
    } finally {
      this.deletingCleanup.set(false);
    }
  }

  /**
   * Delete translation stage files
   */
  async deleteTranslationStage(): Promise<void> {
    const item = this.selectedItem();
    if (!item?.bfpPath || !this.electron) return;

    this.deletingTranslation.set(true);
    try {
      const result = await this.electron.pipeline.deleteTranslation(item.bfpPath);
      if (result.success) {
        console.log('[PIPELINE] Translation stage deleted:', result.message);
        this.hasPipelineTranslation.set(false);
      } else {
        console.error('[PIPELINE] Failed to delete translation stage:', result.error);
      }
    } finally {
      this.deletingTranslation.set(false);
    }
  }

  /**
   * Delete TTS cache for a specific language or all languages
   */
  async deleteTTSCache(language?: string): Promise<void> {
    const item = this.selectedItem();
    if (!item?.bfpPath || !this.electron) return;

    this.deletingTTS.set(true);
    try {
      const result = await this.electron.pipeline.deleteTtsCache(item.bfpPath, language);
      if (result.success) {
        console.log('[PIPELINE] TTS cache deleted:', result.message);

        if (language && result.deletedSessions) {
          // Remove specific language from the list
          const currentLanguages = this.ttsCacheLanguages();
          const updatedLanguages = currentLanguages.filter(l => l !== language);
          this.ttsCacheLanguages.set(updatedLanguages);
          this.hasPipelineTTS.set(updatedLanguages.length > 0);
        } else {
          // All caches deleted
          this.ttsCacheLanguages.set([]);
          this.hasPipelineTTS.set(false);
        }
      } else {
        console.error('[PIPELINE] Failed to delete TTS cache:', result.error);
      }
    } finally {
      this.deletingTTS.set(false);
    }
  }

  /**
   * Delete all pipeline stages
   */
  async deleteAllPipelineStages(): Promise<void> {
    const item = this.selectedItem();
    if (!item?.bfpPath || !this.electron) return;

    // Simple confirmation using browser confirm
    const confirmed = confirm('Are you sure you want to delete all pipeline stages?\n\nThis will remove all AI cleanup files, translations, and TTS caches. You\'ll need to re-run the entire workflow.');

    if (!confirmed) return;

    this.deletingAll.set(true);
    try {
      const result = await this.electron.pipeline.deleteAll(item.bfpPath);
      if (result.success) {
        console.log('[PIPELINE] All stages deleted:', result.message);

        // Update all states
        this.hasPipelineCleanup.set(false);
        this.hasPipelineTranslation.set(false);
        this.hasPipelineTTS.set(false);
        this.ttsCacheLanguages.set([]);

        // Update item state
        item.hasCleaned = false;
        item.cleanedFilename = undefined;
        item.skippedChunksPath = undefined;
      } else {
        console.error('[PIPELINE] Failed to delete all stages:', result.error);
      }
    } finally {
      this.deletingAll.set(false);
    }
  }
}

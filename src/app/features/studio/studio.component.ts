import { Component, inject, signal, computed, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem
} from '../../creamsicle-desktop';
import { StudioService } from './services/studio.service';
import { StudioItem, StudioWorkflowState, ProcessStep } from './models/studio.types';
import { StudioListComponent } from './components/studio-list/studio-list.component';
import { AddModalComponent } from './components/add-modal/add-modal.component';
import { ContentEditorComponent } from './components/content-editor/content-editor.component';
import { ProcessWizardComponent } from './components/process-wizard/process-wizard.component';

// Import existing audiobook components
import { MetadataEditorComponent, EpubMetadata } from '../audiobook/components/metadata-editor/metadata-editor.component';
import { TTSSettings } from '../audiobook/components/tts-settings/tts-settings.component';
import { DiffViewComponent } from '../audiobook/components/diff-view/diff-view.component';
import { PlayViewComponent } from '../audiobook/components/play-view/play-view.component';
import { SkippedChunksPanelComponent } from '../audiobook/components/skipped-chunks-panel/skipped-chunks-panel.component';
import { PostProcessingPanelComponent } from '../audiobook/components/post-processing-panel/post-processing-panel.component';
import { ChapterRecoveryComponent } from '../audiobook/components/chapter-recovery/chapter-recovery.component';
import { BilingualPlayerComponent } from '../language-learning/components/bilingual-player/bilingual-player.component';
import { AudiobookPlayerComponent } from './components/audiobook-player/audiobook-player.component';
// Note: AnalyticsPanelComponent not used yet - will add in future iteration

import { EpubService } from '../audiobook/services/epub.service';
import { AudiobookService } from '../audiobook/services/audiobook.service';
import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { SettingsService } from '../../core/services/settings.service';

/**
 * StudioComponent - Unified workspace for books and articles
 *
 * Combines the functionality of:
 * - Audiobook Producer (books)
 * - Language Learning (articles)
 *
 * Features:
 * - Single "+" button to add EPUBs or URLs
 * - Accordion list for Articles and Books
 * - Unified workflow tabs
 */
@Component({
  selector: 'app-studio',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    StudioListComponent,
    AddModalComponent,
    ContentEditorComponent,
    ProcessWizardComponent,
    MetadataEditorComponent,
    DiffViewComponent,
    PlayViewComponent,
    SkippedChunksPanelComponent,
    PostProcessingPanelComponent,
    ChapterRecoveryComponent,
    BilingualPlayerComponent,
    AudiobookPlayerComponent
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="studio-container">
      <desktop-split-pane [primarySize]="280" [minSize]="200" [maxSize]="500">
        <!-- Left Panel: List -->
        <div pane-primary class="list-panel">
          <div class="panel-header">
            <h3>Studio</h3>
            <button class="btn-add" (click)="showAddModal.set(true)" title="Add Content">
              +
            </button>
          </div>
          <app-studio-list
            [articles]="studioService.articles()"
            [books]="studioService.books()"
            [selectedId]="selectedItemId()"
            (select)="selectItem($event)"
            (contextMenu)="onContextMenu($event)"
          />
        </div>

        <!-- Right Panel: Workflow -->
        <div pane-secondary class="workflow-panel">
          @if (selectedItem()) {
            <!-- Workflow Tabs -->
            <div class="workflow-tabs-container">
              <div class="workflow-tabs">
                <button
                  class="tab"
                  [class.active]="workflowState() === 'metadata'"
                  (click)="setWorkflowState('metadata')"
                >
                  Metadata
                </button>
                @if (selectedItem()!.type === 'article') {
                  <button
                    class="tab"
                    [class.active]="workflowState() === 'content'"
                    (click)="setWorkflowState('content')"
                  >
                    Content
                  </button>
                }
                <button
                  class="tab"
                  [class.active]="workflowState() === 'process'"
                  (click)="setWorkflowState('process')"
                >
                  Process
                </button>
                <button
                  class="tab"
                  [class.active]="workflowState() === 'stream'"
                  (click)="setWorkflowState('stream')"
                >
                  Stream
                </button>
                <button
                  class="tab"
                  [class.active]="workflowState() === 'play'"
                  [class.disabled]="!hasAudioToPlay()"
                  (click)="handleTabClick('play', hasAudioToPlay(), 'No audiobook yet. Run TTS conversion first.')"
                >
                  Play
                </button>
                <button
                  class="tab"
                  [class.active]="workflowState() === 'diff'"
                  [class.disabled]="!selectedItem()!.hasCleaned"
                  (click)="handleTabClick('diff', selectedItem()!.hasCleaned, 'No cleaned version yet. Run AI Cleanup first.')"
                >
                  Review
                </button>
                @if (selectedItem()!.skippedChunksPath) {
                  <button
                    class="tab warning"
                    [class.active]="workflowState() === 'skipped'"
                    (click)="setWorkflowState('skipped')"
                  >
                    Skipped
                  </button>
                }
                <button
                  class="tab"
                  [class.active]="workflowState() === 'enhance'"
                  [class.disabled]="!selectedItem()!.audiobookPath"
                  (click)="handleTabClick('enhance', !!selectedItem()!.audiobookPath, 'No audiobook yet. Run TTS conversion first.')"
                >
                  Enhance
                </button>
                <button
                  class="tab"
                  [class.active]="workflowState() === 'chapters'"
                  [class.disabled]="!selectedItem()!.vttPath"
                  (click)="handleTabClick('chapters', !!selectedItem()!.vttPath, 'No chapter data yet. Run TTS conversion first.')"
                >
                  Chapters
                </button>

                <!-- Finalize button for articles on Content tab only -->
                @if (selectedItem()!.type === 'article' && workflowState() === 'content') {
                  <button
                    class="btn-finalize"
                    [class.saving]="finalizingContent() === 'saving'"
                    [class.done]="finalizingContent() === 'done'"
                    [disabled]="finalizingContent() === 'saving'"
                    (click)="finalizeContent()"
                    title="Finalize content for processing"
                  >
                    @switch (finalizingContent()) {
                      @case ('saving') { Saving... }
                      @case ('done') { Done! }
                      @default { Finalize }
                    }
                  </button>
                }
              </div>

              <!-- Disabled tab message -->
              @if (disabledTabMessage()) {
                <div class="disabled-tab-message">
                  {{ disabledTabMessage() }}
                </div>
              }
            </div>

            <!-- Tab Content -->
            <div class="tab-content" [class.content-tab]="workflowState() === 'content'" [class.play-tab]="workflowState() === 'play'" [class.process-tab]="workflowState() === 'process'">
              @switch (workflowState()) {
                @case ('content') {
                  <app-content-editor
                    [item]="selectedItem()"
                    (itemChanged)="onItemChanged()"
                  />
                }
                @case ('metadata') {
                  <app-metadata-editor
                    [metadata]="selectedMetadata()"
                    [saving]="savingMetadata()"
                    [audioFilePath]="audioFilePath() || ''"
                    [audioFilePathValid]="audioFilePathValid()"
                    [epubPath]="selectedItem()?.epubPath || ''"
                    [cleanedEpubPath]="selectedItem()?.cleanedEpubPath || ''"
                    (metadataChange)="onMetadataChange($event)"
                    (coverChange)="onCoverChange($event)"
                    (save)="onSaveMetadata($event)"
                    (showInFinder)="onShowInFinder()"
                    (linkAudio)="onLinkAudio($event)"
                    (showEpubInFinder)="onShowEpubInFinder($event)"
                  />
                }
                @case ('process') {
                  @if (currentEpubPath()) {
                    <app-process-wizard
                      [epubPath]="currentEpubPath()"
                      [originalEpubPath]="selectedItem()?.epubPath || ''"
                      [title]="selectedMetadata()?.title || ''"
                      [author]="selectedMetadata()?.author || ''"
                      [itemType]="selectedItem()?.type || 'book'"
                      [bfpPath]="selectedItem()?.bfpPath || ''"
                      [projectId]="selectedItem()?.id || ''"
                      [projectDir]="getProjectDir()"
                      [sourceLang]="selectedItem()?.sourceLang || 'en'"
                      [textContent]="selectedItem()?.textContent || ''"
                      (queued)="onProcessQueued()"
                    />
                  } @else {
                    <div class="empty-process">
                      <div class="icon">📄</div>
                      <p>No EPUB available for processing.</p>
                      @if (selectedItem()?.type === 'article') {
                        <p class="hint">Click "Finalize" on the Content tab to generate an EPUB.</p>
                      }
                    </div>
                  }
                }
                @case ('stream') {
                  <!-- Live TTS streaming -->
                  @if (currentEpubPath()) {
                    <app-play-view
                      [epubPath]="currentEpubPath()"
                    />
                  } @else {
                    <div class="empty-player">
                      <div class="icon">🎧</div>
                      <p>No EPUB available for streaming.</p>
                    </div>
                  }
                }
                @case ('play') {
                  <!-- Play existing audiobook with VTT sync -->
                  @if (selectedItem()?.type === 'article') {
                    <app-bilingual-player
                      [audiobook]="audiobookData()"
                    />
                  } @else if (bookAudioData()) {
                    <app-audiobook-player
                      [audiobook]="bookAudioData()"
                    />
                  } @else {
                    <div class="empty-player">
                      <div class="icon">🎧</div>
                      <p>No audiobook available. Link an audio file in Metadata tab.</p>
                    </div>
                  }
                }
                @case ('diff') {
                  <app-diff-view
                    [originalPath]="selectedItem()?.epubPath || ''"
                    [cleanedPath]="selectedItem()?.cleanedEpubPath || ''"
                  />
                }
                @case ('skipped') {
                  <app-skipped-chunks-panel
                    [skippedChunksPath]="selectedItem()?.skippedChunksPath ?? null"
                    [cleanedEpubPath]="selectedItem()?.cleanedEpubPath ?? null"
                    [originalEpubPath]="selectedItem()?.epubPath ?? null"
                  />
                }
                @case ('enhance') {
                  <app-post-processing-panel
                    [audioFilePath]="selectedItem()?.audiobookPath || ''"
                    [bfpPath]="selectedItem()?.bfpPath || ''"
                    [bookTitle]="selectedMetadata()?.title || ''"
                    [bookAuthor]="selectedMetadata()?.author || ''"
                  />
                }
                @case ('chapters') {
                  @if (selectedItem()?.audiobookPath && selectedItem()?.vttPath) {
                    <app-chapter-recovery
                      [epubPath]="currentEpubPath()"
                      [vttPath]="selectedItem()!.vttPath!"
                      [m4bPath]="selectedItem()!.audiobookPath!"
                    />
                  }
                }
              }
            </div>
          } @else {
            <!-- Empty State -->
            <div class="empty-state">
              <div class="empty-icon">🎧</div>
              <h2>Welcome to Studio</h2>
              <p>Create audiobooks from EPUBs or web articles.</p>
              <button class="btn-primary btn-large" (click)="showAddModal.set(true)">
                Add Content
              </button>
            </div>
          }
        </div>
      </desktop-split-pane>
    </div>

    <!-- Add Modal -->
    @if (showAddModal()) {
      <app-add-modal
        (close)="showAddModal.set(false)"
        (added)="onItemAdded($event)"
      />
    }

    <!-- Context Menu -->
    @if (contextMenuVisible()) {
      <div
        class="context-menu"
        [style.top.px]="contextMenuY()"
        [style.left.px]="contextMenuX()"
        (click)="hideContextMenu()"
      >
        <button class="context-menu-item" (click)="deleteContextMenuItem()">
          Delete
        </button>
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .studio-container {
      flex: 1;
      overflow: hidden;
    }

    .list-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-surface);
      overflow: hidden;

      app-studio-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;  /* Important for flex children to scroll */
      }
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-elevated);

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-add {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }
    }

    .workflow-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }

    .workflow-tabs-container {
      overflow-x: auto;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;

      &::-webkit-scrollbar {
        height: 4px;
      }
      &::-webkit-scrollbar-thumb {
        background: var(--border-default);
        border-radius: 2px;
      }
    }

    .workflow-tabs {
      display: flex;
      gap: 2px;
      padding: 12px 16px 0;
      white-space: nowrap;
      min-width: max-content;
    }

    .tab {
      padding: 8px 16px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-bottom: -1px;
      flex-shrink: 0;

      &:hover {
        color: var(--text-primary);
      }

      &.active {
        color: var(--color-primary);
        border-bottom-color: var(--color-primary);
      }

      &.warning {
        color: #eab308;

        &.active {
          border-bottom-color: #eab308;
        }
      }

      &.disabled {
        color: var(--text-muted);
        opacity: 0.5;
        cursor: not-allowed;

        &:hover {
          color: var(--text-muted);
        }
      }
    }

    .disabled-tab-message {
      padding: 8px 16px;
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 6px;
      color: #eab308;
      font-size: 13px;
      margin-left: auto;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .btn-finalize {
      margin-left: auto;
      padding: 6px 16px;
      background: #06b6d4;
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
      min-width: 80px;

      &:hover {
        background: #0891b2;
      }

      &.saving {
        background: #64748b;
        cursor: wait;
      }

      &.done {
        background: #22c55e;
      }

      &:disabled {
        cursor: wait;
      }
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 16px;

      &.content-tab,
      &.play-tab {
        padding: 0;
        overflow: hidden;  /* These handle their own scrolling */
      }

      &.process-tab {
        padding: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;  /* Process container handles scrolling */
      }
    }

    /* Process Pipeline Styles */
    .process-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .process-steps {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 24px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      gap: 8px;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 20px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: rgba(6, 182, 212, 0.15);
        border-color: var(--color-primary);

        .step-number {
          background: var(--color-primary);
          color: white;
        }

        .step-label {
          color: var(--color-primary);
          font-weight: 600;
        }
      }

      &.completed {
        .step-number {
          background: #22c55e;
          color: white;

          &::after {
            content: '✓';
            position: absolute;
            font-size: 10px;
          }
        }
      }

      &.completed .step-number span {
        visibility: hidden;
      }
    }

    .step-number {
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
      position: relative;
    }

    .step-label {
      font-size: 13px;
      color: var(--text-primary);
    }

    .step-connector {
      width: 32px;
      height: 2px;
      background: var(--border-default);
    }

    .process-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      position: relative;
    }

    .step-actions {
      display: flex;
      justify-content: space-between;
      padding: 16px 0 0;
      margin-top: 16px;
      border-top: 1px solid var(--border-subtle);
    }

    .btn-back,
    .btn-skip {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
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
      border: 1px solid var(--color-primary);
      color: var(--color-primary);
      margin-left: auto;

      &:hover {
        background: rgba(6, 182, 212, 0.1);
      }
    }

    .empty-player,
    .empty-process {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      padding: 40px;

      .icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.5;
      }

      p {
        font-size: 14px;
        text-align: center;
        margin: 0;

        &.hint {
          margin-top: 8px;
          font-size: 12px;
          color: var(--text-secondary);
        }
      }
    }

    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 40px;

      .empty-icon {
        font-size: 64px;
        margin-bottom: 20px;
      }

      h2 {
        margin: 0 0 8px;
        font-size: 24px;
        font-weight: 600;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 24px;
        font-size: 15px;
        color: var(--text-secondary);
      }
    }

    .btn-primary {
      padding: 12px 24px;
      background: var(--color-primary);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--color-primary-hover);
      }
    }

    .btn-large {
      padding: 14px 28px;
      font-size: 15px;
    }

    .context-menu {
      position: fixed;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      min-width: 120px;
      padding: 4px 0;
    }

    .context-menu-item {
      display: block;
      width: 100%;
      padding: 8px 16px;
      background: none;
      border: none;
      text-align: left;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
      }

      &.danger {
        color: var(--color-error);
      }
    }
  `]
})
export class StudioComponent implements OnInit {
  readonly studioService = inject(StudioService);
  private readonly epubService = inject(EpubService);
  private readonly audiobookService = inject(AudiobookService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly settingsService = inject(SettingsService);

  @ViewChild(ContentEditorComponent) contentEditor?: ContentEditorComponent;

  // State
  readonly showAddModal = signal<boolean>(false);
  readonly selectedItemId = signal<string | null>(null);
  readonly workflowState = signal<StudioWorkflowState>('empty');
  readonly processStep = signal<ProcessStep>('cleanup');
  readonly savingMetadata = signal<boolean>(false);
  readonly finalizingContent = signal<'idle' | 'saving' | 'done'>('idle');
  readonly disabledTabMessage = signal<string | null>(null);

  // Context menu
  readonly contextMenuVisible = signal<boolean>(false);
  readonly contextMenuX = signal<number>(0);
  readonly contextMenuY = signal<number>(0);
  private contextMenuItem: StudioItem | null = null;

  // Computed
  readonly selectedItem = computed<StudioItem | null>(() => {
    const id = this.selectedItemId();
    if (!id) return null;
    return this.studioService.getItem(id) ?? null;
  });

  readonly selectedMetadata = computed<EpubMetadata | null>(() => {
    const item = this.selectedItem();
    if (!item) return null;
    return {
      title: item.title,
      author: item.author || '',
      year: undefined,
      language: item.sourceLang || 'en',
      coverPath: item.coverPath,
      coverData: item.coverData
    };
  });

  readonly currentEpubPath = computed<string>(() => {
    const item = this.selectedItem();
    if (!item) return '';
    // Use cleaned EPUB if available, otherwise original
    return item.cleanedEpubPath || item.epubPath || '';
  });

  readonly audioFilePath = computed<string | undefined>(() => {
    return this.selectedItem()?.audiobookPath;
  });

  // Data for bilingual player (articles with VTT)
  readonly audiobookData = computed(() => {
    const item = this.selectedItem();
    if (!item || item.type !== 'article') return null;
    // Only return data if audiobook actually exists
    if (!item.audiobookPath || !item.vttPath) return null;
    return {
      id: item.id,
      title: item.title,
      sourceLang: item.sourceLang,
      targetLang: item.targetLang,
      audiobookPath: item.audiobookPath,
      vttPath: item.vttPath
    };
  });

  // Data for book audio player (books with VTT)
  readonly bookAudioData = computed(() => {
    const item = this.selectedItem();
    if (!item || item.type !== 'book') return null;
    // Must have at least mono OR bilingual audio with VTT
    const hasMono = !!item.audiobookPath && !!item.vttPath;
    const hasBilingual = !!item.bilingualAudioPath && !!item.bilingualVttPath;
    if (!hasMono && !hasBilingual) return null;
    return {
      id: item.id,
      title: item.title,
      author: item.author,
      audiobookPath: item.audiobookPath,
      vttPath: item.vttPath,
      // Bilingual audio paths (separate from mono)
      bilingualAudioPath: item.bilingualAudioPath,
      bilingualVttPath: item.bilingualVttPath
    };
  });

  // Check if any item (book or article) has audio ready to play
  readonly hasAudioToPlay = computed(() => {
    return !!this.bookAudioData() || !!this.audiobookData();
  });

  readonly audioFilePathValid = computed(() => {
    const item = this.selectedItem();
    // The audiobookPath is only set if the file exists (checked in StudioService)
    return !!item?.audiobookPath;
  });

  readonly ttsSettings = signal<TTSSettings>({
    device: 'cpu',  // CPU is better for XTTS on Mac
    language: 'en',
    ttsEngine: 'orpheus',
    fineTuned: 'tara',
    temperature: 0.75,
    topP: 0.85,
    topK: 50,
    repetitionPenalty: 5.0,
    speed: 1.0,
    enableTextSplitting: true
  });

  // Toolbar
  readonly toolbarItems = computed<ToolbarItem[]>(() => [
    {
      id: 'refresh',
      type: 'button',
      icon: '↻',
      label: 'Refresh',
      tooltip: 'Reload items'
    }
  ]);

  /**
   * Get the project directory for the currently selected article
   */
  getProjectDir(): string {
    const item = this.selectedItem();
    if (!item || item.type !== 'article') return '';
    const articlesPath = this.libraryService.articlesPath();
    if (!articlesPath) return '';
    return `${articlesPath}/${item.id}`;
  }

  async ngOnInit(): Promise<void> {
    await this.libraryService.whenReady();
    await this.studioService.loadAll();

    // Hide context menu on click outside
    document.addEventListener('click', () => this.hideContextMenu());
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'refresh':
        this.studioService.loadAll();
        break;
    }
  }

  selectItem(item: StudioItem): void {
    this.selectedItemId.set(item.id);

    // Always start on metadata tab
    this.setWorkflowState('metadata');

    // Reset finalize state when selecting new item
    this.finalizingContent.set('idle');
  }

  setWorkflowState(state: StudioWorkflowState): void {
    this.workflowState.set(state);
    // Reset process step when entering process tab
    if (state === 'process') {
      this.processStep.set('cleanup');
    }
  }

  // Handle clicking on tabs that may be disabled
  handleTabClick(state: StudioWorkflowState, isEnabled: boolean | undefined, disabledMessage: string): void {
    if (isEnabled) {
      this.setWorkflowState(state);
      this.disabledTabMessage.set(null);
    } else {
      this.disabledTabMessage.set(disabledMessage);
      // Auto-clear message after 3 seconds
      setTimeout(() => {
        if (this.disabledTabMessage() === disabledMessage) {
          this.disabledTabMessage.set(null);
        }
      }, 3000);
    }
  }

  setProcessStep(step: ProcessStep): void {
    this.processStep.set(step);
  }

  onItemAdded(item: StudioItem): void {
    // Select the newly added item
    this.selectItem(item);
  }

  onItemChanged(): void {
    // Item was modified, could trigger reload
  }

  // Context Menu
  onContextMenu(event: { event: MouseEvent; item: StudioItem }): void {
    event.event.preventDefault();
    this.contextMenuItem = event.item;
    this.contextMenuX.set(event.event.clientX);
    this.contextMenuY.set(event.event.clientY);
    this.contextMenuVisible.set(true);
  }

  hideContextMenu(): void {
    this.contextMenuVisible.set(false);
  }

  async deleteContextMenuItem(): Promise<void> {
    if (!this.contextMenuItem) return;

    const result = await this.studioService.deleteItem(this.contextMenuItem.id);
    if (result.success) {
      // Clear selection if deleted item was selected
      if (this.selectedItemId() === this.contextMenuItem.id) {
        this.selectedItemId.set(null);
        this.workflowState.set('empty');
      }
    }

    this.hideContextMenu();
  }

  // Metadata handlers
  onMetadataChange(metadata: EpubMetadata): void {
    // Handle metadata changes
  }

  onCoverChange(coverPath: string): void {
    // Handle cover changes
  }

  async onSaveMetadata(metadata: EpubMetadata): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    this.savingMetadata.set(true);
    try {
      // Save metadata via epub service
      if (item.epubPath) {
        await this.epubService.open(item.epubPath);
        await this.epubService.setMetadata(metadata);
        await this.epubService.close();
      }
    } finally {
      this.savingMetadata.set(false);
    }
  }

  onShowInFinder(): void {
    const item = this.selectedItem();
    if (!item?.audiobookPath) return;

    (window as any).electron?.shell?.showItemInFolder?.(item.audiobookPath);
  }

  onShowEpubInFinder(path: string): void {
    if (!path) return;
    (window as any).electron?.shell?.showItemInFolder?.(path);
  }

  async onLinkAudio(path: string): Promise<void> {
    console.log('[Studio] === onLinkAudio CALLED ===');
    console.log('[Studio] Received path:', path);

    const item = this.selectedItem();
    console.log('[Studio] Selected item:', item?.id, item?.title);
    console.log('[Studio] Item bfpPath:', item?.bfpPath);

    if (!item?.bfpPath) {
      console.error('[Studio] Cannot link audio: no BFP path');
      return;
    }

    console.log('[Studio] Calling audiobookLinkAudio...');
    const result = await this.electronService.audiobookLinkAudio(item.bfpPath, path);
    console.log('[Studio] audiobookLinkAudio result:', result);

    if (result.success) {
      console.log('[Studio] Audio linked successfully, reloading...');
      // Reload the books to pick up the new linked audio path
      await this.studioService.loadBooks();
      console.log('[Studio] Books reloaded');
    } else {
      console.error('[Studio] Failed to link audio:', result.error);
    }
  }

  // Translation handlers
  onTranslationQueued(): void {
    this.studioService.reloadItem(this.selectedItemId()!);
  }

  // Cleanup handlers
  onCleanupComplete(): void {
    this.studioService.reloadItem(this.selectedItemId()!);
  }

  // TTS handlers
  onTtsSettingsChange(settings: TTSSettings): void {
    this.ttsSettings.set(settings);
  }

  onTtsQueued(): void {
    this.studioService.reloadItem(this.selectedItemId()!);
  }

  onProcessQueued(): void {
    this.studioService.reloadItem(this.selectedItemId()!);
  }

  /**
   * Finalize article content for processing
   * This saves the current deleted selectors and marks content as finalized
   */
  async finalizeContent(): Promise<void> {
    const item = this.selectedItem();
    if (!item || item.type !== 'article') return;

    this.finalizingContent.set('saving');

    try {
      // Get the filtered HTML from the content editor (applies deleted selectors)
      let finalizedHtml = '';
      if (this.contentEditor) {
        finalizedHtml = await this.contentEditor.getFilteredHtml();
      }

      // Save the finalized content
      await this.studioService.finalizeArticleContent(item.id, finalizedHtml);

      // Reload to pick up changes
      await this.studioService.reloadItem(item.id);

      // Show success state
      this.finalizingContent.set('done');

      // Navigate to Process tab after successful finalize
      this.setWorkflowState('process');

      // Reset finalize button state
      setTimeout(() => {
        this.finalizingContent.set('idle');
      }, 500);
    } catch (e) {
      console.error('[Studio] Failed to finalize content:', e);
      this.finalizingContent.set('idle');
    }
  }
}

import { Component, inject, signal, computed, effect, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent
} from '../../creamsicle-desktop';
import { StudioService } from './services/studio.service';
import { StudioItem, MainTab, AudiobookSubTab, LanguageLearningSubTab, ProcessStep } from './models/studio.types';
import { StudioListComponent } from './components/studio-list/studio-list.component';
import { AddModalComponent } from './components/add-modal/add-modal.component';
import { ContentEditorComponent } from './components/content-editor/content-editor.component';
import { ProcessWizardComponent } from './components/process-wizard/process-wizard.component';
import { LLWizardComponent } from '../language-learning/components/ll-wizard/ll-wizard.component';

// Import existing audiobook components
import { MetadataEditorComponent, EpubMetadata } from '../audiobook/components/metadata-editor/metadata-editor.component';
import { TTSSettings } from './models/tts.types';
import { DiffViewComponent } from '../audiobook/components/diff-view/diff-view.component';
import { PlayViewComponent } from '../audiobook/components/play-view/play-view.component';
import { SkippedChunksPanelComponent } from '../audiobook/components/skipped-chunks-panel/skipped-chunks-panel.component';
import { PostProcessingPanelComponent } from '../audiobook/components/post-processing-panel/post-processing-panel.component';
import { ChapterRecoveryComponent } from '../audiobook/components/chapter-recovery/chapter-recovery.component';
import { BilingualPlayerComponent } from '../language-learning/components/bilingual-player/bilingual-player.component';
import { AudiobookPlayerComponent } from './components/audiobook-player/audiobook-player.component';
import { VersionPickerDialogComponent, VersionPickerDialogData } from './components/version-picker-dialog/version-picker-dialog.component';
import { ProjectFilesComponent, DiffRequest } from './components/project-files/project-files.component';
import { ProjectVersion } from './models/project-version.types';

import { EpubService } from '../audiobook/services/epub.service';
import { AudiobookService } from '../audiobook/services/audiobook.service';
import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { SettingsService } from '../../core/services/settings.service';

/**
 * StudioComponent - Unified workspace for books and articles
 *
 * Navigation Structure:
 * - Main Tabs: Metadata | Content (articles) | Audiobook | Language Learning
 * - Audiobook Sub-tabs: Process | Stream | Play | Review | Skipped | Enhance | Chapters
 * - Language Learning Sub-tabs: Process | Play | Review
 */
@Component({
  selector: 'app-studio',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    StudioListComponent,
    AddModalComponent,
    ContentEditorComponent,
    ProcessWizardComponent,
    LLWizardComponent,
    MetadataEditorComponent,
    DiffViewComponent,
    PlayViewComponent,
    SkippedChunksPanelComponent,
    PostProcessingPanelComponent,
    ChapterRecoveryComponent,
    BilingualPlayerComponent,
    AudiobookPlayerComponent,
    VersionPickerDialogComponent,
    ProjectFilesComponent
  ],
  template: `
    <div class="studio-container">
      <desktop-split-pane [primarySize]="280" [minSize]="200" [maxSize]="500">
        <!-- Left Panel: List -->
        <div pane-primary class="list-panel">
          <div class="panel-header">
            <h3>Studio</h3>
            <div class="header-actions">
              <button class="btn-header-action" (click)="studioService.loadAll()" title="Refresh">
                ↻
              </button>
              <button class="btn-add" (click)="showAddModal.set(true)" title="Add Content">
                +
              </button>
            </div>
          </div>
          <app-studio-list
            [articles]="studioService.articles()"
            [books]="studioService.books()"
            [selectedId]="selectedItemId()"
            (select)="selectItem($event)"
            (play)="playItem($event)"
            (contextMenu)="onContextMenu($event)"
          />
        </div>

        <!-- Right Panel: Workflow -->
        <div pane-secondary class="workflow-panel">
          @if (selectedItem()) {
            <!-- Main Tabs -->
            <div class="main-tabs-container">
              <div class="main-tabs">
                <button
                  class="main-tab"
                  [class.active]="mainTab() === 'files'"
                  (click)="setMainTab('files')"
                >
                  Files
                </button>
                @if (selectedItem()!.type === 'article') {
                  <button
                    class="main-tab"
                    [class.active]="mainTab() === 'content'"
                    (click)="setMainTab('content')"
                  >
                    Content
                  </button>
                }
                <button
                  class="main-tab"
                  [class.active]="mainTab() === 'audiobook'"
                  (click)="setMainTab('audiobook')"
                >
                  Audiobook
                </button>
                <button
                  class="main-tab"
                  [class.active]="mainTab() === 'language-learning'"
                  (click)="setMainTab('language-learning')"
                >
                  Language Learning
                </button>

                <!-- Finalize button for articles on Content tab only -->
                @if (selectedItem()!.type === 'article' && mainTab() === 'content') {
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

              <!-- Sub-tabs for Audiobook -->
              @if (mainTab() === 'audiobook') {
                <div class="sub-tabs">
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'process'"
                    (click)="setAudiobookSubTab('process')"
                  >
                    Process
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'stream'"
                    (click)="setAudiobookSubTab('stream')"
                  >
                    Stream
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'play'"
                    [class.disabled]="!hasMonoAudio()"
                    (click)="handleSubTabClick('audiobook', 'play', hasMonoAudio(), 'No audiobook yet. Run TTS first.')"
                  >
                    Play
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'review'"
                    [class.disabled]="!selectedItem()!.hasCleaned && !diffPaths()"
                    (click)="handleSubTabClick('audiobook', 'review', selectedItem()!.hasCleaned || !!diffPaths(), 'No cleaned version. Run AI Cleanup first.')"
                  >
                    Review
                  </button>
                  @if (selectedItem()!.skippedChunksPath) {
                    <button
                      class="sub-tab warning"
                      [class.active]="audiobookSubTab() === 'skipped'"
                      (click)="setAudiobookSubTab('skipped')"
                    >
                      Skipped
                    </button>
                  }
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'enhance'"
                    [class.disabled]="!selectedItem()!.audiobookPath"
                    (click)="handleSubTabClick('audiobook', 'enhance', !!selectedItem()!.audiobookPath, 'No audiobook yet.')"
                  >
                    Enhance
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="audiobookSubTab() === 'chapters'"
                    [class.disabled]="!selectedItem()!.vttPath"
                    (click)="handleSubTabClick('audiobook', 'chapters', !!selectedItem()!.vttPath, 'No chapter data yet.')"
                  >
                    Chapters
                  </button>
                </div>
              }

              <!-- Sub-tabs for Language Learning -->
              @if (mainTab() === 'language-learning') {
                <div class="sub-tabs">
                  <button
                    class="sub-tab"
                    [class.active]="llSubTab() === 'process'"
                    (click)="setLLSubTab('process')"
                  >
                    Process
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="llSubTab() === 'play'"
                    [class.disabled]="!hasBilingualAudio()"
                    (click)="handleSubTabClick('language-learning', 'play', hasBilingualAudio(), 'No bilingual audiobook yet.')"
                  >
                    Play
                  </button>
                  <button
                    class="sub-tab"
                    [class.active]="llSubTab() === 'review'"
                    [class.disabled]="!selectedItem()!.hasCleaned"
                    (click)="handleSubTabClick('language-learning', 'review', selectedItem()!.hasCleaned, 'No cleaned version.')"
                  >
                    Review
                  </button>
                </div>
              }

              <!-- Disabled tab message -->
              @if (disabledTabMessage()) {
                <div class="disabled-tab-message">
                  {{ disabledTabMessage() }}
                </div>
              }
            </div>

            <!-- Tab Content -->
            <div class="tab-content" [class.full-height]="isFullHeightTab()">
              <!-- Files Tab -->
              @if (mainTab() === 'files') {
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
                @if (selectedItem()?.bfpPath) {
                  <app-project-files
                    [projectDir]="getProjectDir()"
                    [projectId]="selectedItem()?.id || ''"
                    (fileChanged)="onFileChanged()"
                    (editFile)="openEditorWithFile($event)"
                    (diffFiles)="onDiffFiles($event)"
                  />
                }
              }

              <!-- Content Tab (Articles only) -->
              @if (mainTab() === 'content') {
                <app-content-editor
                  [item]="selectedItem()"
                  (itemChanged)="onItemChanged()"
                />
              }

              <!-- Audiobook Tab Content -->
              @if (mainTab() === 'audiobook') {
                @switch (audiobookSubTab()) {
                  @case ('process') {
                    @if (currentEpubPath()) {
                      <app-process-wizard
                        [epubPath]="currentEpubPath()"
                        [title]="selectedMetadata()?.title || ''"
                        [author]="selectedMetadata()?.author || ''"
                        [coverPath]="selectedItem()?.coverPath || ''"
                        [year]="selectedMetadata()?.year || ''"
                        [itemType]="selectedItem()?.type || 'book'"
                        [bfpPath]="selectedItem()?.bfpPath || ''"
                        [projectId]="selectedItem()?.id || ''"
                        [projectDir]="getProjectDir()"
                        [sourceLang]="selectedItem()?.sourceLang || 'en'"
                        [textContent]="selectedItem()?.textContent || ''"
                        [cachedSession]="cachedSession()"
                        (queued)="onProcessQueued()"
                      />
                    } @else {
                      <div class="empty-state-panel">
                        <div class="icon">📄</div>
                        <p>No EPUB available for processing.</p>
                        @if (selectedItem()?.type === 'article') {
                          <p class="hint">Click "Finalize" on the Content tab to generate an EPUB.</p>
                        }
                      </div>
                    }
                  }
                  @case ('stream') {
                    @if (currentEpubPath()) {
                      <app-play-view [epubPath]="currentEpubPath()" />
                    } @else {
                      <div class="empty-state-panel">
                        <div class="icon">🎧</div>
                        <p>No EPUB available for streaming.</p>
                      </div>
                    }
                  }
                  @case ('play') {
                    @if (bookAudioData() && !fullscreenPlayer()) {
                      <app-audiobook-player [audiobook]="bookAudioData()" (requestFullscreen)="fullscreenPlayer.set(true)" />
                    } @else {
                      <div class="empty-state-panel">
                        <div class="icon">🎧</div>
                        <p>No audiobook available. Run TTS conversion first.</p>
                      </div>
                    }
                  }
                  @case ('review') {
                    <app-diff-view
                      [originalPath]="diffPaths()?.originalPath || selectedItem()?.epubPath || ''"
                      [cleanedPath]="diffPaths()?.changedPath || selectedItem()?.cleanedEpubPath || ''"
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
              }

              <!-- Language Learning Tab Content -->
              @if (mainTab() === 'language-learning') {
                @switch (llSubTab()) {
                  @case ('process') {
                    @if (currentEpubPath()) {
                      <app-ll-wizard
                        [epubPath]="currentEpubPath()"
                        [originalEpubPath]="selectedItem()?.epubPath || ''"
                        [title]="selectedMetadata()?.title || ''"
                        [projectTitle]="selectedMetadata()?.title || ''"
                        [author]="selectedMetadata()?.author || ''"
                        [itemType]="selectedItem()?.type || 'book'"
                        [bfpPath]="selectedItem()?.bfpPath || ''"
                        [projectId]="selectedItem()?.id || ''"
                        [projectDir]="getProjectDir()"
                        [audiobookFolder]="getAudiobookFolder()"
                        [initialSourceLang]="selectedItem()?.language || 'en'"
                        (queued)="onProcessQueued()"
                      />
                    } @else {
                      <div class="empty-state-panel">
                        <div class="icon">📄</div>
                        <p>No EPUB available for processing.</p>
                        @if (selectedItem()?.type === 'article') {
                          <p class="hint">Click "Finalize" on the Content tab to generate an EPUB.</p>
                        }
                      </div>
                    }
                  }
                  @case ('play') {
                    @if (bilingualAudioData()) {
                      @if (bilingualPairKeys().length > 1) {
                        <div class="bilingual-pair-picker">
                          @for (key of bilingualPairKeys(); track key) {
                            <button
                              class="pair-btn"
                              [class.active]="bilingualAudioData()?.sourceLang + '-' + bilingualAudioData()?.targetLang === key"
                              (click)="selectBilingualPair(key)"
                            >{{ bilingualPairLabel(key) }}</button>
                          }
                        </div>
                      }
                      <app-bilingual-player [audiobook]="bilingualAudioData()" />
                    } @else {
                      <div class="empty-state-panel">
                        <div class="icon">🎧</div>
                        <p>No bilingual audiobook available.</p>
                        <p class="hint">Complete the Language Learning process to generate one.</p>
                      </div>
                    }
                  }
                  @case ('review') {
                    <app-diff-view
                      [originalPath]="diffPaths()?.originalPath || selectedItem()?.epubPath || ''"
                      [cleanedPath]="diffPaths()?.changedPath || selectedItem()?.cleanedEpubPath || ''"
                    />
                  }
                }
              }
            </div>
          } @else {
            <!-- Empty State -->
            <div class="empty-state">
              <div class="empty-icon">🎧</div>
              <h2>Welcome to BookForge</h2>
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
        <button class="context-menu-item" (click)="openContextMenuItemFolder()">
          Open File Location
        </button>
        <button class="context-menu-item danger" (click)="deleteContextMenuItem()">
          Delete
        </button>
      </div>
    }

    <!-- Version Picker Dialog -->
    @if (showVersionPicker()) {
      <app-version-picker-dialog
        [data]="versionPickerData()"
      />
    }

    <!-- Fullscreen Player Overlay -->
    @if (fullscreenPlayer()) {
      <div class="fullscreen-overlay">
        <app-audiobook-player [audiobook]="bookAudioData()" [fullscreen]="true" (closeFullscreen)="fullscreenPlayer.set(false)" />
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

    .fullscreen-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      background: var(--bg-base);
      display: flex;
      flex-direction: column;
      -webkit-app-region: no-drag;
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
        min-height: 0;
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

    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn-header-action {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
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
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
    }

    .workflow-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }

    /* Main Tabs */
    .main-tabs-container {
      flex-shrink: 0;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
    }

    .main-tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 8px 16px;
    }

    .main-tab {
      padding: 8px 16px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        color: var(--text-primary);
        background: var(--hover-bg);
      }

      &.active {
        color: var(--accent);
        background: var(--accent-subtle);
      }
    }

    /* Sub Tabs */
    .sub-tabs {
      display: flex;
      gap: 4px;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-subtle);
    }

    .sub-tab {
      padding: 6px 14px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(.disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }

      &.disabled {
        color: var(--text-muted);
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.warning {
        color: #eab308;

        &.active {
          background: #eab308;
          color: white;
        }
      }
    }

    .disabled-tab-message {
      padding: 8px 16px;
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid rgba(234, 179, 8, 0.3);
      border-radius: 6px;
      color: #eab308;
      font-size: 12px;
      margin: 8px 16px;
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

    /* Tab Content */
    .tab-content {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 16px;

      &.full-height {
        padding: 0;
        overflow: hidden;
      }
    }

    .bilingual-pair-picker {
      display: flex;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);

      .pair-btn {
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid var(--border-subtle);
        background: transparent;
        color: var(--text-secondary);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;

        &:hover {
          border-color: var(--text-muted);
          color: var(--text-primary);
        }

        &.active {
          background: var(--accent-subtle);
          border-color: var(--accent);
          color: var(--accent);
        }
      }
    }

    .empty-state-panel {
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
      background: var(--accent);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--accent-hover);
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
        color: var(--text-danger, #ef4444);
      }
    }

  `]
})
export class StudioComponent implements OnInit, OnDestroy {
  readonly studioService = inject(StudioService);
  private readonly epubService = inject(EpubService);
  private readonly audiobookService = inject(AudiobookService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly settingsService = inject(SettingsService);

  @ViewChild(ContentEditorComponent) contentEditor?: ContentEditorComponent;

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────

  readonly showAddModal = signal<boolean>(false);
  readonly selectedItemId = signal<string | null>(null);
  readonly fullscreenPlayer = signal<boolean>(false);

  // Tab navigation
  readonly mainTab = signal<MainTab>('files');
  readonly audiobookSubTab = signal<AudiobookSubTab>('process');
  readonly llSubTab = signal<LanguageLearningSubTab>('process');

  readonly processStep = signal<ProcessStep>('cleanup');
  readonly savingMetadata = signal<boolean>(false);
  readonly finalizingContent = signal<'idle' | 'saving' | 'done'>('idle');
  readonly disabledTabMessage = signal<string | null>(null);

  // Version picker dialog
  readonly showVersionPicker = signal<boolean>(false);
  readonly versionPickerData = signal<VersionPickerDialogData | null>(null);

  // Context menu
  readonly contextMenuVisible = signal<boolean>(false);
  readonly contextMenuX = signal<number>(0);
  readonly contextMenuY = signal<number>(0);
  private contextMenuItem: StudioItem | null = null;

  // Inline diff view (shown in Files tab)
  readonly diffPaths = signal<DiffRequest | null>(null);

  // Cached TTS session for reassembly
  readonly cachedSession = signal<any>(null);

  // Watch selectedItem changes to check for cached sessions
  private readonly cachedSessionEffect = effect(() => {
    const item = this.selectedItem();
    if (item?.bfpPath) {
      this.checkCachedSession(item.bfpPath);
    } else {
      this.cachedSession.set(null);
    }
  }, { allowSignalWrites: true });

  // ─────────────────────────────────────────────────────────────────────────
  // Computed
  // ─────────────────────────────────────────────────────────────────────────

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
      year: item.year,
      language: item.language || item.sourceLang || 'en',
      coverPath: item.coverPath,
      coverData: item.coverData
    };
  });

  readonly currentEpubPath = computed<string>(() => {
    const item = this.selectedItem();
    if (!item) return '';
    return item.cleanedEpubPath || item.epubPath || '';
  });

  readonly audioFilePath = computed<string | undefined>(() => {
    return this.selectedItem()?.audiobookPath;
  });

  readonly audioFilePathValid = computed(() => {
    return !!this.selectedItem()?.audiobookPath;
  });

  // Check if mono audiobook exists
  readonly hasMonoAudio = computed(() => {
    const item = this.selectedItem();
    return !!item?.audiobookPath && !!item?.vttPath;
  });

  // Check if bilingual audiobook exists
  readonly hasBilingualAudio = computed(() => {
    const item = this.selectedItem();
    return !!item?.bilingualAudioPath && !!item?.bilingualVttPath;
  });

  // Data for mono audiobook player
  readonly bookAudioData = computed(() => {
    const item = this.selectedItem();
    if (!item || !item.audiobookPath || !item.vttPath) return null;
    return {
      id: item.id,
      title: item.title,
      author: item.author,
      audiobookPath: item.audiobookPath,
      vttPath: item.vttPath,
      epubPath: item.epubPath,
    };
  });

  // Bilingual language pair selection
  readonly selectedBilingualKey = signal<string>('');

  // Available bilingual language pairs for the picker
  readonly bilingualPairKeys = computed(() => {
    const item = this.selectedItem();
    if (!item?.bilingualOutputs) return [];
    return Object.keys(item.bilingualOutputs);
  });

  // Language code → display name
  private readonly langDisplayNames: Record<string, string> = {
    en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
    ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ar: 'Arabic',
    hi: 'Hindi', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
  };

  bilingualPairLabel(key: string): string {
    const [src, tgt] = key.split('-');
    const srcName = this.langDisplayNames[src] || src.toUpperCase();
    const tgtName = this.langDisplayNames[tgt] || tgt.toUpperCase();
    return `${srcName} / ${tgtName}`;
  }

  selectBilingualPair(key: string): void {
    this.selectedBilingualKey.set(key);
  }

  // Data for bilingual player
  readonly bilingualAudioData = computed(() => {
    const item = this.selectedItem();
    if (!item) return null;

    // Use bilingualOutputs map if available (supports multiple pairs)
    if (item.bilingualOutputs) {
      const keys = Object.keys(item.bilingualOutputs);
      if (keys.length === 0) return null;

      // Use selected key, or default to first available
      let key = this.selectedBilingualKey();
      if (!key || !item.bilingualOutputs[key]) {
        key = keys[0];
      }
      const output = item.bilingualOutputs[key];
      if (!output.audioPath || !output.vttPath) return null;

      return {
        id: item.id,
        title: item.title,
        sourceLang: output.sourceLang,
        targetLang: output.targetLang,
        audiobookPath: output.audioPath,
        vttPath: output.vttPath,
        sentencePairsPath: output.sentencePairsPath
      };
    }

    // Legacy fallback: single bilingual pair
    if (item.bilingualAudioPath && item.bilingualVttPath) {
      return {
        id: item.id,
        title: item.title,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        audiobookPath: item.bilingualAudioPath,
        vttPath: item.bilingualVttPath,
        sentencePairsPath: item.bilingualSentencePairsPath
      };
    }

    // Fallback for articles with regular audio
    if (item.type === 'article' && item.audiobookPath && item.vttPath) {
      return {
        id: item.id,
        title: item.title,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        audiobookPath: item.audiobookPath,
        vttPath: item.vttPath
      };
    }

    return null;
  });

  // Determine if current tab should use full height (no padding)
  readonly isFullHeightTab = computed(() => {
    const main = this.mainTab();
    if (main === 'content') return true;
    if (main === 'audiobook') {
      const sub = this.audiobookSubTab();
      return sub === 'process' || sub === 'stream' || sub === 'play';
    }
    if (main === 'language-learning') {
      const sub = this.llSubTab();
      return sub === 'process' || sub === 'play';
    }
    return false;
  });

  readonly ttsSettings = signal<TTSSettings>({
    device: 'cpu',
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

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.libraryService.whenReady();
    await this.studioService.loadAll();
    document.addEventListener('click', () => this.hideContextMenu());

    // Listen for editor window close events to refresh the item
    this.electronService.onEditorWindowClosed((projectPath: string) => {
      // Find the item that matches this project path and reload it
      const item = this.selectedItem();
      if (item?.bfpPath === projectPath || item?.epubPath === projectPath) {
        this.onItemChanged();
      }
    });
  }

  ngOnDestroy(): void {
    this.electronService.offEditorWindowClosed();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  setMainTab(tab: MainTab): void {
    this.mainTab.set(tab);
    this.disabledTabMessage.set(null);
    this.diffPaths.set(null);
  }

  setAudiobookSubTab(tab: AudiobookSubTab): void {
    this.audiobookSubTab.set(tab);
    this.disabledTabMessage.set(null);
    if (tab !== 'review') {
      this.diffPaths.set(null);
    }
  }

  setLLSubTab(tab: LanguageLearningSubTab): void {
    this.llSubTab.set(tab);
    this.disabledTabMessage.set(null);
  }

  handleSubTabClick(
    mainTab: 'audiobook' | 'language-learning',
    subTab: AudiobookSubTab | LanguageLearningSubTab,
    isEnabled: boolean | undefined,
    disabledMessage: string
  ): void {
    if (isEnabled) {
      if (mainTab === 'audiobook') {
        this.setAudiobookSubTab(subTab as AudiobookSubTab);
      } else {
        this.setLLSubTab(subTab as LanguageLearningSubTab);
      }
    } else {
      this.disabledTabMessage.set(disabledMessage);
      setTimeout(() => {
        if (this.disabledTabMessage() === disabledMessage) {
          this.disabledTabMessage.set(null);
        }
      }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Item Selection
  // ─────────────────────────────────────────────────────────────────────────

  selectItem(item: StudioItem): void {
    this.selectedItemId.set(item.id);
    this.mainTab.set('files');
    this.audiobookSubTab.set('process');
    this.llSubTab.set('process');
    this.finalizingContent.set('idle');
    this.diffPaths.set(null);
  }

  playItem(item: StudioItem): void {
    this.selectedItemId.set(item.id);
    this.mainTab.set('audiobook');
    this.audiobookSubTab.set('play');
  }

  onItemAdded(item: StudioItem): void {
    this.selectItem(item);
  }

  onItemChanged(): void {
    // Item was modified
  }

  async onFileChanged(): Promise<void> {
    const id = this.selectedItemId();
    if (id) {
      await this.studioService.reloadItem(id);
    }
  }

  /**
   * Open the editor for a specific file path (from file browser).
   * Routes through version picker for BFP projects.
   */
  async openEditorWithFile(filePath: string): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    if (item.bfpPath) {
      await this.openEditorWithBfp(item.bfpPath, filePath);
    } else {
      await this.openEditorWithVersion(filePath);
    }
  }

  onDiffFiles(request: DiffRequest): void {
    this.diffPaths.set(request);
    this.mainTab.set('audiobook');
    this.audiobookSubTab.set('review');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  getProjectDir(): string {
    const item = this.selectedItem();
    if (!item?.bfpPath) return '';
    return item.bfpPath;
  }

  getAudiobookFolder(): string {
    const item = this.selectedItem();
    if (!item?.bfpPath) return '';
    return `${item.bfpPath}/output`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cached Session
  // ─────────────────────────────────────────────────────────────────────────

  async checkCachedSession(bfpPath: string): Promise<void> {
    const electron = (window as any).electron;
    if (!electron?.reassembly?.getBfpSession) return;
    const result = await electron.reassembly.getBfpSession(bfpPath);
    if (result.success && result.data) {
      this.cachedSession.set(result.data);
    } else {
      this.cachedSession.set(null);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context Menu
  // ─────────────────────────────────────────────────────────────────────────

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

  openContextMenuItemFolder(): void {
    if (!this.contextMenuItem?.bfpPath) return;
    this.electronService.showItemInFolder(this.contextMenuItem.bfpPath);
    this.hideContextMenu();
  }

  async deleteContextMenuItem(): Promise<void> {
    if (!this.contextMenuItem) return;

    const result = await this.studioService.deleteItem(this.contextMenuItem.id);
    if (result.success && this.selectedItemId() === this.contextMenuItem.id) {
      this.selectedItemId.set(null);
    }
    this.hideContextMenu();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────────────────

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
      if (item.type === 'book') {
        // Update BFP file and local state
        const result = await this.studioService.updateBookMetadata(item.id, {
          title: metadata.title,
          author: metadata.author,
          year: metadata.year,
          language: metadata.language,
          coverData: metadata.coverData
        });

        if (!result.success) {
          console.error('[Studio] Failed to save metadata:', result.error);
        }
      }

      // Also update the EPUB file if it exists
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
    const item = this.selectedItem();
    if (!item) return;

    // Update manifest with linked audio path
    const result = await this.electronService.manifestUpdate({
      projectId: item.id,
      outputs: {
        audiobook: {
          path: path,
          completedAt: new Date().toISOString(),
        },
      },
    });
    if (result.success) {
      await this.studioService.loadBooks();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Editor Window
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the path to use for the editor.
   * Prefers bfpPath (existing project), falls back to epubPath (source file).
   */
  getEditorPath(): string | null {
    const item = this.selectedItem();
    if (!item) return null;

    // Prefer BFP project file if available
    if (item.bfpPath) {
      return item.bfpPath;
    }

    // Fall back to source EPUB/PDF path
    if (item.epubPath) {
      return item.epubPath;
    }

    return null;
  }

  /**
   * Open the editor - shows version picker if multiple versions exist
   */
  async openEditor(): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    // If we have a BFP path, show version picker to let user choose which version to edit
    if (item.bfpPath) {
      this.versionPickerData.set({
        bfpPath: item.bfpPath,
        onSelect: (version: ProjectVersion) => {
          this.showVersionPicker.set(false);
          // Pass BFP path to editor so project state is preserved
          // The editor will load the BFP and use the selected version as source
          this.openEditorWithBfp(item.bfpPath!, version.path);
        },
        onCancel: () => {
          this.showVersionPicker.set(false);
        }
      });
      this.showVersionPicker.set(true);
    } else if (item.epubPath) {
      // No BFP, just open the source file directly
      this.openEditorWithVersion(item.epubPath);
    }
  }

  /**
   * Open the editor window with a specific version (no BFP - direct file editing)
   */
  private async openEditorWithVersion(versionPath: string): Promise<void> {
    const result = await this.electronService.editorOpenWindow(versionPath);
    if (!result.success) {
      console.error('[Studio] Failed to open editor window:', result.error);
    }
  }

  /**
   * Open the editor window with a BFP project and specific source version
   * This ensures project state (deletions, chapters) is preserved
   */
  private async openEditorWithBfp(bfpPath: string, sourcePath: string): Promise<void> {
    const result = await this.electronService.editorOpenWindowWithBfp(bfpPath, sourcePath);
    if (!result.success) {
      console.error('[Studio] Failed to open editor window:', result.error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Processing
  // ─────────────────────────────────────────────────────────────────────────

  onProcessQueued(): void {
    this.studioService.reloadItem(this.selectedItemId()!);
  }

  onTtsSettingsChange(settings: TTSSettings): void {
    this.ttsSettings.set(settings);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Content Finalization (Articles)
  // ─────────────────────────────────────────────────────────────────────────

  async finalizeContent(): Promise<void> {
    const item = this.selectedItem();
    if (!item || item.type !== 'article') return;

    this.finalizingContent.set('saving');

    try {
      let finalizedHtml = '';
      if (this.contentEditor) {
        finalizedHtml = await this.contentEditor.getFilteredHtml();
      }

      await this.studioService.finalizeArticleContent(item.id, finalizedHtml);
      await this.studioService.reloadItem(item.id);

      this.finalizingContent.set('done');

      // Navigate to Audiobook → Process
      this.mainTab.set('audiobook');
      this.audiobookSubTab.set('process');

      setTimeout(() => {
        this.finalizingContent.set('idle');
      }, 500);
    } catch (e) {
      console.error('[Studio] Failed to finalize content:', e);
      this.finalizingContent.set('idle');
    }
  }
}

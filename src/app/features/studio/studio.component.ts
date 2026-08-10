import { Component, inject, signal, computed, effect, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  SplitPaneComponent,
  DesktopSelectComponent,
  DesktopSelectItems
} from '../../creamsicle-desktop';
import { StudioService } from './services/studio.service';
import { StudioItem, StudioItemType, MainTab, AudiobookSubTab, LanguageLearningSubTab, ProcessStep } from './models/studio.types';
import { sortStudioItems } from './models/studio-sort';
import { StudioListComponent } from './components/studio-list/studio-list.component';
import { StudioBrowseComponent } from './components/studio-browse/studio-browse.component';
import { StudioVersionsComponent } from './components/studio-versions/studio-versions.component';
import { StudioAnalysisModalComponent } from './components/studio-analysis-modal/studio-analysis-modal.component';
import { StudioAnalysisTarget, studioManifestProjectId } from './analysis-target';
import { AnalyticsPanelComponent } from '../audiobook/components/analytics-panel/analytics-panel.component';
import { ProjectAnalytics } from '../../core/models/analytics.types';
import { AddModalComponent } from './components/add-modal/add-modal.component';
import { ContentEditorComponent } from './components/content-editor/content-editor.component';
import { LLWizardComponent } from '../language-learning/components/ll-wizard/ll-wizard.component';
import { CorrectSentencesComponent } from '../correct-sentences/correct-sentences.component';

// Import existing audiobook components
import { MetadataEditorComponent, EpubMetadata } from '../audiobook/components/metadata-editor/metadata-editor.component';
import { TTSSettings } from './models/tts.types';
import { SkippedChunksPanelComponent } from '../audiobook/components/skipped-chunks-panel/skipped-chunks-panel.component';
import { VersionPickerDialogComponent, VersionPickerDialogData, VariantOption } from './components/version-picker-dialog/version-picker-dialog.component';
import { DiffRequest } from './components/project-files/project-files.component';
import { ProjectVersion } from './models/project-version.types';

import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { SettingsService } from '../../core/services/settings.service';
import { NarrationHandoffService } from '../../core/services/narration-handoff.service';
import { NoticeService } from '../../core/services/notice.service';
import { looseMatch } from '../../shared/search';
import { samePath } from '@shared/document/same-path';

/**
 * StudioComponent - Unified workspace for books and articles
 *
 * Two views: Browse (cover grid) and Workspace (list + book tabs).
 * Book tabs: Versions | Content (articles) | Process (unified pipeline wizard) |
 * Listen (play/stream). Content analysis opens as a source-locked modal.
 */
@Component({
  selector: 'app-studio',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    SplitPaneComponent,
    DesktopSelectComponent,
    StudioListComponent,
    AddModalComponent,
    ContentEditorComponent,
    LLWizardComponent,
    CorrectSentencesComponent,
    MetadataEditorComponent,
    SkippedChunksPanelComponent,
    VersionPickerDialogComponent,
    StudioBrowseComponent,
    StudioVersionsComponent,
    StudioAnalysisModalComponent,
    AnalyticsPanelComponent
  ],
  template: `
    <div class="studio-container"
      (dragenter)="onStudioDragEnter($event)"
      (dragover)="onStudioDragOver($event)"
      (dragleave)="onStudioDragLeave($event)"
      (drop)="onStudioDrop($event)"
    >
      @if (showDropOverlay()) {
        <div class="drop-overlay">
          <div class="drop-overlay-content">
            <div class="drop-overlay-icon">+</div>
            <div class="drop-overlay-text">Drop files to import</div>
          </div>
        </div>
      }

      <!-- Top bar: view toggle (Browse grid vs Workspace) -->
      <div class="studio-topbar">
        <div class="view-toggle">
          <button [class.active]="viewMode() === 'browse'" (click)="viewMode.set('browse')">Browse</button>
          <button [class.active]="viewMode() === 'workspace'" (click)="viewMode.set('workspace')">Workspace</button>
        </div>

        <!-- Shared sort control (Browse + Workspace order identically) -->
        <div class="sort-control">
          <desktop-select
            class="sort-select"
            [options]="sortOptions"
            [ngModel]="studioService.sort().field"
            (ngModelChange)="studioService.setSortField($event)"
            ariaLabel="Sort by"
          />
          <button
            class="sort-dir"
            [disabled]="studioService.sort().field === 'custom'"
            (click)="studioService.toggleSortDirection()"
            [title]="studioService.sort().direction === 'asc' ? 'Ascending' : 'Descending'"
          >
            {{ studioService.sort().direction === 'asc' ? '↑' : '↓' }}
          </button>
        </div>

        @if (viewMode() === 'browse') {
          <div class="topbar-search">
            <input
              type="text"
              placeholder="Search titles, authors, tags..."
              [ngModel]="searchQuery()"
              (ngModelChange)="searchQuery.set($event)"
              class="search-input"
            />
            @if (searchQuery()) {
              <button class="search-clear" (click)="searchQuery.set('')">&times;</button>
            }
          </div>
          <div class="topbar-actions">
            <span class="browse-count">{{ browseItems().length }} books</span>
            <button class="btn-header-action" (click)="studioService.loadAll()" title="Refresh">↻</button>
            <button class="btn-add" (click)="showAddModal.set(true)" title="Add Content">+</button>
          </div>
        }
      </div>

      @if (viewMode() === 'browse') {
        @if (allTags().length > 0) {
          <div class="tag-filter-bar browse-tags">
            <button class="tag-filter-pill" [class.active]="!activeTag()" (click)="activeTag.set(null)">All</button>
            @for (tag of allTags(); track tag) {
              <button class="tag-filter-pill" [class.active]="activeTag() === tag" (click)="toggleTag(tag)">{{ tag }}</button>
            }
          </div>
        }
        <div class="tag-filter-bar browse-narration">
          <span class="filter-group-label">Narration</span>
          <button class="tag-filter-pill" [class.active]="narrationFilter() === 'all'" (click)="narrationFilter.set('all')">All</button>
          <button class="tag-filter-pill" [class.active]="narrationFilter() === 'professional'" (click)="narrationFilter.set('professional')">Professional</button>
          <button class="tag-filter-pill" [class.active]="narrationFilter() === 'tts'" (click)="narrationFilter.set('tts')">TTS</button>
        </div>
        <app-studio-browse
          [items]="browseItems()"
          [selectedId]="selectedItemId()"
          (open)="openInWorkspace($event)"
          (editRequested)="editFromBrowse($event)"
          (exportRequested)="exportFromBrowse($event)"
          (reclassifyRequested)="reclassifyFromBrowse($event)"
          (reorder)="onBrowseReorder($event)"
        />
      } @else {
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
          <div class="search-bar">
            <input
              type="text"
              placeholder="Search titles or authors..."
              [ngModel]="searchQuery()"
              (ngModelChange)="searchQuery.set($event)"
              class="search-input"
            />
            @if (searchQuery()) {
              <button class="search-clear" (click)="searchQuery.set('')">&times;</button>
            }
          </div>
          @if (allTags().length > 0) {
            <div class="tag-filter-bar">
              <button class="tag-filter-pill" [class.active]="!activeTag()" (click)="activeTag.set(null)">All</button>
              @for (tag of allTags(); track tag) {
                <button class="tag-filter-pill" [class.active]="activeTag() === tag" (click)="toggleTag(tag)">{{ tag }}</button>
              }
            </div>
          }
          <!-- Narration filter. Wraps rather than scrolls here: the pane is ~280px and a
               filter you have to scroll sideways to discover may as well not exist. -->
          <div class="tag-filter-bar narration-filter">
            <span class="filter-group-label">Narration</span>
            <button
              class="tag-filter-pill"
              [class.active]="narrationFilter() === 'all'"
              (click)="narrationFilter.set('all')"
            >All</button>
            <button
              class="tag-filter-pill"
              [class.active]="narrationFilter() === 'professional'"
              title="Books with a professionally read audiobook"
              (click)="narrationFilter.set('professional')"
            >Professional</button>
            <button
              class="tag-filter-pill"
              [class.active]="narrationFilter() === 'tts'"
              title="Books without a professionally read audiobook, plus any book that has a TTS one"
              (click)="narrationFilter.set('tts')"
            >TTS</button>
          </div>
          <app-studio-list
            [articles]="filteredArticles()"
            [books]="filteredBooks()"
            [archived]="filteredArchived()"
            [selectedId]="selectedItemId()"
            (select)="selectItem($event)"
            (play)="playItem($event)"
            (contextMenu)="onContextMenu($event)"
            (reorder)="onReorder($event)"
            (archive)="onArchive($event)"
            (unarchive)="onUnarchive($event)"
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
                  Versions
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
                <!-- The Process page has no tab of its own (Owen, 2026-08-10:
                     "the user doesnt need access to the processing page through
                     the tab along the top. that tab can go"). Its doors are the
                     Process buttons on the versions page and the narration
                     modal's "More options" line — goToProcessing() still lands
                     here, the strip just doesn't offer it cold. -->
                @if (mainTab() === 'audiobook') {
                  <button class="main-tab active">
                    Process
                  </button>
                }
                <button
                  class="main-tab"
                  [class.active]="mainTab() === 'analytics'"
                  (click)="setMainTab('analytics')"
                >
                  Analytics
                </button>
                @if (selectedItem()?.skippedChunksPath) {
                  <button
                    class="main-tab"
                    [class.active]="mainTab() === 'skipped'"
                    (click)="setMainTab('skipped')"
                    title="Chunks the AI cleanup skipped or had trouble with"
                  >
                    Skipped
                  </button>
                }

                <!-- Listen opens the dedicated player window (keep working while you listen) -->
                <button
                  class="btn-listen"
                  [disabled]="!canListen()"
                  [title]="canListen() ? 'Open the player in its own window' : 'Nothing to listen to yet — needs an EPUB or a finished audiobook'"
                  (click)="openListen()"
                >
                  <span class="listen-glyph">▶</span> Listen
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

              <!-- Disabled tab message -->
              @if (disabledTabMessage()) {
                <div class="disabled-tab-message">
                  {{ disabledTabMessage() }}
                </div>
              }
            </div>

            <!-- Tab Content -->
            <div class="tab-content" [class.full-height]="isFullHeightTab()">
              <!-- Versions Tab -->
              @if (mainTab() === 'files') {
                @if (versionsPanel() !== 'none') {
                  <button class="panel-back-btn" (click)="versionsPanel.set('none')">← Back to versions</button>
                  @if (versionsPanel() === 'skipped') {
                    <app-skipped-chunks-panel
                      [skippedChunksPath]="selectedItem()?.skippedChunksPath ?? null"
                      [cleanedEpubPath]="selectedItem()?.cleanedEpubPath ?? null"
                      [originalEpubPath]="selectedItem()?.epubPath ?? null"
                    />
                  }
                } @else {
                  @if (!versionsComparing()) {
                    <app-metadata-editor
                      [metadata]="selectedMetadata()"
                      [saving]="savingMetadataIds().has(selectedItem()?.id ?? '')"
                      [showSlug]="true"
                      (metadataChange)="onMetadataChange($event)"
                      (coverChange)="onCoverChange($event)"
                      (save)="onSaveMetadata($event)"
                    />
                  }
                  @if (selectedItem()?.projectDir) {
                    <app-studio-versions
                      [projectDir]="selectedItem()?.projectDir || ''"
                      [item]="selectedItem()"
                      [refreshTrigger]="filesRefreshTrigger()"
                      (edit)="openEditorWithFile($event)"
                      (open)="openVariantInEditor($event)"
                      (exportDoc)="exportDocument($event)"
                      (exportAudio)="exportM4b($event)"
                      (listen)="openListen($event)"
                      (skipped)="versionsPanel.set('skipped')"
                      (continueJob)="onContinueJob()"
                      (assemble)="goToProcessing()"
                      (process)="goToNarration($event.path)"
                      (correctSentences)="startCorrectSentences()"
                      (changed)="onFileChanged()"
                      (compareActive)="versionsComparing.set($event)"
                      (viewAnalysis)="openEditorWithFile($event.path)"
                      (generateAnalysis)="onGenerateAnalysis($event)"
                    />
                  }
                }
              }

              <!-- Content Tab (Articles only) -->
              @if (mainTab() === 'content') {
                <app-content-editor
                  [item]="selectedItem()"
                  (itemChanged)="onItemChanged()"
                />
              }

              <!-- Process Tab (Standard wizard or Bilingual/Language-Learning wizard) -->
              @if (mainTab() === 'audiobook') {
                @if (correctSentencesActive()) {
                  <app-correct-sentences
                    [projectDir]="getProjectDir()"
                    [title]="selectedMetadata()?.title || ''"
                    [author]="selectedMetadata()?.author || ''"
                    [year]="selectedMetadata()?.year || ''"
                    [coverPath]="selectedItem()?.coverPath || ''"
                    [outputFilename]="selectedMetadata()?.outputFilename || ''"
                    [audiobookFolder]="getAudiobookFolder()"
                    (close)="correctSentencesActive.set(false)"
                    (queued)="onProcessQueued(); correctSentencesActive.set(false)"
                  />
                } @else if (processEpubPath()) {
                  <app-ll-wizard
                    [epubPath]="processEpubPath()"
                    [originalEpubPath]="selectedItem()?.epubPath || ''"
                    [title]="selectedMetadata()?.title || ''"
                    [projectTitle]="selectedMetadata()?.title || ''"
                    [author]="selectedMetadata()?.author || ''"
                    [year]="selectedMetadata()?.year || ''"
                    [coverPath]="selectedItem()?.coverPath || ''"
                    [sourceType]="selectedItem()?.sourceType || ''"
                    [contributors]="selectedItem()?.contributors"
                    [itemType]="selectedItem()?.type || 'book'"
                    [projectId]="selectedItem()?.id || ''"
                    [projectDir]="getProjectDir()"
                    [audiobookFolder]="getAudiobookFolder()"
                    [initialSourceLang]="selectedItem()?.sourceLang || selectedItem()?.language || 'en'"
                    [cachedSession]="cachedSession()"
                    [outputFilename]="selectedMetadata()?.outputFilename || ''"
                    [refreshTrigger]="filesRefreshTrigger()"
                    [continueRequest]="continueRequest()"
                    [narrationRequest]="narrationRequest()"
                    (queued)="onProcessQueued()"
                  />
                } @else {
                  <div class="empty-state-panel">
                    <div class="icon">📄</div>
                    <p>No EPUB available for processing.</p>
                    @if (selectedItem()?.type === 'article') {
                      <p class="hint">Click "Finalize" on the Content tab to generate an EPUB.</p>
                    } @else {
                      <!-- A book reaches here when NO source document was found on
                           disk: no exported/cleaned EPUB, no archived original, no
                           legacy source/original.*. Say so. This used to be hidden by
                           a made-up source/original.epub path, which made the wizard
                           available and then failed inside the job. -->
                      <p class="hint">This book has no source document on disk — no exported EPUB, and no
                        original in its archive. Add one on the Versions tab (Add version), then process it.</p>
                    }
                  </div>
                }
              }

              <!-- Analytics Tab (job performance history — timing/throughput per stage) -->
              @if (mainTab() === 'analytics') {
                @if (analyticsLoading()) {
                  <div class="analytics-loading">Loading analytics…</div>
                } @else {
                  <app-analytics-panel [analytics]="jobAnalytics() || undefined" />
                }
              }

              <!-- Skipped Tab (chunks AI cleanup skipped or looped on) -->
              @if (mainTab() === 'skipped') {
                <app-skipped-chunks-panel
                  [skippedChunksPath]="selectedItem()?.skippedChunksPath ?? null"
                  [cleanedEpubPath]="selectedItem()?.cleanedEpubPath ?? null"
                  [originalEpubPath]="selectedItem()?.epubPath ?? null"
                />
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
      }
    </div>

    <!-- Add Modal -->
    @if (showAddModal()) {
      <app-add-modal
        [initialFiles]="dragDropFiles()"
        (close)="onAddModalClose()"
        (added)="onItemAdded($event)"
      />
    }

    @if (analysisTarget(); as target) {
      @if (selectedItem(); as item) {
        <app-studio-analysis-modal
          [target]="target"
          [item]="item"
          [projectDir]="item.projectDir || ''"
          (close)="analysisTarget.set(null)"
          (queued)="onAnalysisQueued()"
        />
      }
    }

    <!-- Context Menu -->
    @if (contextMenuVisible()) {
      <div
        class="context-menu"
        #contextMenuEl
        [style.top.px]="contextMenuY()"
        [style.left.px]="contextMenuX()"
        (click)="hideContextMenu()"
      >
        @if (contextMenuSelectedIds().length <= 1) {
          <button class="context-menu-item" (click)="openContextMenuItemFolder()">
            Open File Location
          </button>
        }
        @if (contextMenuSelectedIds().length <= 1 && contextMenuItem()?.audiobookPath) {
          <button class="context-menu-item" (click)="exportM4b()">
            Export M4B...
          </button>
        }
        @if (contextMenuSelectedIds().length <= 1 && contextMenuHasExportableEpub()) {
          <button class="context-menu-item" (click)="openExportEpubPicker()">
            Export EPUB...
          </button>
        }
        @if (contextMenuSelectedIds().length <= 1 && hasAnyStage()) {
          <div class="context-menu-separator"></div>
          @if (contextMenuItem()?.hasCleaned && !contextMenuItem()?.hasSimplified) {
            <button class="context-menu-item warning" (click)="deleteStage('cleanup')">
              Delete AI Cleanup
            </button>
          }
          @if (contextMenuItem()?.hasSimplified || (contextMenuItem()?.hasCleanupCheckpoint && !contextMenuItem()?.hasCleaned)) {
            <button class="context-menu-item warning" (click)="deleteStage('simplify')">
              Delete AI Simplify
            </button>
          }
          @if (contextMenuItem()?.hasTranslated) {
            <button class="context-menu-item warning" (click)="deleteStage('translation')">
              Delete Translation
            </button>
          }
          @if (contextMenuItem()?.hasTtsCache) {
            <button class="context-menu-item warning" (click)="deleteStage('tts')">
              Delete TTS Cache
            </button>
          }
          @if (contextMenuItem()?.audiobookPath || contextMenuItem()?.bilingualAudioPath) {
            <button class="context-menu-item warning" (click)="deleteStage('output')">
              Delete Output
            </button>
          }
        }
        @if (contextMenuSelectedIds().length <= 1) {
          <div class="context-menu-separator"></div>
          <button class="context-menu-item warning" (click)="resetEditorState()">
            Reset Editor State
          </button>
        }
        <div class="context-menu-separator"></div>
        @if (contextMenuItem(); as ctxItem) {
          <button class="context-menu-item" (click)="reclassifyContextMenuItem()">
            {{ ctxItem.type === 'article' ? 'Classify as Book' : 'Classify as Article' }}{{ contextMenuSelectedIds().length > 1 ? ' (' + contextMenuSelectedIds().length + ' items)' : '' }}
          </button>
        }
        <button class="context-menu-item" (click)="archiveContextMenuItem()">
          {{ contextMenuItem()?.archived ? 'Unarchive' : 'Archive' }}{{ contextMenuSelectedIds().length > 1 ? ' (' + contextMenuSelectedIds().length + ' items)' : '' }}
        </button>
        <button class="context-menu-item danger" (click)="deleteContextMenuItem()">
          Delete{{ contextMenuSelectedIds().length > 1 ? ' (' + contextMenuSelectedIds().length + ' items)' : '' }}
        </button>
      </div>
    }

    <!-- Export Status Toast -->
    @if (exportStatus()) {
      <div class="export-toast">{{ exportStatus() }}</div>
    }

    <!-- Export EPUB Picker -->
    @if (epubPickerVisible()) {
      <div class="epub-picker-backdrop" (click)="epubPickerVisible.set(false)">
        <div class="epub-picker" (click)="$event.stopPropagation()">
          <div class="epub-picker-title">Export EPUB</div>
          @for (opt of epubPickerOptions(); track opt.path) {
            <button class="epub-picker-item" (click)="exportDocument(opt.path)">
              <span class="epub-picker-label">{{ opt.label }}</span>
              <span class="epub-picker-desc">{{ opt.description }}</span>
            </button>
          }
          <button class="epub-picker-cancel" (click)="epubPickerVisible.set(false)">Cancel</button>
        </div>
      </div>
    }

    <!-- Version Picker Dialog -->
    @if (showVersionPicker()) {
      <app-version-picker-dialog
        [data]="versionPickerData()"
      />
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
      position: relative;
      display: flex;
      flex-direction: column;
    }

    /* Browse/Workspace content fills the area below the top bar */
    /* 'backwards' not 'both': don't retain viewFade's end transform, which would
       make the split-pane a containing block for position:fixed descendants
       (e.g. the diff-view change tooltip) and offset their placement. */
    desktop-split-pane { flex: 1; min-height: 0; animation: viewFade 0.2s ease backwards; }
    /* Opacity-only fade: a lingering transform (from fill-mode: both) would make
       this a containing block for the browse context menu's position:fixed. */
    app-studio-browse { flex: 1; min-height: 0; display: block; animation: viewFadeOpacity 0.2s ease both; }

    /* Tab content fades in when switching tabs (each @if block recreates its root) */
    /* 'backwards' (not 'both'): apply the start state before the run for a clean
       entry, but do NOT retain the end transform afterwards. A lingering
       transform would make the tab child a containing block for position:fixed
       descendants (e.g. the diff-view change tooltip), throwing their placement off. */
    .tab-content > * { animation: tabFade 0.16s ease backwards; }

    @keyframes viewFade {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes viewFadeOpacity {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes tabFade {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .studio-topbar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-default, rgba(255,255,255,0.08));
      flex-shrink: 0;
    }
    .view-toggle {
      display: flex;
      background: var(--bg-elevated);
      border-radius: 7px;
      padding: 2px;
      flex-shrink: 0;
    }
    .view-toggle button {
      border: none;
      background: none;
      color: var(--text-secondary);
      padding: 5px 14px;
      border-radius: 5px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
    }
    .view-toggle button.active {
      background: var(--accent-primary, #06b6d4);
      color: #fff;
    }
    .sort-control {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .sort-select {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 6px;
      color: var(--text-primary);
      padding: 5px 8px;
      font-size: 0.8rem;
      cursor: pointer;
      outline: none;
    }
    .sort-select:focus { border-color: var(--accent-primary, #06b6d4); }
    .sort-dir {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 0.9rem;
      line-height: 1;
      cursor: pointer;
    }
    .sort-dir:hover:not(:disabled) { border-color: var(--accent-primary, #06b6d4); }
    .sort-dir:disabled { opacity: 0.4; cursor: default; }
    .topbar-search { flex: 1; position: relative; max-width: 420px; }
    .topbar-search .search-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 28px 6px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 0.82rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .topbar-search .search-input:focus {
      border-color: var(--accent-primary, #06b6d4);
    }
    .topbar-search .search-input::placeholder {
      color: var(--text-muted, var(--text-secondary));
    }
    .topbar-search .search-clear {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      width: 18px;
      height: 18px;
      border: none;
      background: none;
      color: var(--text-muted, var(--text-secondary));
      font-size: 1rem;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .topbar-search .search-clear:hover { color: var(--text-primary); }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
    }
    .browse-count { font-size: 0.78rem; color: var(--text-secondary); }
    .browse-tags { padding: 8px 16px; flex-shrink: 0; }
    .panel-back-btn {
      align-self: flex-start;
      background: none; border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      color: var(--text-primary); padding: 5px 12px; border-radius: 6px;
      font-size: 0.8rem; cursor: pointer; margin-bottom: 10px;
    }
    .panel-back-btn:hover { background: var(--bg-elevated); }

    .drop-overlay {
      position: absolute;
      inset: 0;
      z-index: 100;
      background: rgba(6, 182, 212, 0.08);
      border: 2px dashed var(--color-primary, #06b6d4);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      animation: fadeIn 0.15s ease-out;
    }

    .drop-overlay-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .drop-overlay-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--color-primary, #06b6d4);
      color: white;
      font-size: 28px;
      font-weight: 300;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .drop-overlay-text {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-primary, #06b6d4);
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

    .tag-filter-bar {
      display: flex;
      gap: 4px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      overflow-x: auto;
      scrollbar-width: none;

      &::-webkit-scrollbar {
        display: none;
      }
    }

    .filter-group-label {
      flex-shrink: 0;
      align-self: center;
      margin-right: 4px;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      white-space: nowrap;
    }

    /* Left-pane variant: the pane is narrow, so these wrap onto a second line
       instead of scrolling out of sight like the wide Browse bar does. */
    .tag-filter-bar.narration-filter {
      flex-wrap: wrap;
      row-gap: 4px;
      overflow-x: visible;
    }

    .tag-filter-pill {
      flex-shrink: 0;
      padding: 3px 10px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 500;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;

      &:hover {
        border-color: var(--accent);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
    }

    .search-bar {
      position: relative;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);

      .search-input {
        width: 100%;
        padding: 6px 28px 6px 10px;
        background: var(--bg-subtle);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 12px;
        outline: none;
        transition: border-color 0.2s;

        &:focus {
          border-color: var(--accent-primary);
        }

        &::placeholder {
          color: var(--text-muted);
        }
      }

      .search-clear {
        position: absolute;
        right: 18px;
        top: 50%;
        transform: translateY(-50%);
        width: 18px;
        height: 18px;
        border: none;
        background: none;
        color: var(--text-muted);
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;

        &:hover {
          color: var(--text-primary);
        }
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
    .quick-actions {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      background: var(--bg-surface);
    }

    .quick-action-btn {
      padding: 8px 18px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      color: white;

      &.edit {
        background: var(--accent);
      }
      &.review {
        background: #8b5cf6;
      }
      &.stream {
        background: #06b6d4;
      }
      &.play {
        background: #22c55e;
      }

      &:hover {
        filter: brightness(1.15);
      }
    }

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

    .btn-listen {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 18px;
      background: var(--accent-primary, #06b6d4);
      border: none;
      border-radius: 16px;
      color: white;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;

      .listen-glyph { font-size: 10px; }

      &:hover:not(:disabled) {
        background: #0891b2;
        transform: translateY(-1px);
        box-shadow: 0 3px 10px color-mix(in srgb, var(--accent-primary, #06b6d4) 35%, transparent);
      }

      &:disabled {
        background: var(--bg-elevated);
        color: var(--text-secondary);
        opacity: 0.55;
        cursor: not-allowed;
      }
    }

    .btn-finalize {
      margin-left: 8px;
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
        display: flex;
        flex-direction: column;
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

    .btn-open-editor {
        margin-top: 20px;
        padding: 10px 24px;
        background: var(--accent-primary);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;

        &:hover {
          opacity: 0.85;
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
      white-space: nowrap;

      &:hover {
        background: var(--bg-hover);
      }

      &.danger {
        color: var(--text-danger, #ef4444);
      }

      &.warning {
        color: var(--text-warning, #f59e0b);
      }
    }

    .context-menu-separator {
      height: 1px;
      background: var(--border-subtle);
      margin: 4px 0;
    }

    .export-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      padding: 10px 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 2000;
      animation: fadeIn 0.2s ease;
    }

    .epub-picker-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1100;
      animation: fadeIn 0.15s ease;
    }

    .epub-picker {
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 10px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.3);
      width: 340px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .epub-picker-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      padding: 0 4px 8px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 4px;
    }

    .epub-picker-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--accent);
      }
    }

    .epub-picker-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .epub-picker-desc {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .epub-picker-cancel {
      margin-top: 4px;
      padding: 8px;
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      border-radius: 6px;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

  `]
})
export class StudioComponent implements OnInit, OnDestroy {
  readonly studioService = inject(StudioService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly settingsService = inject(SettingsService);
  private readonly narrationHandoff = inject(NarrationHandoffService);
  /** Where receipts and partial-condition reports go instead of a modal. */
  private readonly notices = inject(NoticeService);

  @ViewChild(ContentEditorComponent) contentEditor?: ContentEditorComponent;

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────

  readonly sortOptions: DesktopSelectItems = [
    { value: 'modified', label: 'Date modified' },
    { value: 'created', label: 'Date added' },
    { value: 'title', label: 'Title' },
    { value: 'custom', label: 'Custom' },
  ];

  readonly showAddModal = signal<boolean>(false);
  readonly selectedItemId = signal<string | null>(null);

  // View mode: 'browse' = cover-grid library view, 'workspace' = list + workflow.
  readonly viewMode = signal<'browse' | 'workspace'>('workspace');

  // Drag-and-drop file import
  readonly showDropOverlay = signal<boolean>(false);
  readonly dragDropFiles = signal<string[]>([]);
  private dragCounter = 0;

  // Search & Tag Filtering
  readonly searchQuery = signal<string>('');
  // Debounced mirror of searchQuery that drives the filter computeds. The <input>
  // stays bound to searchQuery for instant feedback while the (expensive) list
  // re-filter waits ~150ms after the last keystroke — this is what removed the
  // per-keystroke lag on large collections.
  readonly debouncedQuery = signal<string>('');
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly searchDebounceEffect = effect(() => {
    const q = this.searchQuery();
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.debouncedQuery.set(q);
      this.searchDebounceTimer = null;
    }, 150);
  });
  readonly allTags = signal<string[]>([]);
  readonly activeTag = signal<string | null>(null);

  // Narration filter (books only): professional (≥1 "professionally read" variant).
  readonly narrationFilter = signal<'all' | 'professional' | 'tts'>('all');

  private matchesSearch(item: StudioItem, query: string): boolean {
    if (!query.trim()) return true;
    // Fold title + author + tags together so "gods" matches "God's People" and a
    // query can span fields (e.g. an author's name plus a title word).
    const haystack = `${item.title ?? ''} ${item.author ?? ''} ${(item.tags ?? []).join(' ')}`;
    return looseMatch(haystack, query);
  }

  private matchesTagFilter(item: StudioItem): boolean {
    const tag = this.activeTag();
    if (!tag) return true;
    return !!item.tags?.includes(tag);
  }

  /**
   * Narration filter over a book's own flags.
   *
   * "TTS" is the working set: everything that isn't already covered by a bought
   * narration, PLUS anything that has a TTS render even when it also has a
   * professional one. So a plain unprocessed epub belongs here (it has no
   * professional narration, so it's a TTS candidate), and a book with both kinds
   * appears under Professional and TTS alike. Only books whose narration is
   * exclusively professional drop out.
   *
   * This is deliberately NOT "has a TTS render". That stricter reading hid every
   * un-narrated book from both pills at once — the state a freshly imported book
   * is in, which made the filters look broken right after an import.
   */
  private matchesNarrationFilter(item: StudioItem): boolean {
    const f = this.narrationFilter();
    if (f === 'all') return true;
    if (f === 'tts') return !item.hasProfessionalNarration || !!item.hasAiNarration;
    return !!item.hasProfessionalNarration;
  }

  toggleTag(tag: string): void {
    this.activeTag.set(this.activeTag() === tag ? null : tag);
  }

  readonly filteredBooks = computed(() => {
    const q = this.debouncedQuery().trim();
    let books = this.studioService.books();
    if (this.activeTag()) books = books.filter(b => this.matchesTagFilter(b));
    if (this.narrationFilter() !== 'all') books = books.filter(b => this.matchesNarrationFilter(b));
    if (q) books = books.filter(b => this.matchesSearch(b, q));
    return books;
  });

  readonly filteredArticles = computed(() => {
    const q = this.debouncedQuery().trim();
    let articles = this.studioService.articles();
    if (this.activeTag()) articles = articles.filter(a => this.matchesTagFilter(a));
    if (q) articles = articles.filter(a => this.matchesSearch(a, q));
    return articles;
  });

  readonly filteredArchived = computed(() => {
    const q = this.debouncedQuery().trim();
    let archived = this.studioService.archived();
    if (this.activeTag()) archived = archived.filter(a => this.matchesTagFilter(a));
    // Narration applies to archived BOOKS too — an active filter that visibly skipped
    // the archived section would read as broken. Articles have no narration, so they
    // are unaffected by it rather than filtered out.
    if (this.narrationFilter() !== 'all') {
      archived = archived.filter(a => a.type !== 'book' || this.matchesNarrationFilter(a));
    }
    if (q) archived = archived.filter(a => this.matchesSearch(a, q));
    return archived;
  });

  // Combined collection for the Browse grid. Title/date sorts interleave books
  // and articles into one true order; Custom keeps them grouped (books then
  // articles) since each type owns a separate manual sortOrder space.
  readonly browseItems = computed(() => {
    const combined = [...this.filteredBooks(), ...this.filteredArticles()];
    const sort = this.studioService.sort();
    return sort.field === 'custom' ? combined : sortStudioItems(combined, sort);
  });

  // Tab navigation
  readonly mainTab = signal<MainTab>('files');
  readonly audiobookSubTab = signal<AudiobookSubTab>('process');
  readonly llSubTab = signal<LanguageLearningSubTab>('process');

  // Four-tab book view modes.
  readonly versionsPanel = signal<'none' | 'skipped'>('none'); // inline panel in Versions tab
  // Set by a row-level Generate/Regenerate action. The modal receives this exact
  // target and never offers a second source picker.
  readonly analysisTarget = signal<StudioAnalysisTarget | null>(null);
  readonly versionsComparing = signal(false); // a version Compare is open — go full-height, hide metadata editor

  readonly processStep = signal<ProcessStep>('cleanup');
  // IDs of items whose metadata save is in flight. Per-item so saving book A
  // then switching to book B doesn't show B's editor as "Saving...".
  readonly savingMetadataIds = signal<Set<string>>(new Set());
  readonly finalizingContent = signal<'idle' | 'saving' | 'done'>('idle');
  readonly disabledTabMessage = signal<string | null>(null);
  readonly filesRefreshTrigger = signal<number>(0);

  // Analytics tab (job performance history), loaded lazily on tab open.
  readonly jobAnalytics = signal<ProjectAnalytics | null>(null);
  readonly analyticsLoading = signal<boolean>(false);

  // Version picker dialog
  readonly showVersionPicker = signal<boolean>(false);
  readonly versionPickerData = signal<VersionPickerDialogData | null>(null);

  // Context menu
  readonly contextMenuVisible = signal<boolean>(false);
  readonly contextMenuX = signal<number>(0);
  readonly contextMenuY = signal<number>(0);
  readonly contextMenuItem = signal<StudioItem | null>(null);
  @ViewChild('contextMenuEl') contextMenuEl?: ElementRef<HTMLElement>;

  // Export EPUB picker
  readonly epubPickerVisible = signal<boolean>(false);
  readonly epubPickerOptions = signal<Array<{ label: string; description: string; path: string }>>([]);
  private epubExportItem: StudioItem | null = null;

  // Export status toast
  readonly exportStatus = signal<string | null>(null);

  // Inline diff view (shown in Files tab)
  readonly diffPaths = signal<DiffRequest | null>(null);

  // Cached TTS session for reassembly
  readonly cachedSession = signal<any>(null);

  // Correct Sentences flow active (swaps the Audiobook tab content in-place)
  readonly correctSentencesActive = signal(false);

  // Bumped when the user hits "Continue" on the Versions panel — the Processing
  // wizard watches this to jump to the TTS step with the original run's settings.
  readonly continueRequest = signal(0);

  // Bumped when narration is asked for — by a document row's Process button, or
  // by the picker's Next arriving through `app:show-narration`. The wizard
  // watches this to stand on the TTS step. Distinct from continueRequest, which
  // resumes an interrupted render and refuses when there is nothing to resume.
  readonly narrationRequest = signal(0);

  /**
   * The project list has been read at least once.
   *
   * The narration hand-off needs it: the request can arrive before this window
   * has any projects loaded (the shell navigates here the moment main sends the
   * event), and looking a book up in an empty list would report it missing when
   * nothing is missing. This is not a copy of anything — it is this component's
   * own lifecycle, which nothing else can answer.
   */
  private readonly itemsLoaded = signal(false);

  /**
   * Narration was asked for elsewhere — the picker's Next, via the shell.
   *
   * Consumed here rather than delivered by a listener because this component is
   * lazily routed and is usually NOT mounted when the request is made; see
   * NarrationHandoffService. Taking it empties it, which is what lets the same
   * book be handed over twice.
   */
  private readonly narrationHandoffEffect = effect(() => {
    if (!this.itemsLoaded()) return;
    const dir = this.narrationHandoff.pending();
    if (dir === null) return;
    this.narrationHandoff.take();
    void this.openNarrationFor(dir);
  }, { allowSignalWrites: true });

  // Watch selectedItem changes to check for cached sessions
  private readonly cachedSessionEffect = effect(() => {
    const item = this.selectedItem();
    if (item?.projectDir) {
      this.checkCachedSession(item.projectDir);
    } else {
      this.cachedSession.set(null);
    }
  }, { allowSignalWrites: true });

  // Full-resolution cover for the metadata editor preview, loaded on demand when a
  // book is selected. The list/grid coverData is only a ~200px thumbnail (see
  // StudioService), which must NOT feed the editor — it would look soft and, on
  // save, downsize the stored cover. undefined while loading / for cover-less items.
  readonly editorCoverData = signal<string | undefined>(undefined);
  private editorCoverItemId = '';
  private readonly editorCoverEffect = effect(() => {
    const item = this.selectedItem();
    const relPath = item?.coverRelPath;
    const itemId = item?.id ?? '';
    // Clear only when the SELECTION changed, so a newly selected book never flashes
    // the previous book's cover. A same-book refresh — which is what saving a new
    // cover produces — must keep showing the current one until the new file loads,
    // otherwise the preview visibly blanks on every save.
    if (itemId !== this.editorCoverItemId) {
      this.editorCoverItemId = itemId;
      this.editorCoverData.set(undefined);
    }
    // A book with no cover has nothing to show, same-book refresh or not.
    if (!relPath) {
      this.editorCoverData.set(undefined);
      return;
    }
    const forId = item!.id;
    // No maxWidth → full-res.
    void this.electronService.mediaLoadImage(relPath).then(res => {
      // Drop a stale load if the selection changed while this was in flight.
      if (this.selectedItem()?.id !== forId) return;
      if (res.success && res.data) this.editorCoverData.set(res.data);
    });
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
      // Full-res cover loaded on demand (see editorCoverEffect). Never the 200px
      // list thumbnail — that would leak into the preview and downsize on save.
      coverData: this.editorCoverData(),
      outputFilename: item.outputFilename,
      contributors: item.contributors,
      tags: item.tags,
      // The project folder name (last path segment) — shown/edited in the slug field.
      slug: (item.projectDir || item.id || '').split(/[\\/]/).filter(Boolean).pop() || '',
    };
  });

  /**
   * The document the Process wizard works on: the cleanup output if there is one,
   * else the source. '' means the project has NO document to process — the Process
   * tab shows an explanation instead of the wizard. `epubPath` is null for a project
   * with no source document on disk (see StudioItem.epubPath), and that null must
   * stay visible here: it used to be a synthesized source/original.epub, which made
   * this truthy for books that had nothing, handing the wizard a file that wasn't
   * there.
   */
  readonly currentEpubPath = computed<string>(() => {
    const item = this.selectedItem();
    if (!item) return '';
    return item.cleanedEpubPath || item.epubPath || '';
  });

  /**
   * The file a Process button NAMED, when the user reached this tab through one.
   *
   * Null is the ordinary state — the Process tab clicked directly, or Continue
   * and Assemble, none of which is a statement about a document. It is not a
   * default for a failed lookup: it is the difference between "narrate this
   * file" and "narrate this project's book", and those are two genuinely
   * different requests now that the versions page shows both the book and the
   * narration copy cut from it as their own lines.
   *
   * Cleared whenever the selected book changes, because a path from another
   * project's page is not this one's document.
   */
  private readonly narrationDocument = signal<string | null>(null);

  /**
   * The document the Process wizard is given.
   *
   * The named file when a Process button named one, and the project's own book
   * otherwise. Not a fallback for a missing value — the two are separate
   * requests, and which one was made is recorded rather than guessed.
   */
  readonly processEpubPath = computed<string>(() =>
    this.narrationDocument() ?? this.currentEpubPath());

  /**
   * True when the user hasn't finalized via the editor yet (no export recorded).
   *
   * Answered by StudioItem.exportedEpubPath, which comes from the manifest's
   * `outputs.epub` record: the export is named after the book, so the filename
   * is not evidence of anything.
   *
   * A project with no source document at all answers FALSE: it is not waiting to be
   * exported, it has nothing to export FROM.
   *
   * This decides which EDITOR entry point to open — it no longer gates the Process
   * tab. Processing a book that was never opened in the editor is legitimate: the
   * pass builder scans a PDF itself, and an EPUB-sourced run never needs the editor
   * at all. The wall that stood here blocked both.
   */
  readonly needsExport = computed(() => {
    const item = this.selectedItem();
    if (!item?.epubPath) return false;
    return !item.exportedEpubPath;
  });

  // Check if mono audiobook exists
  readonly hasMonoAudio = computed(() => {
    const item = this.selectedItem();
    return !!item?.audiobookPath && !!item?.vttPath;
  });

  /**
   * Whether "Export EPUB…" has anything to offer for the right-clicked item.
   *
   * Exactly the versions openExportEpubPicker() would list, so the menu entry can't
   * be offered into an empty picker (which silently does nothing) or hidden while
   * versions exist. It used to be gated on `epubPath` alone — which was never falsy,
   * because a missing source was papered over with an invented path, so the entry was
   * offered for books with no EPUB at all. Now epubPath can legitimately be null, and
   * a project can still have a cleaned or translated EPUB worth exporting.
   */
  readonly contextMenuHasExportableEpub = computed(() => {
    const item = this.contextMenuItem();
    return !!item && !!(item.epubPath || item.cleanedEpubPath || item.translatedEpubPath);
  });

  // Check if bilingual audiobook exists
  readonly hasBilingualAudio = computed(() => {
    const item = this.selectedItem();
    if (!item) return false;
    if (item.bilingualOutputs && Object.keys(item.bilingualOutputs).length > 0) return true;
    return !!item.bilingualAudioPath && !!item.bilingualVttPath;
  });

  // The Listen window can play an M4B or stream any EPUB — enabled if either exists
  readonly canListen = computed(() =>
    !!this.currentEpubPath() || this.hasMonoAudio() || this.hasBilingualAudio()
  );

  // Determine if current tab should use full height (no padding)
  readonly isFullHeightTab = computed(() => {
    const main = this.mainTab();
    if (main === 'content') return true;       // article editor
    if (main === 'audiobook') return true;     // Process wizard
    if (main === 'skipped') return true;       // skipped-chunks panel (manages its own scroll)
    if (main === 'files') return this.versionsPanel() !== 'none' || this.versionsComparing(); // inline panel or compare
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
    // Only now can a project be looked up by name — see itemsLoaded.
    this.itemsLoaded.set(true);
    this.loadAllTags();
    document.addEventListener('click', () => this.hideContextMenu());

    // Listen for editor window close events to refresh the item
    this.electronService.onEditorWindowClosed((projectPath: string) => {
      const item = this.selectedItem();
      if (item?.projectDir === projectPath || item?.epubPath === projectPath) {
        this.refreshProjectFiles();
      }
    });

    // Listen for file save events from editor windows (updates file list in real time)
    this.electronService.onProjectFilesChanged((projectPath: string) => {
      const item = this.selectedItem();
      if (item?.projectDir === projectPath || item?.id === projectPath) {
        this.refreshProjectFiles();
      }
    });
  }

  ngOnDestroy(): void {
    this.electronService.offEditorWindowClosed();
    this.electronService.offProjectFilesChanged();
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
  }

  private async loadAllTags(): Promise<void> {
    const tags = await this.electronService.manifestGetAllTags();
    this.allTags.set(tags);
  }

  private refreshProjectFiles(): void {
    this.filesRefreshTrigger.update(v => v + 1);
    const id = this.selectedItemId();
    if (id) {
      this.studioService.reloadItem(id);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  setMainTab(tab: MainTab): void {
    this.mainTab.set(tab);
    this.disabledTabMessage.set(null);
    this.diffPaths.set(null);
    if (tab === 'analytics') {
      void this.loadAnalytics();
    }
  }

  /** A version-row action opens configuration already locked to that source. */
  onGenerateAnalysis(target: StudioAnalysisTarget): void {
    const item = this.selectedItem();
    if (!item) return;
    const selectedProjectId = studioManifestProjectId(item);
    if (target.projectId !== selectedProjectId) {
      void this.electronService.showMessageDialog({
        title: 'Could not open analysis',
        message: 'The selected project changed before the analysis window could open. Please try again.',
        type: 'error',
      });
      return;
    }
    this.analysisTarget.set(target);
  }

  onAnalysisQueued(): void {
    this.analysisTarget.set(null);
    this.onProcessQueued();
  }

  // Job performance history — loaded lazily from {projectDir}/job-analytics.json
  // when the Analytics tab is opened. Content analysis lives in the row modal.
  private async loadAnalytics(): Promise<void> {
    const dir = this.selectedItem()?.projectDir;
    if (!dir) { this.jobAnalytics.set(null); return; }
    this.analyticsLoading.set(true);
    try {
      const res = await (window as any).electron?.audiobook?.getAnalytics?.(dir);
      this.jobAnalytics.set(res?.success ? (res.analytics as ProjectAnalytics | null) : null);
    } catch {
      this.jobAnalytics.set(null);
    } finally {
      this.analyticsLoading.set(false);
    }
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

  /** Jump to the Processing (audiobook) tab from the Versions cache row. The
   *  ll-wizard there detects the cached/partial session and offers the same
   *  resume ("Continue", original settings via checkResumeFromDir) and
   *  assemble-from-cache flows — so Versions delegates rather than duplicating
   *  job-launch logic. */
  goToProcessing(): void {
    this.mainTab.set('audiobook');
    this.versionsPanel.set('none');
    this.versionsComparing.set(false);
  }

  /** Launch the Correct Sentences pipeline from the Versions "rendered sentences" row.
   *  Mirrors goToProcessing's tab switch, then activates the in-place pipeline. */
  startCorrectSentences(): void {
    this.goToProcessing();
    this.correctSentencesActive.set(true);
  }

  /**
   * Narration: the Process tab, with the wizard standing on the TTS step.
   *
   * The one destination both doors go to — a document row's Process button and
   * the picker's Next (docs/PIPELINE_V2_PLAN.md, Phase C). Written once here so
   * "Process" cannot come to mean two slightly different places depending on
   * which button was pressed. It reuses goToProcessing exactly as Continue and
   * Assemble do; the bump is what the wizard listens for.
   */
  goToNarration(document?: string): void {
    this.goToProcessing();
    // WHICH file, when the caller named one. The versions page's Process button
    // does (Owen, 2026-08-09: "the tts pipeline knows exactly which file its
    // working with because the user came to the tts page FROM the button on that
    // document"), and the wizard is handed that file rather than looking one up.
    // Cleared when it did not, so the previous press cannot leak into a Process
    // reached by another door.
    this.narrationDocument.set(document ?? null);
    // Re-read the selected project first. The versions page re-measures itself
    // on `document:stage-finished` and the ITEM does not, so a book built in the
    // picker a moment ago can be showing an EPUB row here while the record this
    // tab reads (`currentEpubPath`) still predates it — and the Process tab
    // answers an empty one with "No EPUB available for processing".
    void this.onFileChanged();
    this.narrationRequest.update(n => n + 1);
  }

  /**
   * The picker handed a finished book over and the shell brought us here.
   *
   * Selecting the project is the whole reason this is not just a route: the
   * Process tab shows the wizard for the SELECTED book, so a hand-off that only
   * switched tabs would narrate whichever book happened to be open.
   *
   * The list is re-read FIRST, every time. The book the picker is handing over
   * was written moments ago, so whatever this window is holding predates it: the
   * Process tab shows the wizard only when the project has a document
   * (`currentEpubPath`), and a record read before the EPUB existed is exactly
   * how a freshly built book arrives reading as a book with nothing to narrate.
   * It also makes the missing-project message a measurement rather than a
   * report about a list that was already old.
   */
  private async openNarrationFor(projectDir: string): Promise<void> {
    await this.studioService.loadAll();

    // Archived books are searched too: being archived is not being gone, and a
    // book the picker had open is one the user is plainly still working on.
    // Matched with samePath because the two spellings come from different hands
    // — main resolves with backslashes on Windows, the studio list joins with
    // forward slashes — and two spellings of one directory are not two books.
    const item = [...this.studioService.books(), ...this.studioService.archived()]
      .find(b => !!b.projectDir && samePath(b.projectDir, projectDir));

    if (!item) {
      void this.electronService.showMessageDialog({
        title: 'Could not open narration',
        message: `BookForge has no project at ${projectDir}, so there is no book to narrate. `
          + 'It may have been deleted or moved since the editor window was opened.',
        type: 'error',
      });
      return;
    }

    this.openInWorkspace(item);
    this.goToNarration();
  }

  /** Versions "Continue": open the Processing tab AND tell the wizard to enter Continue
   *  mode — land on the TTS step, disable Cleanup/Translate, and pre-fill the original
   *  run's settings (all editable). Distinct from Assemble, which just opens the tab. */
  onContinueJob(): void {
    this.goToProcessing();
    this.continueRequest.update(n => n + 1);
  }

  /** Open the dedicated player window for the selected book. When a specific
   *  audiobook variant's path is given (from the Versions Audio row), the player
   *  opens on THAT audiobook rather than the project's first/registered one. */
  openListen(audioPath?: string): void {
    const item = this.selectedItem();
    if (!item?.projectDir) return;
    void this.electronService.openListenWindow(item.projectDir, audioPath);
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
    this.versionsPanel.set('none');
    this.versionsComparing.set(false);
    this.finalizingContent.set('idle');
    this.diffPaths.set(null);
    // A file named by a Process button belongs to the book it was pressed on.
    // Another book is another document, and carrying the old path across would
    // point the Process wizard at a file that is not in this project.
    this.narrationDocument.set(null);
  }

  playItem(item: StudioItem): void {
    this.selectedItemId.set(item.id);
    if (item.projectDir) {
      void this.electronService.openListenWindow(item.projectDir);
    }
  }

  // Open a book from the Browse grid into the Studio workspace.
  openInWorkspace(item: StudioItem): void {
    this.selectItem(item);
    this.viewMode.set('workspace');
  }

  // Quick "Edit" from the Browse context menu — open the PDF/EPUB editor without
  // leaving Browse (the editor opens in its own window).
  editFromBrowse(item: StudioItem): void {
    this.selectItem(item);
    void this.openEditor();
  }

  // Quick "Export audiobook" from the Browse context menu.
  exportFromBrowse(item: StudioItem): void {
    this.contextMenuItem.set(item);
    void this.exportM4b();
  }

  // "Classify as Book/Article" from the Browse context menu. Browse has no
  // multi-selection, so this is always the one clicked item.
  reclassifyFromBrowse(item: StudioItem): void {
    this.contextMenuItem.set(item);
    this.contextMenuSelectedIds.set([item.id]);
    void this.reclassifyContextMenuItem();
  }

  onItemAdded(item: StudioItem): void {
    this.selectItem(item);
  }

  onItemChanged(): void {
    this.refreshProjectFiles();
  }

  async onFileChanged(): Promise<void> {
    const id = this.selectedItemId();
    if (id) {
      await this.studioService.reloadItem(id);
    }
  }

  /**
   * Open the editor for a specific file path (from file browser).
   * Routes through the version picker for projects.
   */
  async openEditorWithFile(filePath: string): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    if (item.projectDir) {
      await this.openEditorWithProjectDir(item.projectDir, filePath);
    } else {
      await this.openEditorWithVersion(filePath);
    }
  }

  /**
   * Open a book VARIANT file directly in the editor as a standalone document
   * (no project state), so a reader can view/edit that specific edition. Only
   * EPUB/PDF variants offer this (the editor is mupdf-backed).
   */
  async openVariantInEditor(filePath: string): Promise<void> {
    const result = await this.electronService.editorOpenWindow(filePath);
    if (!result.success) {
      console.error('[Studio] Failed to open version in editor:', result.error);
      void this.electronService.showMessageDialog({
        title: 'Could not open editor',
        message: result.error || 'Failed to open this edition in the editor.',
        type: 'error',
      });
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
    if (!item?.projectDir) return '';
    return item.projectDir;
  }

  getAudiobookFolder(): string {
    const item = this.selectedItem();
    if (!item?.projectDir) return '';
    return `${item.projectDir}/output`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cached Session
  // ─────────────────────────────────────────────────────────────────────────

  async checkCachedSession(projectDir: string): Promise<void> {
    const electron = (window as any).electron;
    if (!electron?.reassembly?.getBfpSession) return;
    const result = await electron.reassembly.getBfpSession(projectDir);
    if (result.success && result.data) {
      this.cachedSession.set(result.data);
    } else {
      this.cachedSession.set(null);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context Menu
  // ─────────────────────────────────────────────────────────────────────────

  // Multi-selection context (IDs from the list component for bulk operations)
  readonly contextMenuSelectedIds = signal<string[]>([]);

  onContextMenu(event: { event: MouseEvent; item: StudioItem; selectedIds: string[] }): void {
    event.event.preventDefault();
    this.contextMenuItem.set(event.item);
    this.contextMenuSelectedIds.set(event.selectedIds);
    this.contextMenuX.set(event.event.clientX);
    this.contextMenuY.set(event.event.clientY);
    this.contextMenuVisible.set(true);

    // Clamp position after the menu renders so it stays within the viewport
    requestAnimationFrame(() => {
      const el = this.contextMenuEl?.nativeElement;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        this.contextMenuY.set(Math.max(0, window.innerHeight - rect.height - 8));
      }
      if (rect.right > window.innerWidth) {
        this.contextMenuX.set(Math.max(0, window.innerWidth - rect.width - 8));
      }
    });
  }

  hideContextMenu(): void {
    this.contextMenuVisible.set(false);
  }

  openContextMenuItemFolder(): void {
    const item = this.contextMenuItem();
    if (!item?.projectDir) return;
    this.electronService.showItemInFolder(item.projectDir);
    this.hideContextMenu();
  }

  async deleteContextMenuItem(): Promise<void> {
    const item = this.contextMenuItem();
    if (!item) return;
    const selectedIds = this.contextMenuSelectedIds();
    const ids = selectedIds.length > 1
      ? selectedIds
      : [item.id];
    const failures: string[] = [];
    for (const id of ids) {
      const result = await this.studioService.deleteItem(id);
      if (result.success) {
        if (this.selectedItemId() === id) this.selectedItemId.set(null);
      } else {
        failures.push(result.error || 'Unknown error');
      }
    }
    if (failures.length > 0) {
      // Surface the failure instead of silently leaving the folder on disk.
      this.exportStatus.set(`Couldn't delete ${failures.length} item${failures.length > 1 ? 's' : ''}: ${failures[0]}`);
    }
    this.hideContextMenu();
  }

  /**
   * Move the context-menu item (or the whole selection) between the Books and
   * Articles sections. The clicked item decides the direction, so a mixed
   * selection all ends up on the same side — which is the only reading of
   * "Classify as Book" that isn't a surprise.
   */
  async reclassifyContextMenuItem(): Promise<void> {
    const item = this.contextMenuItem();
    if (!item) return;
    this.hideContextMenu();

    const target: StudioItemType = item.type === 'article' ? 'book' : 'article';
    const selectedIds = this.contextMenuSelectedIds();
    const ids = selectedIds.length > 1 ? selectedIds : [item.id];
    const wasSelected = ids.includes(this.selectedItemId() ?? '');

    const converted = await this.studioService.setItemType(ids, target);
    if (converted.length === 0) {
      this.exportStatus.set(`Couldn't classify as ${target === 'book' ? 'book' : 'article'}`);
      setTimeout(() => this.exportStatus.set(null), 3000);
      return;
    }

    // A converted item's id changes form (a book's id is its project directory,
    // an article's is its manifest id), so a selection pointing at the old one
    // now points at nothing. Re-point it rather than silently clearing the pane.
    if (wasSelected) {
      const stillThere = converted.find(id => !!this.studioService.getItem(id));
      this.selectedItemId.set(stillThere ?? null);
    }

    this.exportStatus.set(
      converted.length > 1
        ? `Classified ${converted.length} items as ${target === 'book' ? 'books' : 'articles'}`
        : `Classified as ${target === 'book' ? 'book' : 'article'}`,
    );
    setTimeout(() => this.exportStatus.set(null), 3000);
  }

  async archiveContextMenuItem(): Promise<void> {
    const item = this.contextMenuItem();
    if (!item) return;
    const selectedIds = this.contextMenuSelectedIds();
    const ids = selectedIds.length > 1
      ? selectedIds
      : [item.id];
    if (item.archived) {
      await this.studioService.unarchiveItems(ids);
    } else {
      await this.studioService.archiveItems(ids);
    }
    this.hideContextMenu();
  }

  /**
   * Export an audiobook to a user-chosen location. Called two ways:
   *  - From the Versions Audio row with the CLICKED variant's absolute m4b path.
   *  - From the Browse/context menu with no argument, in which case it targets
   *    the context-menu item's registered audiobook.
   */
  async exportM4b(m4bPath?: string): Promise<void> {
    let sourcePath = m4bPath;
    let defaultName = m4bPath ? (m4bPath.split(/[\\/]/).pop() || 'audiobook.m4b') : '';
    if (!sourcePath) {
      const item = this.contextMenuItem();
      if (!item?.audiobookPath) return;
      this.hideContextMenu();
      sourcePath = item.audiobookPath;
      // Use the metadata-defined output filename, else the on-disk filename.
      defaultName = item.outputFilename
        || item.audiobookPath.split('/').pop()
        || 'audiobook.m4b';
    }

    // Use external audiobooks folder as default directory if configured
    const defaultDir = this.settingsService.get<string>('externalAudiobooksDir') || '';

    const electron = (window as any).electron;
    const result = await electron.dialog.saveM4b(defaultName, defaultDir || undefined);
    if (!result?.success || !result.filePath) return;

    try {
      await electron.audiobook.copyToPath(sourcePath, result.filePath);
      this.exportStatus.set('Exported M4B successfully');
      setTimeout(() => this.exportStatus.set(null), 3000);
    } catch (err) {
      console.error('[STUDIO] Export M4B failed:', err);
      this.exportStatus.set('Export failed');
      setTimeout(() => this.exportStatus.set(null), 3000);
    }
  }

  openExportEpubPicker(): void {
    const item = this.contextMenuItem();
    if (!item) return;
    this.hideContextMenu();

    // Build available versions
    const options: Array<{ label: string; description: string; path: string }> = [];
    if (item.epubPath) {
      options.push({ label: 'Source', description: 'Original imported EPUB', path: item.epubPath });
    }
    if (item.cleanedEpubPath) {
      const label = item.hasSimplified ? 'Simplified' : 'Cleaned';
      const desc = item.hasSimplified ? 'AI-simplified for language learning' : 'AI-cleaned text';
      options.push({ label, description: desc, path: item.cleanedEpubPath });
    }
    if (item.translatedEpubPath) {
      options.push({ label: 'Translated', description: 'Full-book translation', path: item.translatedEpubPath });
    }

    if (options.length === 0) return;

    // If only one version, skip the picker and go straight to save
    if (options.length === 1) {
      this.epubExportItem = item;
      this.exportDocument(options[0].path);
      return;
    }

    this.epubExportItem = item;
    this.epubPickerOptions.set(options);
    this.epubPickerVisible.set(true);
  }

  /**
   * Export a document: give the user a copy, somewhere they chose.
   *
   * ONE entry point, two mechanisms, chosen by what the file IS.
   *
   * An EPUB export is not a copy — `pipeline.exportEpub` re-packages the book
   * with this project's title, author and cover, which is the whole point of
   * exporting a book and is only meaningful on an EPUB. Every other document
   * the versions page lists is a PDF (the archive original, the working copy),
   * and re-packaging one as an EPUB is not a thing: its export is its bytes,
   * unchanged, through the same save-a-copy path the M4B export uses.
   *
   * The branch lives here rather than in two callers so there is still exactly
   * one Export in the app. Before this, an Export on a PDF row would have been
   * handed to the EPUB packer, which opens it as a zip.
   */
  async exportDocument(selectedPath: string): Promise<void> {
    this.epubPickerVisible.set(false);
    if (!selectedPath) return;

    const isEpub = selectedPath.toLowerCase().endsWith('.epub');
    if (!isEpub) {
      const name = selectedPath.split(/[\\/]/).pop();
      if (!name) {
        this.exportStatus.set('Export failed: that path names no file');
        setTimeout(() => this.exportStatus.set(null), 3000);
        return;
      }
      const copied = await this.electronService.saveFileCopy(selectedPath, name);
      if (copied.canceled) return;
      this.exportStatus.set(copied.success
        ? 'Exported a copy successfully'
        : `Export failed: ${copied.error || 'Unknown error'}`);
      setTimeout(() => this.exportStatus.set(null), 3000);
      return;
    }

    // Whose metadata the exported book carries. TWO callers, two sources, not a
    // fallback: the context menu PINS an item because it can act on a row that
    // is not the selected one, while an Export pressed on the Versions tab is
    // always about the book on screen. Reading only the pinned one made the
    // versions-page Export do nothing at all until the context-menu picker had
    // been used once in the same session.
    const item = this.epubExportItem ? this.epubExportItem : this.selectedItem();
    this.epubExportItem = null;
    if (!item) {
      this.exportStatus.set('Export failed: no book is selected');
      setTimeout(() => this.exportStatus.set(null), 3000);
      return;
    }

    const metadata: any = {};
    if (item.title) metadata.title = item.title;
    if (item.author) metadata.author = item.author;
    if (item.year) metadata.year = item.year;
    if (item.language) metadata.language = item.language;
    if (item.contributors) metadata.contributors = item.contributors;

    const electron = (window as any).electron;
    try {
      const result = await electron.pipeline.exportEpub(selectedPath, metadata, item.coverPath || undefined);
      if (result?.canceled) return;
      if (result?.success) {
        this.exportStatus.set('Exported EPUB successfully');
      } else {
        this.exportStatus.set(`Export failed: ${result?.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('[STUDIO] Export EPUB failed:', err);
      this.exportStatus.set('Export failed');
    }
    setTimeout(() => this.exportStatus.set(null), 3000);
  }

  hasAnyStage(): boolean {
    const item = this.contextMenuItem();
    if (!item) return false;
    return !!(item.hasCleaned || item.hasSimplified || item.hasCleanupCheckpoint || item.hasTranslated || item.hasTtsCache || item.audiobookPath || item.bilingualAudioPath);
  }

  async deleteStage(stage: 'cleanup' | 'simplify' | 'translation' | 'tts' | 'output'): Promise<void> {
    const item = this.contextMenuItem();
    if (!item?.projectDir) return;
    this.hideContextMenu();

    const electron = (window as any).electron;
    const labels: Record<string, string> = {
      cleanup: 'AI Cleanup',
      simplify: 'AI Simplify',
      translation: 'Translation',
      tts: 'TTS Cache',
      output: 'Output',
    };

    try {
      let result: { success: boolean; message?: string; error?: string };
      switch (stage) {
        case 'cleanup':
          result = await electron.pipeline.deleteCleanup(item.projectDir);
          break;
        case 'simplify':
          result = await electron.pipeline.deleteSimplify(item.projectDir);
          break;
        case 'translation':
          result = await electron.pipeline.deleteTranslation(item.projectDir);
          break;
        case 'tts':
          result = await electron.pipeline.deleteTtsCache(item.projectDir);
          break;
        case 'output':
          result = await electron.pipeline.deleteOutput(item.projectDir);
          break;
      }

      if (result.success) {
        this.exportStatus.set(`Deleted ${labels[stage]}`);
        // Refresh the list flags AND the open Versions tab / wizards so the
        // change is reflected immediately (no app restart needed).
        await this.studioService.loadBooks();
        this.refreshProjectFiles();
      } else {
        this.exportStatus.set(`Failed to delete ${labels[stage]}: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(`[STUDIO] Delete ${stage} failed:`, err);
      this.exportStatus.set(`Failed to delete ${labels[stage]}`);
    }
    setTimeout(() => this.exportStatus.set(null), 3000);
  }

  async resetEditorState(): Promise<void> {
    const item = this.contextMenuItem();
    if (!item?.projectDir) return;
    this.hideContextMenu();

    const projectDir = item.projectDir;
    // The export is named after the book — StudioItem carries the manifest
    // record's path, and null means the project has never exported.
    const exportedPath = item.exportedEpubPath;
    const exportedName = exportedPath ? exportedPath.split(/[\\/]/).pop() : null;

    const detail = [
      'This clears every edit you made in the editor for this source:',
      '  • deleted blocks and deleted pages',
      '  • text corrections and block edits',
      '  • block splits and merges',
      '  • chapter markers',
      '  • crop regions',
      '  • category learning and custom categories',
      '  • undo / redo history',
      '',
      'The archive/original source file itself is NOT touched — re-opening the editor starts fresh, as if the file had just been imported.',
    ].join('\n');

    const { confirmed, checkboxChecked } = await this.electronService.showConfirmDialog({
      title: 'Reset edits',
      message: `Reset all editor edits for "${item.title || 'this project'}"?`,
      detail,
      confirmLabel: 'Reset edits',
      type: 'warning',
      checkboxLabel: exportedName ? `Also delete ${exportedName}` : undefined,
    });
    if (!confirmed) return;

    try {
      // WHICH working chain's records are cleared. The row carries it; null
      // means this listing could not place the project's book — a project with
      // two versions, where main refuses in its own words rather than clearing
      // the curation of whichever the code reached first.
      const result = await this.electronService.resetEditorState(
        projectDir, item.familyId ?? undefined);

      if (result.success) {
        // Opt-in export deletion via the same deleteFile mechanism.
        if (checkboxChecked && exportedPath) {
          await this.electronService.deleteFile(exportedPath);
        }
        this.exportStatus.set('Editor state reset');
        await this.studioService.loadBooks();
        this.refreshProjectFiles();
      } else {
        this.exportStatus.set(`Failed to reset: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('[STUDIO] Reset editor state failed:', err);
      this.exportStatus.set('Failed to reset editor state');
    }
    setTimeout(() => this.exportStatus.set(null), 3000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drag/Drop File Import
  // ─────────────────────────────────────────────────────────────────────────

  onStudioDragEnter(e: DragEvent): void {
    e.preventDefault();
    this.dragCounter++;
    if (e.dataTransfer?.types.includes('Files')) {
      this.showDropOverlay.set(true);
    }
  }

  onStudioDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  onStudioDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.dragCounter = 0;
      this.showDropOverlay.set(false);
    }
  }

  onStudioDrop(e: DragEvent): void {
    e.preventDefault();
    this.showDropOverlay.set(false);
    this.dragCounter = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = (files[i] as any).path;
      if (filePath) paths.push(filePath);
    }
    if (paths.length === 0) return;

    this.dragDropFiles.set(paths);
    this.showAddModal.set(true);
  }

  onAddModalClose(): void {
    this.showAddModal.set(false);
    this.dragDropFiles.set([]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drag/Drop Reorder & Archive
  // ─────────────────────────────────────────────────────────────────────────

  onReorder(event: { section: 'articles' | 'books' | 'archived'; orderedIds: string[] }): void {
    // A manual drag defines the custom order, so switch to it (unless it's
    // already custom) and persist the new sequence.
    if (this.studioService.sort().field !== 'custom') {
      this.studioService.setSortField('custom');
    }
    this.studioService.reorderItems(event.section, event.orderedIds);
  }

  /**
   * Reorder from the Browse grid, which mixes books and articles. Switch to
   * Custom and persist each type's new relative order (the grid groups books
   * before articles in Custom, so cross-type position resolves to rank within
   * the dragged item's own type).
   */
  onBrowseReorder(orderedIds: string[]): void {
    if (this.studioService.sort().field !== 'custom') {
      this.studioService.setSortField('custom');
    }
    const items = orderedIds
      .map(id => this.studioService.getItem(id))
      .filter((i): i is StudioItem => !!i);
    const bookIds = items.filter(i => i.type === 'book').map(i => i.id);
    const articleIds = items.filter(i => i.type === 'article').map(i => i.id);
    void this.studioService.reorderItems('books', bookIds);
    void this.studioService.reorderItems('articles', articleIds);
  }

  async onArchive(ids: string[]): Promise<void> {
    await this.studioService.archiveItems(ids);
  }

  async onUnarchive(ids: string[]): Promise<void> {
    await this.studioService.unarchiveItems(ids);
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

  onSaveMetadata(metadata: EpubMetadata): void {
    const item = this.selectedItem();
    if (!item || item.type !== 'book') return;

    // Run the write (manifest + EPUB cover/metadata rewrites + M4B tag/cover
    // rewrite) in the BACKGROUND so the user can immediately select and edit the
    // next book instead of waiting for a multi-hundred-MB M4B rewrite to finish.
    // The per-book id in savingMetadataIds drives a "Saving…" badge on THIS book
    // only; switching books gives a fresh, un-blocked editor. Failures surface
    // loudly via a dialog (no silent no-op); success is optimistic.
    const savingId = item.id;
    this.savingMetadataIds.update(ids => new Set(ids).add(savingId));
    this.studioService.updateBookMetadata(item.id, {
      title: metadata.title,
      author: metadata.author,
      year: metadata.year,
      language: metadata.language,
      coverData: metadata.coverData,
      outputFilename: metadata.outputFilename,
      contributors: metadata.contributors,
      tags: metadata.tags,
      slug: metadata.slug,
    }).then(result => {
      if (!result.success) {
        console.error('[Studio] Failed to save metadata:', result.error);
        // The common failure is a slug collision, which the user must act on
        // (pick a different folder name), not a silent no-op.
        void this.electronService.showMessageDialog({
          title: 'Could not save',
          message: result.error || 'Failed to save metadata for this book.',
          type: 'error',
        });
      } else if (result.warnings && result.warnings.length > 0) {
        // Saved, but one or more output files kept stale metadata/covers. A
        // partial condition, not a failure and not an interruption: the count
        // goes on the banner and WHICH files goes to the log.
        console.warn('[Studio] Metadata saved with warnings:', result.warnings);
        this.notices.notify(
          `Metadata was saved, but ${result.warnings.length} file(s) could not be updated — see `
          + 'the log for which.',
        );
      }
      this.loadAllTags();
    }).catch(err => {
      console.error('[Studio] Metadata save threw:', err);
      void this.electronService.showMessageDialog({
        title: 'Could not save',
        message: (err as Error).message || 'Failed to save metadata for this book.',
        type: 'error',
      });
    }).finally(() => {
      this.savingMetadataIds.update(ids => {
        const next = new Set(ids);
        next.delete(savingId);
        return next;
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Editor Window
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the path to use for the editor.
   * Prefers projectDir (existing project), falls back to epubPath (source file).
   */
  getEditorPath(): string | null {
    const item = this.selectedItem();
    if (!item) return null;

    // Prefer the project directory if available
    if (item.projectDir) {
      return item.projectDir;
    }

    // Fall back to source EPUB/PDF path
    if (item.epubPath) {
      return item.epubPath;
    }

    return null;
  }

  /**
   * Open the editor. A fresh project (nothing exported yet) opens its source book
   * directly: a single ebook edition is auto-picked; multiple editions pop a
   * picker so the user chooses which one to edit. Once editing has started
   * (exported/cleaned exist), the version picker offers the working files too.
   */
  async openEditor(): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    const projectId = item.projectDir ? (item.id.split(/[\\/]/).filter(Boolean).pop() || '') : '';

    // The book's ebook editions — the choices for which source to edit.
    let variantOptions: VariantOption[] = [];
    if (projectId) {
      try {
        const vres = await this.electronService.variantList(projectId);
        if (vres.success && vres.variants) {
          variantOptions = (vres.variants as Array<{ id: string; kind: string; format: string; descriptor?: string; metadata?: { title?: string } }>)
            .filter(v => v.kind === 'ebook')
            .map(v => {
              const t = (v.metadata?.title || '').trim();
              const d = (v.descriptor || '').trim();
              const label = t && d ? `${t} (${d})` : (t || d || 'Untitled edition');
              return { id: v.id, label, descriptor: v.descriptor, format: v.format, icon: '📖' };
            });
        }
      } catch { /* no variants — fall back to the resolved source path */ }
    }

    const fresh = this.needsExport() && !item.hasAnalysis;

    // Fresh project → pick which edition to edit.
    if (item.projectDir && fresh) {
      if (variantOptions.length > 1) { this.showSourcePicker(item, projectId, variantOptions); return; }
      if (variantOptions.length === 1) { await this.editEdition(item, projectId, variantOptions[0].id); return; }
      // No editions recorded — fall back to the resolved source path (legacy projects).
      if (item.epubPath) { await this.openEditorWithProjectDir(item.projectDir, item.epubPath); return; }
    }

    // Editing already started (exported/cleaned exist) or re-opening → version picker
    // (working files + editions). No project directory → open the source file directly.
    if (item.projectDir) { this.showSourcePicker(item, projectId, variantOptions); return; }
    if (item.epubPath) { this.openEditorWithVersion(item.epubPath); return; }

    // No project directory AND no source document on disk. There is nothing to open,
    // so say that rather than letting the click do nothing — epubPath is null for a
    // project with no source file (see StudioItem.epubPath), and the old invented
    // fallback path meant this branch could never be reached, it just opened an editor
    // that then failed on a file the user had never seen.
    void this.electronService.showMessageDialog({
      title: 'Nothing to edit',
      message: `“${item.title}” has no source document on disk, so there is nothing for the editor `
        + 'to open. Add a version on the Versions tab first.',
      type: 'info',
    });
  }

  /** Copy the chosen ebook edition into the pipeline (pristine edition untouched)
   *  and open it in the editor. */
  private async editEdition(item: StudioItem, projectId: string, variantId: string): Promise<void> {
    const res = await this.electronService.variantSendToPipeline(projectId, variantId);
    if (res.success && res.sourcePath) {
      await this.openEditorWithProjectDir(item.projectDir!, res.sourcePath);
      this.studioService.reloadItem(item.id);   // source changed → refresh derived state
    } else {
      console.error('[Studio] Failed to open edition in editor:', res.error);
      void this.electronService.showMessageDialog({
        title: 'Could not open edition',
        message: res.error || 'Failed to copy this edition into the pipeline.',
        type: 'error',
      });
    }
  }

  /** Show the version picker: pipeline working files plus the book's ebook editions. */
  private showSourcePicker(item: StudioItem, projectId: string, variantOptions: VariantOption[]): void {
    this.versionPickerData.set({
      projectDir: item.projectDir!,
      onSelect: (version: ProjectVersion) => {
        this.showVersionPicker.set(false);
        this.openEditorWithProjectDir(item.projectDir!, version.path);
      },
      onCancel: () => this.showVersionPicker.set(false),
      variants: variantOptions.length ? variantOptions : undefined,
      onSelectVariant: variantOptions.length
        ? (variantId: string) => { this.showVersionPicker.set(false); void this.editEdition(item, projectId, variantId); }
        : undefined,
    });
    this.showVersionPicker.set(true);
  }

  /**
   * Open the editor window with a specific version (no project - direct file editing)
   */
  private async openEditorWithVersion(versionPath: string): Promise<void> {
    const result = await this.electronService.editorOpenWindow(versionPath);
    if (!result.success) {
      console.error('[Studio] Failed to open editor window:', result.error);
      void this.electronService.showMessageDialog({
        title: 'Could not open editor',
        message: result.error || 'Failed to open the editor window.',
        type: 'error',
      });
    }
  }

  /**
   * Open the editor window with a project directory and a specific source version
   * This ensures project state (deletions, chapters) is preserved
   */
  private async openEditorWithProjectDir(projectDir: string, sourcePath: string): Promise<void> {
    const result = await this.electronService.editorOpenWindowWithBfp(projectDir, sourcePath);
    if (!result.success) {
      console.error('[Studio] Failed to open editor window:', result.error);
      void this.electronService.showMessageDialog({
        title: 'Could not open editor',
        message: result.error || 'Failed to open the editor window.',
        type: 'error',
      });
    }
  }

  // Labelling is a mode inside the editor (the left rail), not a way of opening
  // it: open any version with Open and switch to Label there.

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

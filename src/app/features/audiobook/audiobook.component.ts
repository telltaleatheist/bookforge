import { Component, inject, signal, computed, OnInit, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem
} from '../../creamsicle-desktop';
import { AudiobookQueueComponent, QueueItem, QueueItemStatus, CompletedAudiobook } from './components/audiobook-queue/audiobook-queue.component';
import { MetadataEditorComponent, EpubMetadata } from './components/metadata-editor/metadata-editor.component';
import { AiCleanupPanelComponent } from './components/ai-cleanup-panel/ai-cleanup-panel.component';
import { TranslationPanelComponent } from './components/translation-panel/translation-panel.component';
import { TtsSettingsComponent, TTSSettings } from './components/tts-settings/tts-settings.component';
import { DiffViewComponent } from './components/diff-view/diff-view.component';
import { PlayViewComponent } from './components/play-view/play-view.component';
import { SkippedChunksPanelComponent } from './components/skipped-chunks-panel/skipped-chunks-panel.component';
import { PostProcessingPanelComponent } from './components/post-processing-panel/post-processing-panel.component';
import { EpubService } from './services/epub.service';
import { AudiobookService } from './services/audiobook.service';
import { ElectronService } from '../../core/services/electron.service';
import { SettingsService } from '../../core/services/settings.service';
import { LibraryService } from '../../core/services/library.service';
import { QueueService } from '../queue/services/queue.service';
import { AnalyticsPanelComponent } from './components/analytics-panel/analytics-panel.component';
import { ProjectAnalytics, TTSJobAnalytics, CleanupJobAnalytics } from '../../core/models/analytics.types';

// Workflow states for the audiobook producer
type WorkflowState = 'queue' | 'metadata' | 'translate' | 'cleanup' | 'convert' | 'play' | 'diff' | 'skipped' | 'analytics' | 'enhance' | 'complete';

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
    AiCleanupPanelComponent,
    TtsSettingsComponent,
    DiffViewComponent,
    PlayViewComponent,
    SkippedChunksPanelComponent,
    AnalyticsPanelComponent,
    PostProcessingPanelComponent
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
            [completedAudiobooks]="completedAudiobooks()"
            (select)="selectItem($event)"
            (remove)="removeFromQueue($event)"
            (openCompletedFolder)="onOpenCompletedFolder()"
            (playAudiobook)="onPlayAudiobook($event)"
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
                    (showInFinder)="onShowInFinder()"
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
                  <app-ai-cleanup-panel
                    [epubPath]="originalEpubPath()"
                    [bfpPath]="selectedItem()?.bfpPath"
                    [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author }"
                    (cleanupComplete)="onCleanupComplete()"
                  />
                }
                @case ('convert') {
                  <app-tts-settings
                    [settings]="ttsSettings()"
                    [epubPath]="currentEpubPath()"
                    [bfpPath]="selectedItem()?.bfpPath"
                    [metadata]="{
                      title: selectedMetadata()?.title,
                      author: selectedMetadata()?.author,
                      year: selectedMetadata()?.year,
                      coverPath: getSelectedCoverPath(),
                      outputFilename: selectedMetadata()?.outputFilename || generatedFilename()
                    }"
                    (settingsChange)="onTtsSettingsChange($event)"
                  />
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
              }
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

  `]
})
export class AudiobookComponent implements OnInit {
  private readonly epubService = inject(EpubService);
  private readonly audiobookService = inject(AudiobookService);
  private readonly electronService = inject(ElectronService);
  private readonly settingsService = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);

  // State
  readonly queueItems = signal<QueueItem[]>([]);
  readonly selectedItemId = signal<string | null>(null);
  readonly workflowState = signal<WorkflowState>('metadata');
  readonly ttsSettings = signal<TTSSettings>({
    device: 'mps',
    language: 'en',
    ttsEngine: 'xtts',
    fineTuned: 'ScarlettJohansson',  // Default to Scarlett Johansson voice
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 2.0,
    speed: 1.0,
    enableTextSplitting: false
  });
  readonly savingMetadata = signal(false);
  readonly completedAudiobooks = signal<CompletedAudiobook[]>([]);

  // Diff view state
  readonly diffPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);

  // Analytics state - keyed by project ID
  private readonly _projectAnalytics = signal<Map<string, ProjectAnalytics>>(new Map());

  // ViewChild reference to diff view for manual refresh
  @ViewChild(DiffViewComponent) diffViewRef?: DiffViewComponent;

  constructor() {
    // Watch for completed jobs with analytics and save to BFP
    effect(() => {
      const completedJob = this.queueService.lastCompletedJobWithAnalytics();
      if (!completedJob || !completedJob.bfpPath || !completedJob.analytics) return;

      // Save analytics to BFP
      this.saveAnalyticsToBfp(
        completedJob.bfpPath,
        completedJob.jobType,
        completedJob.analytics
      );
    });
  }

  /**
   * Save job analytics to the BFP project file
   */
  private async saveAnalyticsToBfp(
    bfpPath: string,
    jobType: string,
    analytics: TTSJobAnalytics | CleanupJobAnalytics
  ): Promise<void> {
    if (!this.electron) return;

    try {
      // Get project ID from bfpPath for local state update
      const projectId = bfpPath.split('/').pop()?.replace('.bfp', '') || '';

      // Get existing analytics from local state or initialize empty
      const existingAnalytics = this._projectAnalytics().get(projectId) || {
        ttsJobs: [],
        cleanupJobs: []
      };

      // Append new analytics to appropriate array (keep only last 10 of each type)
      const MAX_ANALYTICS_HISTORY = 10;
      let updatedAnalytics: ProjectAnalytics;
      if (jobType === 'tts-conversion') {
        const ttsJobs = [...existingAnalytics.ttsJobs, analytics as TTSJobAnalytics];
        updatedAnalytics = {
          ...existingAnalytics,
          ttsJobs: ttsJobs.slice(-MAX_ANALYTICS_HISTORY)
        };
      } else if (jobType === 'ocr-cleanup') {
        const cleanupJobs = [...existingAnalytics.cleanupJobs, analytics as CleanupJobAnalytics];
        updatedAnalytics = {
          ...existingAnalytics,
          cleanupJobs: cleanupJobs.slice(-MAX_ANALYTICS_HISTORY)
        };
      } else {
        console.log('[Audiobook] Unknown job type for analytics:', jobType);
        return;
      }

      // Build state update object
      const stateUpdate: Record<string, unknown> = {
        analytics: updatedAnalytics
      };

      // Set cleanedAt timestamp when OCR cleanup completes
      if (jobType === 'ocr-cleanup') {
        stateUpdate['cleanedAt'] = new Date().toISOString();
      }

      // Save to BFP via IPC
      const result = await this.electron.audiobook.updateState(bfpPath, stateUpdate);

      if (result.success) {
        // Update local analytics state
        const analyticsMap = this._projectAnalytics();
        const newMap = new Map(analyticsMap);
        newMap.set(projectId, updatedAnalytics);
        this._projectAnalytics.set(newMap);

        // Update local queue item's hasCleaned flag for OCR cleanup
        if (jobType === 'ocr-cleanup') {
          this.queueItems.update(items =>
            items.map(item =>
              item.bfpPath === bfpPath ? { ...item, hasCleaned: true } : item
            )
          );
          console.log(`[Audiobook] Set hasCleaned=true for ${bfpPath}`);
        }

        console.log(`[Audiobook] Saved ${jobType} analytics to BFP:`, analytics.jobId);
      } else {
        console.error('[Audiobook] Failed to save analytics to BFP:', result.error);
      }
    } catch (err) {
      console.error('[Audiobook] Error saving analytics:', err);
    }
  }

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
      const originalDir = item.path.substring(0, item.path.lastIndexOf('/'));
      const cleanedName = item.cleanedFilename || 'exported_cleaned.epub';
      return `${originalDir}/${cleanedName}`;
    }

    return item.path;
  });

  // Path to the completed audiobook m4b file for enhancement
  readonly audioFilePath = computed(() => {
    const item = this.selectedItem();
    if (!item?.audiobookFolder || !item.metadata || !item.hasAudiobook) return '';

    const completed = this.completedAudiobooks();
    if (completed.length === 0) return '';

    // Try to find the matching audiobook file using the same logic as markItemsWithAudiobooks
    const meta = item.metadata;
    const expectedFilename = this.generateFilenameForItem(meta).toLowerCase();

    // Try exact match first
    let matchedFile = completed.find(a => a.filename.toLowerCase() === expectedFilename);

    // If no exact match, try fuzzy matching
    if (!matchedFile) {
      const normalize = (s: string) => s.toLowerCase().replace(/['']/g, '').replace(/\s+/g, ' ').trim();
      const authorLast = normalize(meta.authorLast || (meta.author || '').split(' ').pop() || '');
      const titleStart = normalize((meta.title || '').split(/[-:,]/)[0]);

      matchedFile = completed.find(a => {
        const cfNorm = normalize(a.filename);
        return cfNorm.includes(authorLast) && cfNorm.startsWith(titleStart);
      });
    }

    if (matchedFile) {
      // Normalize path separators
      return matchedFile.path.replace(/\\/g, '/');
    }

    return '';
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

        // Determine which cleaned epub filename exists (new: exported_cleaned.epub, legacy: cleaned.epub)
        let cleanedFilename: string | undefined;
        if (hasCleaned && this.electron) {
          const newCleanedPath = `${project.audiobookFolder}/exported_cleaned.epub`;
          const legacyCleanedPath = `${project.audiobookFolder}/cleaned.epub`;
          if (await this.electron.fs.exists(newCleanedPath).catch(() => false)) {
            cleanedFilename = 'exported_cleaned.epub';
          } else if (await this.electron.fs.exists(legacyCleanedPath).catch(() => false)) {
            cleanedFilename = 'cleaned.epub';
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
    if (!this.selectedItemId() && items.length > 0) {
      this.selectItem(items[0].id);
    }
  }

  async loadCompletedAudiobooks(): Promise<void> {
    if (!this.electron) return;

    try {
      // Use configured output dir, or fall back to library's audiobooks folder
      const configuredDir = this.settingsService.get<string>('audiobookOutputDir');
      const outputDir = configuredDir || this.libraryService.audiobooksPath() || '';
      console.log('[Audiobook] Output dir setting:', configuredDir);
      console.log('[Audiobook] Library audiobooks path:', this.libraryService.audiobooksPath());
      console.log('[Audiobook] Using folder:', outputDir);
      const result = await this.electron.library.listCompleted(outputDir || undefined);
      console.log('[Audiobook] listCompleted result:', result.success, 'files:', result.files?.length);

      if (result.success && result.files) {
        const completed = result.files.map((f: any) => ({
          path: f.path,
          filename: f.filename,
          size: f.size,
          modifiedAt: new Date(f.modifiedAt)
        }));
        this.completedAudiobooks.set(completed);

        // Mark queue items that have completed audiobooks
        this.markItemsWithAudiobooks(completed);
      }
    } catch (err) {
      console.error('Failed to load completed audiobooks:', err);
    }
  }

  /**
   * Mark queue items that have a completed audiobook
   */
  private markItemsWithAudiobooks(completed: CompletedAudiobook[]): void {
    // Build list of completed filenames (lowercase for case-insensitive matching)
    const completedFilenames = completed.map(a => a.filename.toLowerCase());

    console.log('[Audiobook] Completed filenames:', completedFilenames);

    // Update queue items and sort (completed at bottom)
    this.queueItems.update(items => {
      const updated = items.map(item => {
        const expectedFilename = this.generateFilenameForItem(item.metadata).toLowerCase();

        // Try exact match first
        let hasAudiobook = completedFilenames.includes(expectedFilename);

        // If no exact match, try fuzzy matching by author + title prefix
        if (!hasAudiobook && item.metadata) {
          const meta = item.metadata;

          // Normalize function - remove apostrophes, extra spaces, lowercase
          const normalize = (s: string) => s.toLowerCase().replace(/['']/g, '').replace(/\s+/g, ' ').trim();

          // Get author last name for matching
          const authorLast = normalize(meta.authorLast || (meta.author || '').split(' ').pop() || '');

          // Check if any completed file contains this author and starts with similar title
          const titleStart = normalize((meta.title || '').split(/[-:,]/)[0]);

          hasAudiobook = completedFilenames.some(cf => {
            const cfNorm = normalize(cf);
            // Match if completed filename contains author last name and starts with title prefix
            return cfNorm.includes(authorLast) && cfNorm.startsWith(titleStart);
          });
        }

        console.log('[Audiobook] Checking item:', item.metadata.title);
        console.log('[Audiobook]   Expected:', expectedFilename);
        console.log('[Audiobook]   Match:', hasAudiobook);
        return { ...item, hasAudiobook };
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

  async onOpenCompletedFolder(): Promise<void> {
    if (!this.electron) return;

    try {
      // Use configured output dir, or fall back to library's audiobooks folder
      const configuredDir = this.settingsService.get<string>('audiobookOutputDir');
      const outputDir = configuredDir || this.libraryService.audiobooksPath();
      if (outputDir) {
        await this.electron.shell.openPath(outputDir);
      }
    } catch (err) {
      console.error('Error opening audiobooks folder:', err);
    }
  }

  async onPlayAudiobook(path: string): Promise<void> {
    if (!this.electron) return;

    try {
      // Open the file with the default system player
      await this.electron.shell.openPath(path);
    } catch (err) {
      console.error('Error opening audiobook:', err);
    }
  }

  selectItem(id: string): void {
    this.selectedItemId.set(id);
    this.workflowState.set('metadata');
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
        const originalDir = item.path.substring(0, item.path.lastIndexOf('/'));
        const cleanedName = item.cleanedFilename || 'exported_cleaned.epub';
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

  onMetadataChange(metadata: EpubMetadata): void {
    const id = this.selectedItemId();
    if (!id) return;

    // Check if this item has a completed audiobook (filename may have changed)
    const completedFilenames = new Set(
      this.completedAudiobooks().map(a => a.filename.toLowerCase())
    );
    const expectedFilename = this.generateFilenameForItem(metadata);
    const hasAudiobook = completedFilenames.has(expectedFilename.toLowerCase());

    this.queueItems.update(items =>
      items.map(item =>
        item.id === id ? { ...item, metadata, hasAudiobook } : item
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
    // Open the configured audiobooks output folder
    if (!this.electron) return;

    try {
      // Use configured output dir, or fall back to library's audiobooks folder
      const configuredDir = this.settingsService.get<string>('audiobookOutputDir');
      const outputDir = configuredDir || this.libraryService.audiobooksPath();
      if (outputDir) {
        await this.electron.shell.openPath(outputDir);
      }
    } catch (err) {
      console.error('Error opening audiobooks folder:', err);
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
}

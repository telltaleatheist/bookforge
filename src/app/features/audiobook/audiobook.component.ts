import { Component, inject, signal, computed, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { AudiobookQueueComponent, QueueItem } from './components/audiobook-queue/audiobook-queue.component';
import { MetadataEditorComponent, EpubMetadata } from './components/metadata-editor/metadata-editor.component';
import { AiCleanupPanelComponent } from './components/ai-cleanup-panel/ai-cleanup-panel.component';
import { TtsSettingsComponent, TTSSettings } from './components/tts-settings/tts-settings.component';
import { DiffViewComponent } from './components/diff-view/diff-view.component';
import { PlayViewComponent } from './components/play-view/play-view.component';
import { EpubService } from './services/epub.service';
import { AudiobookService } from './services/audiobook.service';
import { ElectronService } from '../../core/services/electron.service';

// Workflow states for the audiobook producer
type WorkflowState = 'queue' | 'metadata' | 'cleanup' | 'convert' | 'play' | 'diff' | 'complete';

@Component({
  selector: 'app-audiobook',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    ToolbarComponent,
    DesktopButtonComponent,
    AudiobookQueueComponent,
    MetadataEditorComponent,
    AiCleanupPanelComponent,
    TtsSettingsComponent,
    DiffViewComponent,
    PlayViewComponent
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
            <desktop-button variant="ghost" size="xs" [iconOnly]="true" title="Add EPUB" (click)="addToQueue()">
              +
            </desktop-button>
          </div>
          <app-audiobook-queue
            [items]="queueItems()"
            [selectedId]="selectedItemId()"
            (select)="selectItem($event)"
            (remove)="removeFromQueue($event)"
            (filesDropped)="onFilesDropped($event)"
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
                @case ('cleanup') {
                  <app-ai-cleanup-panel
                    [epubPath]="originalEpubPath()"
                    [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author }"
                    (cleanupComplete)="onCleanupComplete()"
                  />
                }
                @case ('convert') {
                  <app-tts-settings
                    [settings]="ttsSettings()"
                    [epubPath]="currentEpubPath()"
                    [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author, outputFilename: selectedMetadata()?.outputFilename || generatedFilename() }"
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
              }
            </div>
          } @else {
            <!-- Empty state -->
            <div class="empty-state">
              <div class="empty-icon">&#127911;</div>
              <h2>Audiobook Producer</h2>
              <p>Select an EPUB from the queue or drag and drop files to get started.</p>
              <desktop-button variant="primary" (click)="addToQueue()">
                Add EPUB
              </desktop-button>
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

  // State
  readonly queueItems = signal<QueueItem[]>([]);
  readonly selectedItemId = signal<string | null>(null);
  readonly workflowState = signal<WorkflowState>('metadata');
  readonly ttsSettings = signal<TTSSettings>({
    device: 'mps',
    language: 'en',
    ttsEngine: 'xtts',
    fineTuned: 'ScarlettJohansson',
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 2.0,
    speed: 1.0,
    enableTextSplitting: false
  });
  readonly savingMetadata = signal(false);

  // Diff view state
  readonly diffPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);

  // ViewChild reference to diff view for manual refresh
  @ViewChild(DiffViewComponent) diffViewRef?: DiffViewComponent;

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
      return `${originalDir}/cleaned.epub`;
    }

    return item.path;
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

  // Toolbar
  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    return [
      {
        id: 'add',
        type: 'button',
        icon: '+',
        label: 'Add EPUB',
        tooltip: 'Add EPUB to queue'
      },
      { id: 'sep1', type: 'divider' },
      {
        id: 'refresh',
        type: 'button',
        icon: '\u21BB',
        label: 'Refresh',
        tooltip: 'Refresh queue'
      }
    ];
  });

  ngOnInit(): void {
    this.loadQueue();
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'add':
        this.addToQueue();
        break;
      case 'refresh':
        this.loadQueue();
        // Also refresh diff view if on the diff tab
        if (this.workflowState() === 'diff' && this.diffViewRef) {
          this.diffViewRef.refresh();
        }
        break;
    }
  }

  async loadQueue(): Promise<void> {
    const files = await this.audiobookService.listQueue();

    const items: QueueItem[] = [];
    for (const file of files) {
      // Parse EPUB to get metadata
      const structure = await this.epubService.open(file.path);
      if (structure) {
        // Try to load saved metadata - parse author into first/last
        const authorParts = (structure.metadata.author || '').trim().split(' ');
        let authorFirst = '';
        let authorLast = '';
        if (authorParts.length >= 2) {
          authorLast = authorParts.pop() || '';
          authorFirst = authorParts.join(' ');
        } else if (authorParts.length === 1) {
          authorFirst = authorParts[0];
        }

        let metadata: EpubMetadata = {
          title: structure.metadata.title,
          subtitle: structure.metadata.subtitle,
          author: structure.metadata.author,
          authorFirst,
          authorLast,
          year: structure.metadata.year,
          language: structure.metadata.language,
          coverPath: structure.metadata.coverPath
        };

        // Check for saved metadata override
        if (this.electron) {
          try {
            const savedResult = await this.electron.library.loadMetadata(file.path);
            if (savedResult.success && savedResult.metadata) {
              metadata = { ...metadata, ...savedResult.metadata };
            }
          } catch {
            // No saved metadata, use EPUB defaults
          }
        }

        items.push({
          id: file.path,
          path: file.path,
          filename: file.filename,
          metadata: {
            ...metadata,
            // Never show internal filenames like "cleaned.epub" or "original.epub"
            // Always prefer the actual book title from EPUB metadata
            title: metadata.title && !metadata.title.match(/^(cleaned|original)\.epub$/i)
              ? metadata.title
              : structure.metadata.title || 'Untitled'
          },
          status: 'pending',
          addedAt: new Date(file.addedAt),
          projectId: file.projectId,
          hasCleaned: file.hasCleaned
        });
        await this.epubService.close();
      }
    }

    this.queueItems.set(items);

    // If there's no selection but we have items, select the first one
    if (!this.selectedItemId() && items.length > 0) {
      this.selectItem(items[0].id);
    }
  }

  async addToQueue(): Promise<void> {
    if (!this.electron) return;

    // Open file dialog
    const result = await this.electron.dialog.openPdf();
    if (result.success && result.filePath) {
      const filePath = result.filePath;

      // Check if it's an EPUB
      if (!filePath.toLowerCase().endsWith('.epub')) {
        return; // Only EPUBs are supported
      }

      // Copy to queue (handles duplicates)
      const filename = filePath.split('/').pop() || 'unknown.epub';
      await this.addEpubToQueue(filePath, filename);
    }
  }

  /**
   * Add an EPUB to the queue, replacing any existing entry with the same filename
   */
  private async addEpubToQueue(filePath: string, filename: string): Promise<void> {
    // Check for existing item with same filename and remove it first
    const existingItem = this.queueItems().find(
      item => item.filename.toLowerCase() === filename.toLowerCase()
    );
    if (existingItem) {
      console.log('[Audiobook] Replacing existing item:', existingItem.filename);
      await this.removeFromQueue(existingItem.id);
    }

    // Copy to queue
    const copyResult = await this.audiobookService.copyToQueue(filePath, filename);
    if (copyResult.success) {
      await this.loadQueue();
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
      if (item?.hasCleaned) {
        const originalDir = item.path.substring(0, item.path.lastIndexOf('/'));
        this.diffPaths.set({
          originalPath: `${originalDir}/original.epub`,
          cleanedPath: `${originalDir}/cleaned.epub`
        });
      }
    }
  }

  onMetadataChange(metadata: EpubMetadata): void {
    const id = this.selectedItemId();
    if (!id) return;

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
      const result = await this.electron.library.saveMetadata(item.path, metadata);
      if (result.success) {
        // Update local state
        this.onMetadataChange(metadata);
      } else {
        console.error('Failed to save metadata:', result.error);
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

  onTtsSettingsChange(settings: TTSSettings): void {
    this.ttsSettings.set(settings);
  }

  async onFilesDropped(files: File[]): Promise<void> {
    if (!this.electron) return;

    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.epub')) {
        // For browser File objects, we need to get the path
        // In Electron, dropped files have a `path` property
        const filePath = (file as any).path;
        if (filePath) {
          await this.addEpubToQueue(filePath, file.name);
        }
      }
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
    // Open the completed audiobooks folder
    if (!this.electron) return;

    try {
      const pathsResult = await this.electron.library.getAudiobooksPath();
      if (pathsResult.success && pathsResult.completedPath) {
        await this.electron.shell.openPath(pathsResult.completedPath);
      }
    } catch (err) {
      console.error('Error opening audiobooks folder:', err);
    }
  }

}

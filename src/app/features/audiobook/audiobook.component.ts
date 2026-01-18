import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { LibraryService } from '../../core/services/library.service';
import { AudiobookQueueComponent, QueueItem } from './components/audiobook-queue/audiobook-queue.component';
import { MetadataEditorComponent, EpubMetadata } from './components/metadata-editor/metadata-editor.component';
import { AiCleanupPanelComponent } from './components/ai-cleanup-panel/ai-cleanup-panel.component';
import { TtsSettingsComponent, TTSSettings } from './components/tts-settings/tts-settings.component';
import { ProgressPanelComponent, TTSProgress } from './components/progress-panel/progress-panel.component';
import { DiffViewComponent } from './components/diff-view/diff-view.component';
import { EpubService } from './services/epub.service';
import { AudiobookService } from './services/audiobook.service';

// Workflow states for the audiobook producer
type WorkflowState = 'queue' | 'metadata' | 'cleanup' | 'convert' | 'complete';

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
    ProgressPanelComponent,
    DiffViewComponent
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
            </div>

            <!-- View Options (when cleaned version exists) -->
            @if (selectedItem()?.hasCleaned) {
              <div class="view-options">
                <span class="view-label">View:</span>
                <button
                  class="view-btn"
                  [class.active]="viewMode() === 'original'"
                  (click)="setViewMode('original')"
                >
                  Original
                </button>
                <button
                  class="view-btn"
                  [class.active]="viewMode() === 'cleaned'"
                  (click)="setViewMode('cleaned')"
                >
                  Cleaned
                </button>
                <button
                  class="view-btn diff"
                  (click)="openDiffView()"
                >
                  View Diff
                </button>
              </div>
            }

            <!-- Tab content -->
            <div class="tab-content">
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
                @case ('cleanup') {
                  <app-ai-cleanup-panel
                    [epubPath]="currentEpubPath()"
                    [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author }"
                    (cleanupComplete)="onCleanupComplete()"
                  />
                }
                @case ('convert') {
                  @if (isConverting()) {
                    <app-progress-panel
                      [progress]="conversionProgress()"
                      (cancel)="cancelConversion()"
                    />
                  } @else {
                    <app-tts-settings
                      [settings]="ttsSettings()"
                      [epubPath]="currentEpubPath()"
                      [metadata]="{ title: selectedMetadata()?.title, author: selectedMetadata()?.author }"
                      (settingsChange)="onTtsSettingsChange($event)"
                      (startConversion)="startConversion()"
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

    <!-- Diff View Modal -->
    @if (showDiffModal()) {
      <div class="diff-modal-backdrop" (click)="closeDiffModal()">
        <div class="diff-modal" (click)="$event.stopPropagation()">
          <app-diff-view
            [originalPath]="diffPaths()!.originalPath"
            [cleanedPath]="diffPaths()!.cleanedPath"
            (close)="closeDiffModal()"
          />
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

    .view-options {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }

    .view-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-right: 0.25rem;
    }

    .view-btn {
      padding: 0.25rem 0.625rem;
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      background: var(--bg-base);
      color: var(--text-secondary);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }

      &.diff {
        margin-left: auto;
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border-color: var(--accent);
        color: var(--accent);

        &:hover {
          background: color-mix(in srgb, var(--accent) 20%, transparent);
        }
      }
    }

    .diff-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .diff-modal {
      width: 90%;
      max-width: 1200px;
      height: 80%;
      max-height: 800px;
      background: var(--bg-elevated);
      border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
      overflow: hidden;
      animation: slideUp 0.2s ease;

      app-diff-view {
        height: 100%;
      }
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `]
})
export class AudiobookComponent implements OnInit, OnDestroy {
  private readonly libraryService = inject(LibraryService);
  private readonly epubService = inject(EpubService);
  private readonly audiobookService = inject(AudiobookService);
  private readonly destroyRef = inject(DestroyRef);

  // Progress listener cleanup
  private unsubscribeProgress: (() => void) | null = null;

  // State
  readonly queueItems = signal<QueueItem[]>([]);
  readonly selectedItemId = signal<string | null>(null);
  readonly workflowState = signal<WorkflowState>('metadata');
  readonly isConverting = signal(false);
  readonly conversionProgress = signal<TTSProgress>({
    phase: 'preparing',
    currentChapter: 0,
    totalChapters: 0,
    percentage: 0,
    estimatedRemaining: 0
  });
  readonly ttsSettings = signal<TTSSettings>({
    device: 'mps',
    language: 'en',
    voice: 'en_default',
    temperature: 0.75,
    speed: 1.0
  });
  readonly savingMetadata = signal(false);

  // View mode state (original vs cleaned)
  readonly viewMode = signal<'original' | 'cleaned'>('cleaned');
  readonly showDiffModal = signal(false);
  readonly diffPaths = signal<{ originalPath: string; cleanedPath: string } | null>(null);

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

  // Current EPUB path based on view mode (original or cleaned)
  readonly currentEpubPath = computed(() => {
    const item = this.selectedItem();
    if (!item) return '';

    // If cleaned version exists and we're in cleaned mode, use the cleaned path
    if (item.hasCleaned && this.viewMode() === 'cleaned' && item.projectId) {
      // Construct cleaned path from project folder
      const originalDir = item.path.substring(0, item.path.lastIndexOf('/'));
      return `${originalDir}/cleaned.epub`;
    }

    return item.path;
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
    this.setupProgressListener();

    // Cleanup on destroy
    this.destroyRef.onDestroy(() => {
      if (this.unsubscribeProgress) {
        this.unsubscribeProgress();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.unsubscribeProgress) {
      this.unsubscribeProgress();
    }
  }

  private setupProgressListener(): void {
    if (!this.electron) return;

    this.unsubscribeProgress = this.electron.tts.onProgress((progress: TTSProgress) => {
      this.conversionProgress.set(progress);

      // Update converting state based on phase
      if (progress.phase === 'complete') {
        this.isConverting.set(false);
        this.workflowState.set('complete');
        this.loadQueue(); // Refresh queue
      } else if (progress.phase === 'error') {
        this.isConverting.set(false);
      }
    });
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'add':
        this.addToQueue();
        break;
      case 'refresh':
        this.loadQueue();
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
          metadata,
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
      this.selectedItemId.set(items[0].id);
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

      // Copy to queue
      const filename = filePath.split('/').pop() || 'unknown.epub';
      const copyResult = await this.audiobookService.copyToQueue(filePath, filename);

      if (copyResult.success) {
        await this.loadQueue();
      }
    }
  }

  selectItem(id: string): void {
    this.selectedItemId.set(id);
    this.workflowState.set('metadata');
  }

  async removeFromQueue(id: string): Promise<void> {
    this.queueItems.update(items => items.filter(item => item.id !== id));
    if (this.selectedItemId() === id) {
      this.selectedItemId.set(null);
    }
  }

  setWorkflowState(state: WorkflowState): void {
    this.workflowState.set(state);
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

  async startConversion(): Promise<void> {
    const item = this.selectedItem();
    if (!item) return;

    this.isConverting.set(true);
    this.conversionProgress.set({
      phase: 'preparing',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0,
      estimatedRemaining: 0,
      message: 'Starting conversion...'
    });

    // Update settings in service
    this.audiobookService.setSettings(this.ttsSettings());

    // Get output directory
    const paths = await this.audiobookService.getAudiobooksPath();
    const outputDir = paths.completedPath || '';

    if (!outputDir) {
      this.isConverting.set(false);
      return;
    }

    // Start conversion
    const result = await this.audiobookService.startConversion(item.path, outputDir);

    if (!result.success) {
      this.isConverting.set(false);
      this.conversionProgress.update(p => ({
        ...p,
        phase: 'error',
        error: result.error
      }));
    }
  }

  async cancelConversion(): Promise<void> {
    await this.audiobookService.stopConversion();
    this.isConverting.set(false);
    this.conversionProgress.set({
      phase: 'preparing',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0,
      estimatedRemaining: 0
    });
  }

  async onFilesDropped(files: File[]): Promise<void> {
    if (!this.electron) return;

    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.epub')) {
        // For browser File objects, we need to get the path
        // In Electron, dropped files have a `path` property
        const filePath = (file as any).path;
        if (filePath) {
          const copyResult = await this.audiobookService.copyToQueue(filePath, file.name);
          if (copyResult.success) {
            await this.loadQueue();
          }
        }
      }
    }
  }

  // View mode methods
  setViewMode(mode: 'original' | 'cleaned'): void {
    this.viewMode.set(mode);
  }

  openDiffView(): void {
    const item = this.selectedItem();
    if (!item || !item.hasCleaned) return;

    // Construct paths from the project folder
    const originalDir = item.path.substring(0, item.path.lastIndexOf('/'));
    this.diffPaths.set({
      originalPath: `${originalDir}/original.epub`,
      cleanedPath: `${originalDir}/cleaned.epub`
    });
    this.showDiffModal.set(true);
  }

  closeDiffModal(): void {
    this.showDiffModal.set(false);
    this.diffPaths.set(null);
  }
}

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
    ProgressPanelComponent
  ],
  template: `
    <!-- Toolbar -->
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="audiobook-container">
      <desktop-split-pane [initialLeftWidth]="280" [minLeftWidth]="200" [minRightWidth]="400">
        <!-- Left Panel: Queue -->
        <div left-pane class="queue-panel">
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
        <div right-pane class="details-panel">
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

            <!-- Tab content -->
            <div class="tab-content">
              @switch (workflowState()) {
                @case ('metadata') {
                  <app-metadata-editor
                    [metadata]="selectedMetadata()"
                    (metadataChange)="onMetadataChange($event)"
                    (coverChange)="onCoverChange($event)"
                  />
                }
                @case ('cleanup') {
                  <app-ai-cleanup-panel
                    [epubPath]="selectedItem()!.path"
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

  // Check if we're running in Electron
  private get electron(): typeof window.electron | null {
    return typeof window !== 'undefined' && window.electron ? window.electron : null;
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
      { type: 'separator' },
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

    this.unsubscribeProgress = this.electron.tts.onProgress((progress) => {
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

  onToolbarAction(itemId: string): void {
    switch (itemId) {
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
        items.push({
          id: file.path, // Use path as unique ID
          path: file.path,
          filename: file.filename,
          metadata: {
            title: structure.metadata.title,
            subtitle: structure.metadata.subtitle,
            author: structure.metadata.author,
            authorFileAs: structure.metadata.authorFileAs,
            year: structure.metadata.year,
            language: structure.metadata.language,
            coverPath: structure.metadata.coverPath
          },
          status: 'pending',
          addedAt: file.addedAt
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
    // TODO: Update cover image in EPUB
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
}

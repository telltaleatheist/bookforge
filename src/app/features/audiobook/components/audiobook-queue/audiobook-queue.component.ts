import { Component, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

export type QueueItemStatus = 'pending' | 'metadata' | 'cleanup' | 'converting' | 'complete' | 'error';

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFirst?: string;
  authorLast?: string;
  year?: string;
  language: string;
  coverPath?: string;
  coverData?: string;
  outputFilename?: string;
}

export interface QueueItem {
  id: string;
  path: string;
  filename: string;
  metadata: EpubMetadata;
  status: QueueItemStatus;
  progress?: number;
  error?: string;
  addedAt: Date;
  // Project-based fields
  projectId?: string;
  bfpPath?: string;  // Path to the source BFP project (unified system)
  audiobookFolder?: string;  // Folder containing audiobook files (unified system)
  hasCleaned?: boolean;
  hasAudiobook?: boolean;  // True if completed audiobook exists for this book
  skippedChunksPath?: string;  // Path to JSON file with skipped chunks from AI cleanup
}

export interface CompletedAudiobook {
  path: string;
  filename: string;
  size: number;
  modifiedAt: Date;
}

@Component({
  selector: 'app-audiobook-queue',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="queue-container">
      @if (!hasItems() && !hasCompleted()) {
        <div class="empty-queue">
          <div class="drop-icon">&#128214;</div>
          <p>No audiobook projects</p>
          <p class="hint">Use "Export to Audiobook" from the Library to add books here</p>
        </div>
      } @else {
        <!-- Queue section -->
        @if (hasItems()) {
          <div class="section-header">In Progress</div>
          <div class="queue-list">
            @for (item of items(); track item.id) {
              <div
                class="queue-item"
                [class.selected]="item.id === selectedId()"
                [class.error]="item.status === 'error'"
                (click)="select.emit(item.id)"
              >
                <div class="item-cover">
                  @if (item.metadata.coverData) {
                    <img [src]="item.metadata.coverData" alt="Cover" />
                  } @else {
                    <div class="no-cover">&#128214;</div>
                  }
                </div>
                <div class="item-info">
                  <div class="item-title">
                    @if (item.hasAudiobook) {
                      <span class="audiobook-check" title="Audiobook exists">✓</span>
                    }
                    {{ item.metadata.title || item.filename }}
                  </div>
                  <div class="item-author">{{ item.metadata.author || 'Unknown Author' }}</div>
                  <div class="item-status" [attr.data-status]="item.status">
                    @switch (item.status) {
                      @case ('pending') { <span>Pending</span> }
                      @case ('metadata') { <span>Editing...</span> }
                      @case ('cleanup') { <span>Cleaning...</span> }
                      @case ('converting') { <span>{{ item.progress || 0 }}%</span> }
                      @case ('complete') { <span>Complete</span> }
                      @case ('error') { <span>Error</span> }
                    }
                    @if (item.hasCleaned) {
                      <span class="cleaned-badge" title="AI Cleanup complete">✓ Cleaned</span>
                    }
                  </div>
                </div>
                <button
                  class="remove-btn"
                  title="Remove from queue"
                  (click)="onRemoveClick($event, item.id)"
                >
                  &#215;
                </button>
              </div>
            }
          </div>
        }

        <!-- Completed section -->
        @if (hasCompleted()) {
          <div class="section-header">
            Completed
            <button class="open-folder-btn" title="Open folder" (click)="openCompletedFolder.emit()">
              &#128193;
            </button>
          </div>
          <div class="completed-list">
            @for (audiobook of completedAudiobooks(); track audiobook.path) {
              <div
                class="completed-item"
                (click)="playAudiobook.emit(audiobook.path)"
                title="{{ audiobook.filename }}"
              >
                <div class="completed-icon">&#127911;</div>
                <div class="completed-info">
                  <div class="completed-title">{{ formatFilename(audiobook.filename) }}</div>
                  <div class="completed-meta">
                    <span class="completed-date">{{ formatDate(audiobook.modifiedAt) }}</span>
                    <span class="completed-size">{{ formatSize(audiobook.size) }}</span>
                  </div>
                </div>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .queue-container {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
      min-height: 0;
      transition: background 0.2s;

      &.drag-over {
        background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
      }
    }

    .empty-queue {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-align: center;
      padding: 1rem;

      .drop-icon {
        font-size: 2.5rem;
        margin-bottom: 0.5rem;
        opacity: 0.5;
      }

      p {
        margin: 0;
        font-size: 0.875rem;
      }

      .hint {
        margin-top: 0.5rem;
        font-size: 0.75rem;
        opacity: 0.7;
        max-width: 200px;
      }
    }

    .queue-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .queue-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
      }

      &.error {
        border-color: var(--accent-danger);
        background: color-mix(in srgb, var(--accent-danger) 5%, transparent);
      }
    }

    .item-cover {
      width: 40px;
      height: 56px;
      flex-shrink: 0;
      background: var(--bg-subtle);
      border-radius: 4px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .no-cover {
        font-size: 1.25rem;
        opacity: 0.5;
      }
    }

    .item-info {
      flex: 1;
      min-width: 0;
    }

    .item-title {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .audiobook-check {
      color: var(--accent-success);
      font-size: 0.75rem;
      flex-shrink: 0;
    }

    .item-author {
      font-size: 0.75rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-status {
      font-size: 0.6875rem;
      margin-top: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;

      &[data-status="pending"] { color: var(--text-muted); }
      &[data-status="metadata"] { color: var(--accent-primary); }
      &[data-status="cleanup"] { color: var(--accent-warning); }
      &[data-status="converting"] { color: var(--accent-info); }
      &[data-status="complete"] { color: var(--accent-success); }
      &[data-status="error"] { color: var(--accent-danger); }
    }

    .cleaned-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.125rem 0.375rem;
      background: color-mix(in srgb, var(--accent-success) 15%, transparent);
      color: var(--accent-success);
      border-radius: 4px;
      font-size: 0.625rem;
      font-weight: 500;
    }

    .remove-btn {
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--text-muted);
      font-size: 1rem;
      cursor: pointer;
      opacity: 0;
      transition: all 0.15s ease;

      .queue-item:hover & {
        opacity: 1;
      }

      &:hover {
        background: var(--bg-hover);
        color: var(--accent-danger);
      }
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      padding: 0.75rem 0.5rem 0.375rem;
      margin-top: 0.5rem;

      &:first-child {
        margin-top: 0;
      }
    }

    .open-folder-btn {
      background: transparent;
      border: none;
      padding: 0.125rem 0.25rem;
      font-size: 0.75rem;
      cursor: pointer;
      color: var(--text-muted);
      opacity: 0.7;
      transition: opacity 0.15s;

      &:hover {
        opacity: 1;
      }
    }

    .completed-list {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .completed-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.5rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
        background: var(--bg-hover);
      }
    }

    .completed-icon {
      font-size: 1rem;
      opacity: 0.6;
    }

    .completed-info {
      flex: 1;
      min-width: 0;
    }

    .completed-title {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .completed-meta {
      display: flex;
      gap: 0.5rem;
      font-size: 0.625rem;
      color: var(--text-muted);
      margin-top: 0.125rem;
    }

    .completed-date {
      color: var(--text-secondary);
    }

    .completed-size {
      opacity: 0.7;
    }
  `]
})
export class AudiobookQueueComponent {
  // Inputs
  readonly items = input<QueueItem[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly completedAudiobooks = input<CompletedAudiobook[]>([]);

  // Computed for reactivity
  readonly itemCount = computed(() => this.items().length);
  readonly hasItems = computed(() => this.items().length > 0);
  readonly hasCompleted = computed(() => this.completedAudiobooks().length > 0);

  // Outputs
  readonly select = output<string>();
  readonly remove = output<string>();
  readonly openCompletedFolder = output<void>();
  readonly playAudiobook = output<string>();

  onRemoveClick(event: Event, id: string): void {
    event.stopPropagation();
    this.remove.emit(id);
  }

  formatFilename(filename: string): string {
    // Remove .m4b extension and clean up underscores
    return filename.replace(/\.m4b$/i, '').replace(/_/g, ' ');
  }

  formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(0) + ' KB';
    } else if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
  }
}

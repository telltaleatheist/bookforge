import { Component, input, output, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

export type QueueItemStatus = 'pending' | 'metadata' | 'cleanup' | 'converting' | 'complete' | 'error';

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
  coverPath?: string;
  coverData?: string;
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
}

@Component({
  selector: 'app-audiobook-queue',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="queue-container"
      [class.drag-over]="isDragOver()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      @if (items().length === 0) {
        <div class="empty-queue">
          <div class="drop-icon">&#128229;</div>
          <p>Drop EPUB files here</p>
        </div>
      } @else {
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
                <div class="item-title">{{ item.metadata.title || item.filename }}</div>
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
    </div>
  `,
  styles: [`
    .queue-container {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
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

      .drop-icon {
        font-size: 2.5rem;
        margin-bottom: 0.5rem;
        opacity: 0.5;
      }

      p {
        margin: 0;
        font-size: 0.875rem;
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

      &[data-status="pending"] { color: var(--text-muted); }
      &[data-status="metadata"] { color: var(--accent-primary); }
      &[data-status="cleanup"] { color: var(--accent-warning); }
      &[data-status="converting"] { color: var(--accent-info); }
      &[data-status="complete"] { color: var(--accent-success); }
      &[data-status="error"] { color: var(--accent-danger); }
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
  `]
})
export class AudiobookQueueComponent {
  // Inputs
  readonly items = input<QueueItem[]>([]);
  readonly selectedId = input<string | null>(null);

  // Outputs
  readonly select = output<string>();
  readonly remove = output<string>();
  readonly filesDropped = output<File[]>();

  // State
  readonly isDragOver = signal(false);

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const epubFiles = Array.from(files).filter(f =>
        f.name.toLowerCase().endsWith('.epub')
      );
      if (epubFiles.length > 0) {
        this.filesDropped.emit(epubFiles);
      }
    }
  }

  onRemoveClick(event: Event, id: string): void {
    event.stopPropagation();
    this.remove.emit(id);
  }
}

// Re-export the metadata interface
export { EpubMetadata } from './audiobook-queue.component';

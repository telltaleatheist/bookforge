import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { PlayerChapter } from './player.types';

@Component({
  selector: 'app-player-chapter-drawer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="chapter-drawer" [class.open]="isOpen()">
      <div class="drawer-header">
        <h3>Chapters</h3>
        <button class="btn-close" (click)="close.emit()" title="Close">✕</button>
      </div>
      <div class="chapter-list">
        @for (chapter of chapters(); track chapter.id) {
          <button
            class="chapter-item"
            [class.active]="currentChapter()?.id === chapter.id"
            (click)="chapterSelect.emit(chapter)"
          >
            <span class="chapter-order">{{ chapter.order + 1 }}</span>
            <div class="chapter-info">
              <span class="chapter-title">{{ chapter.title }}</span>
              <span class="chapter-meta">
                {{ formatTimestamp(chapter.startTime) }}
                <span class="separator">&middot;</span>
                {{ formatDuration(chapter.endTime - chapter.startTime) }}
              </span>
            </div>
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .chapter-drawer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 300px;
      background: var(--bg-elevated);
      border-left: 1px solid var(--border-default);
      transform: translateX(100%);
      transition: transform 0.25s ease;
      z-index: 10;
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.1);

      &.open {
        transform: translateX(0);
      }
    }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-close {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-muted);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .chapter-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .chapter-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));

        .chapter-order {
          background: var(--accent);
          color: white;
        }

        .chapter-title {
          color: var(--accent);
          font-weight: 600;
        }
      }
    }

    .chapter-order {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 2px;
    }

    .chapter-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .chapter-title {
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .chapter-meta {
      font-size: 11px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .separator {
      margin: 0 4px;
    }
  `]
})
export class PlayerChapterDrawerComponent {
  readonly chapters = input<PlayerChapter[]>([]);
  readonly currentChapter = input<PlayerChapter | null>(null);
  readonly isOpen = input<boolean>(false);

  readonly chapterSelect = output<PlayerChapter>();
  readonly close = output<void>();

  formatTimestamp(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatDuration(seconds: number): string {
    if (!seconds || isNaN(seconds) || seconds <= 0) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hrs}h ${remMins}m`;
    }
    return `${mins}m ${secs}s`;
  }
}

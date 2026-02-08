import { Component, input, output, signal, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';

interface CompletedAudiobook {
  id: string;
  title: string;
  sourceLang?: string;
  targetLang?: string;
  audiobookPath?: string;
  path?: string;           // From backend listing
  epubPath?: string;
  vttPath?: string;
  completedAt?: string;
  createdAt?: string;      // From backend listing
  duration?: number;
}

@Component({
  selector: 'app-completed-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="completed-list">
      <div class="list-header">
        <h3>Completed Audiobooks</h3>
        <button class="btn-icon" (click)="refresh()" [disabled]="isLoading()">
          <span class="icon">↻</span>
        </button>
      </div>

      @if (isLoading()) {
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Loading audiobooks...</p>
        </div>
      } @else if (audiobooks().length === 0) {
        <div class="empty-state">
          <p>No completed audiobooks yet</p>
          <p class="hint">Create your first bilingual audiobook by pasting an article URL</p>
        </div>
      } @else {
        <div class="audiobook-list">
          @for (audiobook of audiobooks(); track audiobook.id) {
            <div
              class="audiobook-item"
              [class.selected]="selectedId() === audiobook.id"
              (click)="selectAudiobook(audiobook)"
            >
              <div class="audiobook-icon">🎧</div>
              <div class="audiobook-info">
                <div class="audiobook-title">{{ audiobook.title }}</div>
                <div class="audiobook-meta">
                  @if (audiobook.sourceLang && audiobook.targetLang) {
                    <span class="lang-badge">{{ getLangName(audiobook.sourceLang) }}</span>
                    <span class="arrow">→</span>
                    <span class="lang-badge">{{ getLangName(audiobook.targetLang) }}</span>
                  }
                  @if (audiobook.duration) {
                    <span class="duration">{{ formatDuration(audiobook.duration) }}</span>
                  }
                </div>
                <div class="audiobook-date">{{ formatDate(audiobook.completedAt || audiobook.createdAt || '') }}</div>
              </div>
              <div class="audiobook-actions">
                <button class="btn-icon" (click)="playAudiobook(audiobook); $event.stopPropagation()" title="Play">
                  ▶
                </button>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .completed-list {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);

      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .loading-state, .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      text-align: center;

      p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 13px;
      }

      .hint {
        margin-top: 8px;
        font-size: 12px;
        color: var(--text-muted);
      }
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-default);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .audiobook-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .audiobook-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: var(--color-primary-bg);
      }
    }

    .audiobook-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .audiobook-info {
      flex: 1;
      min-width: 0;
    }

    .audiobook-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .audiobook-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    }

    .lang-badge {
      font-size: 11px;
      padding: 2px 6px;
      background: var(--bg-muted);
      border-radius: 4px;
      color: var(--text-secondary);
    }

    .arrow {
      font-size: 10px;
      color: var(--text-muted);
    }

    .duration {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .audiobook-date {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .audiobook-actions {
      flex-shrink: 0;
    }
  `]
})
export class CompletedListComponent implements OnInit {
  private readonly electronService = inject(ElectronService);

  // Outputs
  readonly audiobookSelected = output<CompletedAudiobook>();

  // State
  readonly isLoading = signal<boolean>(false);
  readonly audiobooks = signal<CompletedAudiobook[]>([]);
  readonly selectedId = signal<string | null>(null);

  // Language name mapping
  private readonly langNames: Record<string, string> = {
    'en': 'English',
    'de': 'German',
    'es': 'Spanish',
    'fr': 'French',
    'it': 'Italian',
    'pt': 'Portuguese',
    'nl': 'Dutch',
    'pl': 'Polish',
    'ru': 'Russian',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'ko': 'Korean',
  };

  ngOnInit(): void {
    this.loadAudiobooks();
  }

  async loadAudiobooks(): Promise<void> {
    this.isLoading.set(true);
    try {
      const result = await this.electronService.languageLearningListCompleted();
      if (result.success && result.audiobooks) {
        this.audiobooks.set(result.audiobooks);
      }
    } catch (err) {
      console.error('Failed to load audiobooks:', err);
    } finally {
      this.isLoading.set(false);
    }
  }

  refresh(): void {
    this.loadAudiobooks();
  }

  selectAudiobook(audiobook: CompletedAudiobook): void {
    this.selectedId.set(audiobook.id);
    this.audiobookSelected.emit(audiobook);
  }

  playAudiobook(audiobook: CompletedAudiobook): void {
    this.selectAudiobook(audiobook);
  }

  getLangName(code: string): string {
    return this.langNames[code] || code.toUpperCase();
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
}

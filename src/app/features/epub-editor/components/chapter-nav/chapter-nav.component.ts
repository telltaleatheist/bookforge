import { Component, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EpubjsService } from '../../services/epubjs.service';
import { EpubChapterInfo } from '../../../../core/models/epub-highlight.types';

/**
 * ChapterNavComponent - Chapter navigation dropdown for EPUB viewer
 *
 * Features:
 * - Dropdown chapter selector
 * - Previous/Next chapter buttons
 * - Current chapter indicator
 */
@Component({
  selector: 'app-chapter-nav',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="chapter-nav">
      <!-- Previous chapter button -->
      <button
        class="nav-btn"
        [disabled]="!canGoPrev()"
        (click)="goPrev()"
        title="Previous Chapter"
      >
        <span class="icon">\u2039</span>
      </button>

      <!-- Chapter dropdown -->
      <div class="chapter-selector" (click)="toggleDropdown()">
        <div class="current-chapter">
          @if (epubjs.currentChapter()) {
            <span class="chapter-label">{{ epubjs.currentChapter()!.label }}</span>
            <span class="chapter-index">
              {{ getCurrentIndex() + 1 }} / {{ epubjs.totalChapters() }}
            </span>
          } @else {
            <span class="no-chapter">No chapter selected</span>
          }
        </div>
        <span class="dropdown-icon">\u25BC</span>

        <!-- Dropdown list -->
        @if (isOpen()) {
          <div class="dropdown-list" (click)="$event.stopPropagation()">
            @for (chapter of epubjs.chapters(); track chapter.id; let i = $index) {
              <button
                class="chapter-item"
                [class.active]="chapter.id === epubjs.currentChapter()?.id"
                (click)="selectChapter(chapter, i)"
              >
                <span class="item-index">{{ i + 1 }}.</span>
                <span class="item-label">{{ chapter.label }}</span>
              </button>
            }
          </div>
        }
      </div>

      <!-- Next chapter button -->
      <button
        class="nav-btn"
        [disabled]="!canGoNext()"
        (click)="goNext()"
        title="Next Chapter"
      >
        <span class="icon">\u203A</span>
      </button>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .chapter-nav {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .nav-btn {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--accent-primary);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      .icon {
        font-size: 1.25rem;
        line-height: 1;
      }
    }

    .chapter-selector {
      position: relative;
      flex: 1;
      min-width: 200px;
      max-width: 400px;
      height: 32px;
      padding: 0 0.75rem;
      border-radius: 4px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      transition: border-color 0.15s ease;

      &:hover {
        border-color: var(--accent-primary);
      }
    }

    .current-chapter {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      flex: 1;
    }

    .chapter-label {
      font-size: 0.8125rem;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chapter-index {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .no-chapter {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      font-style: italic;
    }

    .dropdown-icon {
      font-size: 0.625rem;
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .dropdown-list {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      margin-top: 4px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      max-height: 300px;
      overflow-y: auto;
      z-index: 100;
    }

    .chapter-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 0.8125rem;
      text-align: left;
      cursor: pointer;
      transition: background 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
        color: var(--accent-primary);
      }

      &:first-child {
        border-radius: 5px 5px 0 0;
      }

      &:last-child {
        border-radius: 0 0 5px 5px;
      }
    }

    .item-index {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      min-width: 24px;
    }

    .item-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `]
})
export class ChapterNavComponent {
  readonly epubjs = inject(EpubjsService);

  // Events
  readonly chapterChanged = output<EpubChapterInfo>();

  // Local state
  readonly isOpen = signal(false);

  /**
   * Toggle dropdown visibility
   */
  toggleDropdown(): void {
    this.isOpen.update(v => !v);
  }

  /**
   * Select a chapter from dropdown
   */
  async selectChapter(chapter: EpubChapterInfo, index: number): Promise<void> {
    this.isOpen.set(false);
    await this.epubjs.goToChapter(index);
    this.chapterChanged.emit(chapter);
  }

  /**
   * Get current chapter index
   */
  getCurrentIndex(): number {
    const current = this.epubjs.currentChapter();
    if (!current) return -1;
    return this.epubjs.chapters().findIndex(c => c.id === current.id);
  }

  /**
   * Check if can navigate to previous chapter
   */
  canGoPrev(): boolean {
    return this.getCurrentIndex() > 0;
  }

  /**
   * Check if can navigate to next chapter
   */
  canGoNext(): boolean {
    const index = this.getCurrentIndex();
    return index >= 0 && index < this.epubjs.totalChapters() - 1;
  }

  /**
   * Go to previous chapter
   */
  async goPrev(): Promise<void> {
    const index = this.getCurrentIndex();
    if (index > 0) {
      const chapter = this.epubjs.chapters()[index - 1];
      await this.epubjs.goToChapter(index - 1);
      this.chapterChanged.emit(chapter);
    }
  }

  /**
   * Go to next chapter
   */
  async goNext(): Promise<void> {
    const index = this.getCurrentIndex();
    const chapters = this.epubjs.chapters();
    if (index >= 0 && index < chapters.length - 1) {
      const chapter = chapters[index + 1];
      await this.epubjs.goToChapter(index + 1);
      this.chapterChanged.emit(chapter);
    }
  }
}

import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EpubEditorStateService } from '../../services/epub-editor-state.service';
import { EpubCategory, getEpubHighlightId } from '../../../../core/models/epub-highlight.types';

/**
 * EpubCategoriesPanelComponent - Displays and manages EPUB highlight categories
 *
 * Features:
 * - Category list with highlight counts
 * - Toggle category deletion
 * - Select all highlights in category
 * - Delete/restore individual categories
 */
@Component({
  selector: 'app-epub-categories-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="categories-panel">
      <div class="panel-header">
        <h3>Categories</h3>
        <div class="header-stats">
          <span class="stat included">{{ editorState.includedChars() | number }} included</span>
          <span class="stat excluded">{{ editorState.excludedChars() | number }} excluded</span>
        </div>
      </div>

      @if (editorState.categoriesArray().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">\u{1F3F7}</span>
          <p>No categories yet</p>
          <p class="hint">Use Search mode to find patterns and create categories.</p>
        </div>
      } @else {
        <div class="category-list">
          @for (category of editorState.categoriesArray(); track category.id) {
            <div
              class="category-card"
              [style.--category-color]="category.color"
              [class.all-deleted]="isAllDeleted(category.id)"
            >
              <div class="category-header">
                <div class="category-color" [style.background]="category.color"></div>
                <div class="category-info">
                  <span class="category-name">{{ category.name }}</span>
                  <span class="category-stats">
                    {{ category.highlightCount }} matches \u2022 {{ category.charCount | number }} chars
                  </span>
                </div>
                <div class="category-toggle">
                  <button
                    class="toggle-btn"
                    [class.deleted]="isAllDeleted(category.id)"
                    (click)="toggleCategory(category.id)"
                    [title]="isAllDeleted(category.id) ? 'Restore all' : 'Delete all'"
                  >
                    @if (isAllDeleted(category.id)) {
                      <span class="icon">\u21A9</span>
                    } @else {
                      <span class="icon">\u{1F5D1}</span>
                    }
                  </button>
                </div>
              </div>

              @if (category.description) {
                <div class="category-description">{{ category.description }}</div>
              }

              @if (category.pattern) {
                <div class="category-pattern">
                  <code>{{ category.pattern }}</code>
                </div>
              }

              <div class="category-actions">
                <button
                  class="action-btn"
                  (click)="selectAll(category.id)"
                  title="Select all highlights in this category"
                >
                  Select All
                </button>
                <button
                  class="action-btn"
                  (click)="jumpToFirst(category.id)"
                  title="Jump to first highlight"
                >
                  Jump to First
                </button>
                @if (category.type === 'custom') {
                  <button
                    class="action-btn danger"
                    (click)="removeCategory(category.id)"
                    title="Remove this category"
                  >
                    Remove
                  </button>
                }
              </div>

              <!-- Deletion progress bar -->
              <div class="deletion-progress">
                <div
                  class="progress-bar"
                  [style.width.%]="getDeletedPercentage(category.id)"
                ></div>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .categories-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .panel-header {
      padding: 0 0 0.75rem 0;
      border-bottom: 1px solid var(--border-default);
      margin-bottom: 0.75rem;

      h3 {
        margin: 0 0 0.5rem 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .header-stats {
      display: flex;
      gap: 1rem;
      font-size: 0.75rem;
    }

    .stat {
      &.included {
        color: var(--accent-success);
      }
      &.excluded {
        color: var(--accent-danger);
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
      text-align: center;
      color: var(--text-secondary);

      .empty-icon {
        font-size: 2rem;
        margin-bottom: 0.5rem;
        opacity: 0.5;
      }

      p {
        margin: 0;
        font-size: 0.875rem;
      }

      .hint {
        font-size: 0.75rem;
        margin-top: 0.5rem;
        opacity: 0.7;
      }
    }

    .category-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      overflow-y: auto;
      flex: 1;
    }

    .category-card {
      background: var(--bg-surface);
      border-radius: 6px;
      border-left: 3px solid var(--category-color, var(--accent-primary));
      padding: 0.75rem;
      position: relative;
      overflow: hidden;

      &.all-deleted {
        opacity: 0.6;

        .category-name {
          text-decoration: line-through;
        }
      }
    }

    .category-header {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .category-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .category-info {
      flex: 1;
      min-width: 0;
    }

    .category-name {
      display: block;
      font-weight: 500;
      font-size: 0.8125rem;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .category-stats {
      display: block;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      margin-top: 0.125rem;
    }

    .category-toggle {
      flex-shrink: 0;
    }

    .toggle-btn {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.deleted {
        color: var(--accent-success);

        &:hover {
          background: color-mix(in srgb, var(--accent-success) 15%, transparent);
        }
      }

      .icon {
        font-size: 0.875rem;
      }
    }

    .category-description {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.5rem;
      line-height: 1.4;
    }

    .category-pattern {
      margin-top: 0.5rem;

      code {
        display: inline-block;
        background: var(--bg-elevated);
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        font-size: 0.6875rem;
        color: var(--text-secondary);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .category-actions {
      display: flex;
      gap: 0.375rem;
      margin-top: 0.75rem;
      flex-wrap: wrap;
    }

    .action-btn {
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.danger {
        color: var(--accent-danger);

        &:hover {
          background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
        }
      }
    }

    .deletion-progress {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--bg-elevated);
    }

    .progress-bar {
      height: 100%;
      background: var(--accent-danger);
      transition: width 0.2s ease;
    }
  `]
})
export class EpubCategoriesPanelComponent {
  readonly editorState = inject(EpubEditorStateService);

  // Events
  readonly categorySelected = output<string>();
  readonly jumpToHighlight = output<string>();

  /**
   * Check if all highlights in a category are deleted
   */
  isAllDeleted(categoryId: string): boolean {
    const chapterMap = this.editorState.categoryHighlights().get(categoryId);
    if (!chapterMap) return true;

    const deleted = this.editorState.deletedHighlightIds();
    let allDeleted = true;

    chapterMap.forEach((highlights, chapterId) => {
      for (const highlight of highlights) {
        const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
        if (!deleted.has(id)) {
          allDeleted = false;
          return;
        }
      }
    });

    return allDeleted;
  }

  /**
   * Get percentage of deleted highlights in a category
   */
  getDeletedPercentage(categoryId: string): number {
    const chapterMap = this.editorState.categoryHighlights().get(categoryId);
    if (!chapterMap) return 0;

    const deleted = this.editorState.deletedHighlightIds();
    let total = 0;
    let deletedCount = 0;

    chapterMap.forEach((highlights, chapterId) => {
      for (const highlight of highlights) {
        total++;
        const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
        if (deleted.has(id)) {
          deletedCount++;
        }
      }
    });

    if (total === 0) return 0;
    return (deletedCount / total) * 100;
  }

  /**
   * Toggle deletion of all highlights in category
   */
  toggleCategory(categoryId: string): void {
    if (this.isAllDeleted(categoryId)) {
      this.editorState.restoreCategory(categoryId);
    } else {
      this.editorState.deleteCategory(categoryId);
    }
  }

  /**
   * Select all highlights in category
   */
  selectAll(categoryId: string): void {
    this.editorState.selectAllInCategory(categoryId);
    this.categorySelected.emit(categoryId);
  }

  /**
   * Jump to first highlight in category
   */
  jumpToFirst(categoryId: string): void {
    const chapterMap = this.editorState.categoryHighlights().get(categoryId);
    if (!chapterMap) return;

    // Find the first highlight
    for (const [chapterId, highlights] of chapterMap) {
      if (highlights.length > 0) {
        const firstHighlight = highlights[0];
        this.jumpToHighlight.emit(firstHighlight.cfi);
        return;
      }
    }
  }

  /**
   * Remove a custom category
   */
  removeCategory(categoryId: string): void {
    this.editorState.removeCategory(categoryId);
  }
}

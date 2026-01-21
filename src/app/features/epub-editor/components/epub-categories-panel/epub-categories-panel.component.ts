import { Component, inject, output, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EpubEditorStateService } from '../../services/epub-editor-state.service';
import { EpubBlock } from '../../services/epubjs.service';

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
        <h3>Deleted Blocks</h3>
        <div class="header-stats">
          <span class="stat">{{ blocks().length }} total blocks</span>
          <span class="stat excluded">{{ editorState.deletedBlockIds().size }} deleted</span>
        </div>
      </div>

      @if (editorState.deletedBlockIds().size === 0) {
        <div class="empty-state">
          <span class="empty-icon">✓</span>
          <p>No blocks deleted</p>
          <p class="hint">Click any text block or image in the viewer to mark it for deletion.</p>
        </div>
      } @else {
        <div class="deleted-list">
          <div class="list-header">
            <span>{{ editorState.deletedBlockIds().size }} block(s) will be removed on export</span>
            <button class="restore-all-btn" (click)="restoreAll()">
              Restore All
            </button>
          </div>
          @for (blockId of deletedBlocksArray(); track blockId) {
            <div class="deleted-item">
              <div class="deleted-info">
                <span class="deleted-type">{{ getBlockType(blockId) }}</span>
                <span class="deleted-preview">{{ getBlockPreview(blockId) }}</span>
              </div>
              <button
                class="restore-btn"
                (click)="restoreBlock(blockId)"
                title="Restore this block"
              >
                ↩
              </button>
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
      color: var(--text-secondary);

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
        color: var(--accent-success);
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

    .deleted-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      overflow-y: auto;
      flex: 1;
    }

    .list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.5rem;
    }

    .restore-all-btn {
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      border: 1px solid var(--accent-success);
      background: transparent;
      color: var(--accent-success);
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--accent-success);
        color: white;
      }
    }

    .deleted-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      background: var(--bg-surface);
      border-radius: 4px;
      border-left: 3px solid var(--accent-danger);
    }

    .deleted-info {
      flex: 1;
      min-width: 0;
    }

    .deleted-type {
      display: block;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      margin-bottom: 0.125rem;
    }

    .deleted-preview {
      display: block;
      font-size: 0.75rem;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .restore-btn {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--accent-success);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      transition: all 0.15s ease;
      flex-shrink: 0;

      &:hover {
        background: color-mix(in srgb, var(--accent-success) 15%, transparent);
      }
    }
  `]
})
export class EpubCategoriesPanelComponent {
  readonly editorState = inject(EpubEditorStateService);

  // Input: blocks from the viewer
  readonly blocks = input<EpubBlock[]>([]);

  // Events
  readonly categorySelected = output<string>();
  readonly jumpToHighlight = output<string>();
  readonly switchToSearch = output<void>();

  /**
   * Get deleted block IDs as array
   */
  deletedBlocksArray(): string[] {
    return Array.from(this.editorState.deletedBlockIds());
  }

  /**
   * Get block type from ID
   */
  getBlockType(blockId: string): string {
    const block = this.blocks().find(b => b.id === blockId);
    if (!block) return 'Block';

    switch (block.type) {
      case 'image': return '🖼️ Image';
      case 'heading': return '📝 Heading';
      case 'paragraph': return '¶ Paragraph';
      case 'blockquote': return '💬 Quote';
      case 'list': return '📋 List';
      default: return '📄 Block';
    }
  }

  /**
   * Get preview text for a block
   */
  getBlockPreview(blockId: string): string {
    const block = this.blocks().find(b => b.id === blockId);
    if (!block) return blockId;

    const text = block.text;
    if (text.length > 50) {
      return text.substring(0, 50) + '...';
    }
    return text;
  }

  /**
   * Restore a single block
   */
  restoreBlock(blockId: string): void {
    this.editorState.restoreBlocks([blockId]);
  }

  /**
   * Restore all deleted blocks
   */
  restoreAll(): void {
    const allDeleted = Array.from(this.editorState.deletedBlockIds());
    this.editorState.restoreBlocks(allDeleted);
  }
}

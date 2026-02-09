import { Component, input, output, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ArticlePreviewComponent } from '../../../language-learning/components/article-preview/article-preview.component';
import { StudioItem, EditAction } from '../../models/studio.types';
import { StudioService } from '../../services/studio.service';

/**
 * ContentEditorComponent - Article content editing panel
 *
 * Wraps the ArticlePreviewComponent for element selection/deletion.
 * Only shown for article items in the Studio.
 */
@Component({
  selector: 'app-content-editor',
  standalone: true,
  imports: [CommonModule, ArticlePreviewComponent],
  template: `
    <div class="content-editor">
      @if (item()) {
        <app-article-preview
          #articlePreview
          [htmlPath]="item()!.htmlPath || ''"
          [title]="item()!.title"
          [byline]="item()!.byline || ''"
          [wordCount]="item()!.wordCount || 0"
          [initialDeletedSelectors]="item()!.deletedSelectors || []"
          [initialUndoStack]="item()!.undoStack || []"
          [initialRedoStack]="item()!.redoStack || []"
          (deletedSelectorsChange)="onDeletedSelectorsChange($event)"
          (undoStackChange)="onUndoStackChange($event)"
          (redoStackChange)="onRedoStackChange($event)"
          (projectChanged)="onProjectChanged()"
        />
      } @else {
        <div class="empty-state">
          <p>Select an article to edit its content</p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }

    .content-editor {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
    }
  `]
})
export class ContentEditorComponent {
  private readonly studioService = inject(StudioService);

  @ViewChild('articlePreview') articlePreview?: ArticlePreviewComponent;

  // Inputs
  readonly item = input<StudioItem | null>(null);

  // Outputs
  readonly itemChanged = output<void>();

  // Local state for pending changes
  private pendingDeletedSelectors: string[] | null = null;
  private pendingUndoStack: EditAction[] | null = null;
  private pendingRedoStack: EditAction[] | null = null;

  onDeletedSelectorsChange(selectors: string[]): void {
    this.pendingDeletedSelectors = selectors;
  }

  onUndoStackChange(stack: { type: string; selectors: string[]; timestamp: string }[]): void {
    this.pendingUndoStack = stack as EditAction[];
  }

  onRedoStackChange(stack: { type: string; selectors: string[]; timestamp: string }[]): void {
    this.pendingRedoStack = stack as EditAction[];
  }

  async onProjectChanged(): Promise<void> {
    const currentItem = this.item();
    if (!currentItem) return;

    // Save changes to the studio service
    await this.studioService.updateArticle(currentItem.id, {
      deletedSelectors: this.pendingDeletedSelectors ?? currentItem.deletedSelectors,
      undoStack: this.pendingUndoStack ?? currentItem.undoStack,
      redoStack: this.pendingRedoStack ?? currentItem.redoStack
    });

    this.itemChanged.emit();
  }

  /**
   * Get filtered HTML content (for export/processing)
   */
  async getFilteredHtml(): Promise<string> {
    if (!this.articlePreview) return '';
    return this.articlePreview.getFilteredHtml();
  }

  /**
   * Get filtered text content (for export/processing)
   */
  async getFilteredText(): Promise<string> {
    if (!this.articlePreview) return '';
    return this.articlePreview.getFilteredText();
  }
}

import { Injectable, signal, computed } from '@angular/core';
import { TextBlock, Category, PageDimension } from './pdf.service';

export interface HistoryAction {
  type: 'delete' | 'restore';
  blockIds: string[];
  selectionBefore: string[];
  selectionAfter: string[];
}

/**
 * PdfEditorStateService - Manages all editor state for a PDF document
 *
 * This service holds:
 * - Document data (blocks, categories, dimensions)
 * - Selection state
 * - Deletion state
 * - Undo/redo history
 * - Page ordering
 */
@Injectable({
  providedIn: 'root'
})
export class PdfEditorStateService {
  // Core document state
  readonly blocks = signal<TextBlock[]>([]);
  readonly categories = signal<Record<string, Category>>({});
  readonly pageDimensions = signal<PageDimension[]>([]);
  readonly totalPages = signal(0);
  readonly pdfName = signal('');
  readonly pdfPath = signal('');       // Original path (for display)
  readonly libraryPath = signal('');   // Path in library (used for operations)
  readonly fileHash = signal('');      // SHA256 hash for deduplication
  readonly pdfLoaded = signal(false);

  // Selection and deletion state
  readonly deletedBlockIds = signal<Set<string>>(new Set());
  readonly selectedBlockIds = signal<string[]>([]);
  readonly pageOrder = signal<number[]>([]);

  // Undo/redo state
  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  // Change tracking
  readonly hasUnsavedChanges = signal(false);

  // Computed values
  readonly visibleBlocks = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks().filter(b => !deleted.has(b.id));
  });

  readonly categoriesArray = computed(() => {
    return Object.values(this.categories()).sort((a, b) => b.char_count - a.char_count);
  });

  readonly includedChars = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks()
      .filter(b => !deleted.has(b.id))
      .reduce((sum, b) => sum + b.char_count, 0);
  });

  readonly excludedChars = computed(() => {
    const deleted = this.deletedBlockIds();
    return this.blocks()
      .filter(b => deleted.has(b.id))
      .reduce((sum, b) => sum + b.char_count, 0);
  });

  readonly pageNumbers = computed(() => {
    const order = this.pageOrder();
    if (order && order.length > 0) {
      return order;
    }
    return Array.from({ length: this.totalPages() }, (_, i) => i);
  });

  readonly pagesWithSelections = computed(() => {
    const selectedIds = new Set(this.selectedBlockIds());
    const pageCounts = new Map<number, number>();

    for (const block of this.blocks()) {
      if (selectedIds.has(block.id)) {
        pageCounts.set(block.page, (pageCounts.get(block.page) || 0) + 1);
      }
    }

    return pageCounts;
  });

  // Load document data
  loadDocument(data: {
    blocks: TextBlock[];
    categories: Record<string, Category>;
    pageDimensions: PageDimension[];
    totalPages: number;
    pdfName: string;
    pdfPath: string;
    libraryPath?: string;
    fileHash?: string;
    deletedBlockIds?: Set<string>;
    pageOrder?: number[];
  }): void {
    this.blocks.set(data.blocks);
    this.categories.set(data.categories);
    this.pageDimensions.set(data.pageDimensions);
    this.totalPages.set(data.totalPages);
    this.pdfName.set(data.pdfName);
    this.pdfPath.set(data.pdfPath);
    this.libraryPath.set(data.libraryPath || data.pdfPath);  // Fall back to pdfPath for legacy
    this.fileHash.set(data.fileHash || '');
    this.deletedBlockIds.set(data.deletedBlockIds || new Set());
    this.pageOrder.set(data.pageOrder || []);
    this.selectedBlockIds.set([]);
    this.pdfLoaded.set(true);

    // Clear history on new document load
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
  }

  // Clear all state
  reset(): void {
    this.blocks.set([]);
    this.categories.set({});
    this.pageDimensions.set([]);
    this.totalPages.set(0);
    this.pdfName.set('');
    this.pdfPath.set('');
    this.libraryPath.set('');
    this.fileHash.set('');
    this.pdfLoaded.set(false);
    this.deletedBlockIds.set(new Set());
    this.selectedBlockIds.set([]);
    this.pageOrder.set([]);
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
  }

  // Selection methods
  selectBlock(blockId: string, addToSelection: boolean = false): void {
    if (addToSelection) {
      const current = this.selectedBlockIds();
      if (current.includes(blockId)) {
        this.selectedBlockIds.set(current.filter(id => id !== blockId));
      } else {
        this.selectedBlockIds.set([...current, blockId]);
      }
    } else {
      this.selectedBlockIds.set([blockId]);
    }
  }

  selectBlocks(blockIds: string[], addToSelection: boolean = false): void {
    if (addToSelection) {
      const current = new Set(this.selectedBlockIds());
      blockIds.forEach(id => current.add(id));
      this.selectedBlockIds.set(Array.from(current));
    } else {
      this.selectedBlockIds.set(blockIds);
    }
  }

  clearSelection(): void {
    this.selectedBlockIds.set([]);
  }

  selectAllOfCategory(categoryId: string): void {
    const deleted = this.deletedBlockIds();
    const blocks = this.blocks()
      .filter(b => b.category_id === categoryId && !deleted.has(b.id))
      .map(b => b.id);
    this.selectedBlockIds.set(blocks);
  }

  selectAllOnPage(pageNum: number): void {
    const deleted = this.deletedBlockIds();
    const blocks = this.blocks()
      .filter(b => b.page === pageNum && !deleted.has(b.id))
      .map(b => b.id);
    const current = new Set(this.selectedBlockIds());
    blocks.forEach(id => current.add(id));
    this.selectedBlockIds.set(Array.from(current));
  }

  deselectAllOnPage(pageNum: number): void {
    const pageBlocks = new Set(
      this.blocks()
        .filter(b => b.page === pageNum)
        .map(b => b.id)
    );
    this.selectedBlockIds.set(
      this.selectedBlockIds().filter(id => !pageBlocks.has(id))
    );
  }

  // Deletion methods with undo support
  deleteBlocks(blockIds: string[]): void {
    if (blockIds.length === 0) return;

    const selectionBefore = [...this.selectedBlockIds()];
    const deleted = new Set(this.deletedBlockIds());
    blockIds.forEach(id => deleted.add(id));
    this.deletedBlockIds.set(deleted);

    // Clear selection of deleted blocks
    this.selectedBlockIds.set(
      this.selectedBlockIds().filter(id => !blockIds.includes(id))
    );

    // Push to undo stack
    this.pushHistory({
      type: 'delete',
      blockIds: [...blockIds],
      selectionBefore,
      selectionAfter: [...this.selectedBlockIds()]
    });

    this.markChanged();
  }

  deleteSelectedBlocks(): void {
    this.deleteBlocks(this.selectedBlockIds());
  }

  restoreBlocks(blockIds: string[]): void {
    if (blockIds.length === 0) return;

    const selectionBefore = [...this.selectedBlockIds()];
    const deleted = new Set(this.deletedBlockIds());
    blockIds.forEach(id => deleted.delete(id));
    this.deletedBlockIds.set(deleted);

    // Push to undo stack
    this.pushHistory({
      type: 'restore',
      blockIds: [...blockIds],
      selectionBefore,
      selectionAfter: [...this.selectedBlockIds()]
    });

    this.markChanged();
  }

  // Undo/Redo
  undo(): void {
    const action = this.undoStack.pop();
    if (!action) return;

    // Reverse the action
    const deleted = new Set(this.deletedBlockIds());
    if (action.type === 'delete') {
      action.blockIds.forEach(id => deleted.delete(id));
    } else {
      action.blockIds.forEach(id => deleted.add(id));
    }
    this.deletedBlockIds.set(deleted);

    // Restore selection state
    this.selectedBlockIds.set(action.selectionBefore);

    // Push to redo stack
    this.redoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();
  }

  redo(): void {
    const action = this.redoStack.pop();
    if (!action) return;

    // Re-apply the action
    const deleted = new Set(this.deletedBlockIds());
    if (action.type === 'delete') {
      action.blockIds.forEach(id => deleted.add(id));
    } else {
      action.blockIds.forEach(id => deleted.delete(id));
    }
    this.deletedBlockIds.set(deleted);

    // Restore selection state
    this.selectedBlockIds.set(action.selectionAfter);

    // Push back to undo stack
    this.undoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();
  }

  private pushHistory(action: HistoryAction): void {
    this.undoStack.push(action);
    this.redoStack = []; // Clear redo stack on new action
    this.updateHistorySignals();
  }

  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.updateHistorySignals();
  }

  private updateHistorySignals(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
  }

  // Get history for serialization
  getHistory(): { undoStack: HistoryAction[]; redoStack: HistoryAction[] } {
    return {
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack]
    };
  }

  // Restore history from serialization
  setHistory(history: { undoStack: HistoryAction[]; redoStack: HistoryAction[] }): void {
    this.undoStack = [...history.undoStack];
    this.redoStack = [...history.redoStack];
    this.updateHistorySignals();
  }

  // Page ordering
  setPageOrder(order: number[]): void {
    this.pageOrder.set(order);
    this.markChanged();
  }

  resetPageOrder(): void {
    this.pageOrder.set([]);
    this.markChanged();
  }

  // Change tracking
  markChanged(): void {
    this.hasUnsavedChanges.set(true);
  }

  markSaved(): void {
    this.hasUnsavedChanges.set(false);
  }

  // Update a block's text (for text editing)
  updateBlockText(blockId: string, newText: string): void {
    const blocks = this.blocks();
    const index = blocks.findIndex(b => b.id === blockId);
    if (index === -1) return;

    const updatedBlocks = [...blocks];
    updatedBlocks[index] = {
      ...updatedBlocks[index],
      text: newText,
      char_count: newText.length
    };
    this.blocks.set(updatedBlocks);
    this.markChanged();
  }

  // Find similar blocks (by category, font size, region)
  findSimilarBlocks(blockId: string): string[] {
    const block = this.blocks().find(b => b.id === blockId);
    if (!block) return [];

    const deleted = this.deletedBlockIds();
    return this.blocks()
      .filter(b =>
        b.id !== blockId &&
        !deleted.has(b.id) &&
        b.category_id === block.category_id
      )
      .map(b => b.id);
  }

  // Get block by ID
  getBlock(blockId: string): TextBlock | undefined {
    return this.blocks().find(b => b.id === blockId);
  }

  // Get blocks on a specific page
  getBlocksOnPage(pageNum: number): TextBlock[] {
    return this.blocks().filter(b => b.page === pageNum);
  }
}

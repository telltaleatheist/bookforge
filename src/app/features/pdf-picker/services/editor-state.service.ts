import { Injectable, signal, computed } from '@angular/core';
import { TextBlock, Category, PageDimension } from './pdf.service';

export interface HistoryAction {
  type: 'delete' | 'restore' | 'textEdit' | 'toggleBackgrounds';
  blockIds: string[];
  selectionBefore: string[];
  selectionAfter: string[];
  // For textEdit actions
  textBefore?: string | null;  // null means no correction (original text)
  textAfter?: string | null;
  // For toggleBackgrounds actions
  backgroundsBefore?: boolean;
  backgroundsAfter?: boolean;
}

/**
 * BlockEdit - Stores all edits for a single text block
 * Used for OCR corrections, repositioning, and resizing
 */
export interface BlockEdit {
  // Text correction (if different from original)
  text?: string;
  // Position offset from original (for drag/drop)
  offsetX?: number;
  offsetY?: number;
  // Size override (for resizing)
  width?: number;
  height?: number;
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

  /**
   * Get the effective path for file operations.
   * Returns libraryPath if available, otherwise falls back to pdfPath.
   * This is the path where the file actually exists.
   */
  readonly effectivePath = computed(() => this.libraryPath() || this.pdfPath());
  readonly pdfLoaded = signal(false);

  // Selection and deletion state
  readonly deletedBlockIds = signal<Set<string>>(new Set());
  readonly selectedBlockIds = signal<string[]>([]);
  readonly pageOrder = signal<number[]>([]);

  // Background removal state
  readonly removeBackgrounds = signal(false);

  // Block edits (text corrections, position offsets, size overrides)
  readonly blockEdits = signal<Map<string, BlockEdit>>(new Map());

  // Computed: text corrections only (for backward compatibility)
  readonly textCorrections = computed(() => {
    const edits = this.blockEdits();
    const corrections = new Map<string, string>();
    edits.forEach((edit, blockId) => {
      if (edit.text !== undefined) {
        corrections.set(blockId, edit.text);
      }
    });
    return corrections;
  });

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
    blockEdits?: Map<string, BlockEdit>;
    textCorrections?: Map<string, string>;  // Legacy support
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

    // Load block edits - prefer blockEdits, fall back to converting textCorrections
    if (data.blockEdits) {
      this.blockEdits.set(data.blockEdits);
    } else if (data.textCorrections) {
      // Convert legacy textCorrections to blockEdits
      const edits = new Map<string, BlockEdit>();
      data.textCorrections.forEach((text, blockId) => {
        edits.set(blockId, { text });
      });
      this.blockEdits.set(edits);
    } else {
      this.blockEdits.set(new Map());
    }

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
    this.removeBackgrounds.set(false);
    this.blockEdits.set(new Map());
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
  }

  // Block edit methods
  getBlockEdit(blockId: string): BlockEdit | undefined {
    return this.blockEdits().get(blockId);
  }

  updateBlockEdit(blockId: string, edit: Partial<BlockEdit>): void {
    this.blockEdits.update(map => {
      const newMap = new Map(map);
      const existing = newMap.get(blockId) || {};
      newMap.set(blockId, { ...existing, ...edit });
      return newMap;
    });
    this.markChanged();
  }

  clearBlockEdit(blockId: string): void {
    this.blockEdits.update(map => {
      const newMap = new Map(map);
      newMap.delete(blockId);
      return newMap;
    });
    this.markChanged();
  }

  // Text correction methods (for OCR fixes) - convenience wrappers
  setTextCorrection(blockId: string, correctedText: string, addToHistory: boolean = true): void {
    const previousText = this.blockEdits().get(blockId)?.text ?? null;

    this.updateBlockEdit(blockId, { text: correctedText });

    if (addToHistory && correctedText !== previousText) {
      this.pushHistory({
        type: 'textEdit',
        blockIds: [blockId],
        selectionBefore: [...this.selectedBlockIds()],
        selectionAfter: [...this.selectedBlockIds()],
        textBefore: previousText,
        textAfter: correctedText,
      });
    }
  }

  clearTextCorrection(blockId: string, addToHistory: boolean = true): void {
    const edit = this.blockEdits().get(blockId);
    if (edit && edit.text !== undefined) {
      const previousText = edit.text;

      // Remove just the text, keep other edits
      const { text, ...rest } = edit;
      if (Object.keys(rest).length > 0) {
        this.blockEdits.update(map => {
          const newMap = new Map(map);
          newMap.set(blockId, rest);
          return newMap;
        });
      } else {
        this.clearBlockEdit(blockId);
      }
      this.markChanged();

      if (addToHistory) {
        this.pushHistory({
          type: 'textEdit',
          blockIds: [blockId],
          selectionBefore: [...this.selectedBlockIds()],
          selectionAfter: [...this.selectedBlockIds()],
          textBefore: previousText,
          textAfter: null,  // null means reverted to original
        });
      }
    }
  }

  getTextForBlock(blockId: string): string {
    const edit = this.blockEdits().get(blockId);
    if (edit?.text !== undefined) {
      return edit.text;
    }
    const block = this.blocks().find(b => b.id === blockId);
    return block?.text || '';
  }

  // Position methods (for drag/drop)
  setBlockPosition(blockId: string, offsetX: number, offsetY: number): void {
    this.updateBlockEdit(blockId, { offsetX, offsetY });
  }

  clearBlockPosition(blockId: string): void {
    const edit = this.blockEdits().get(blockId);
    if (edit) {
      const { offsetX, offsetY, ...rest } = edit;
      if (Object.keys(rest).length > 0) {
        this.blockEdits.update(map => {
          const newMap = new Map(map);
          newMap.set(blockId, rest);
          return newMap;
        });
      } else {
        this.clearBlockEdit(blockId);
      }
      this.markChanged();
    }
  }

  // Size methods (for resizing)
  setBlockSize(blockId: string, width: number, height: number): void {
    this.updateBlockEdit(blockId, { width, height });
  }

  clearBlockSize(blockId: string): void {
    const edit = this.blockEdits().get(blockId);
    if (edit) {
      const { width, height, ...rest } = edit;
      if (Object.keys(rest).length > 0) {
        this.blockEdits.update(map => {
          const newMap = new Map(map);
          newMap.set(blockId, rest);
          return newMap;
        });
      } else {
        this.clearBlockEdit(blockId);
      }
      this.markChanged();
    }
  }

  hasCorrection(blockId: string): boolean {
    const edit = this.blockEdits().get(blockId);
    return edit?.text !== undefined;
  }

  hasAnyEdit(blockId: string): boolean {
    return this.blockEdits().has(blockId);
  }

  hasPositionEdit(blockId: string): boolean {
    const edit = this.blockEdits().get(blockId);
    return edit?.offsetX !== undefined || edit?.offsetY !== undefined;
  }

  hasSizeEdit(blockId: string): boolean {
    const edit = this.blockEdits().get(blockId);
    return edit?.width !== undefined || edit?.height !== undefined;
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

    // Filter out OCR blocks - they are authoritative text and should never be deleted
    // (deleting images should not delete the OCR text that was extracted from them)
    const blocksById = new Map(this.blocks().map(b => [b.id, b]));
    const deletableIds = blockIds.filter(id => {
      const block = blocksById.get(id);
      return block && !block.is_ocr;
    });

    if (deletableIds.length === 0) return;

    const selectionBefore = [...this.selectedBlockIds()];
    const deleted = new Set(this.deletedBlockIds());
    deletableIds.forEach(id => deleted.add(id));
    this.deletedBlockIds.set(deleted);

    // Clear selection of deleted blocks
    this.selectedBlockIds.set(
      this.selectedBlockIds().filter(id => !deletableIds.includes(id))
    );

    // Push to undo stack
    this.pushHistory({
      type: 'delete',
      blockIds: [...deletableIds],
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
  undo(): HistoryAction | undefined {
    const action = this.undoStack.pop();
    if (!action) return undefined;

    if (action.type === 'textEdit') {
      // Reverse text edit
      const blockId = action.blockIds[0];
      if (action.textBefore === null || action.textBefore === undefined) {
        // Was a new correction, clear it
        this.clearTextCorrection(blockId, false);
      } else {
        // Restore previous text
        this.setTextCorrection(blockId, action.textBefore, false);
      }
    } else if (action.type === 'toggleBackgrounds') {
      // Reverse background toggle
      this.removeBackgrounds.set(action.backgroundsBefore ?? false);
    } else {
      // Reverse delete/restore action
      const deleted = new Set(this.deletedBlockIds());
      if (action.type === 'delete') {
        action.blockIds.forEach(id => deleted.delete(id));
      } else {
        action.blockIds.forEach(id => deleted.add(id));
      }
      this.deletedBlockIds.set(deleted);
    }

    // Restore selection state
    this.selectedBlockIds.set(action.selectionBefore);

    // Push to redo stack
    this.redoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();

    return action;
  }

  redo(): HistoryAction | undefined {
    const action = this.redoStack.pop();
    if (!action) return undefined;

    if (action.type === 'textEdit') {
      // Re-apply text edit
      const blockId = action.blockIds[0];
      if (action.textAfter === null || action.textAfter === undefined) {
        // Was a revert, clear the correction
        this.clearTextCorrection(blockId, false);
      } else {
        // Apply the correction
        this.setTextCorrection(blockId, action.textAfter, false);
      }
    } else if (action.type === 'toggleBackgrounds') {
      // Re-apply background toggle
      this.removeBackgrounds.set(action.backgroundsAfter ?? false);
    } else {
      // Re-apply delete/restore action
      const deleted = new Set(this.deletedBlockIds());
      if (action.type === 'delete') {
        action.blockIds.forEach(id => deleted.add(id));
      } else {
        action.blockIds.forEach(id => deleted.delete(id));
      }
      this.deletedBlockIds.set(deleted);
    }

    // Restore selection state
    this.selectedBlockIds.set(action.selectionAfter);

    // Push back to undo stack
    this.undoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();

    return action;
  }

  /**
   * Toggle remove backgrounds state with history tracking
   * Returns the new value so caller can trigger re-render
   */
  toggleRemoveBackgrounds(): boolean {
    const before = this.removeBackgrounds();
    const after = !before;

    this.removeBackgrounds.set(after);

    this.pushHistory({
      type: 'toggleBackgrounds',
      blockIds: [],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      backgroundsBefore: before,
      backgroundsAfter: after
    });

    this.markChanged();

    return after;
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

  // Add new blocks to the document
  addBlocks(newBlocks: TextBlock[]): void {
    if (newBlocks.length === 0) return;
    this.blocks.update(existing => [...existing, ...newBlocks]);
    this.markChanged();
  }

  // Replace text blocks on specific pages with new OCR blocks
  // Keeps image blocks, replaces all text blocks on the specified pages
  replaceTextBlocksOnPages(pages: number[], newBlocks: TextBlock[]): void {
    const pageSet = new Set(pages);
    this.blocks.update(existing => {
      // Keep blocks that are:
      // 1. Not on the specified pages, OR
      // 2. Image blocks (we want to keep images, just replace text)
      const kept = existing.filter(b => !pageSet.has(b.page) || b.is_image);
      return [...kept, ...newBlocks];
    });
    this.markChanged();
  }

  // Add or update a category
  addCategory(category: Category): void {
    this.categories.update(cats => ({
      ...cats,
      [category.id]: category
    }));
    this.markChanged();
  }

  // Update category stats (block_count, char_count) and remove empty categories
  updateCategoryStats(): void {
    const blocks = this.blocks();
    const deleted = this.deletedBlockIds();
    const stats = new Map<string, { block_count: number; char_count: number }>();

    for (const block of blocks) {
      if (deleted.has(block.id)) continue;
      const existing = stats.get(block.category_id) || { block_count: 0, char_count: 0 };
      stats.set(block.category_id, {
        block_count: existing.block_count + 1,
        char_count: existing.char_count + block.char_count
      });
    }

    this.categories.update(cats => {
      const updated: Record<string, Category> = {};

      // Only keep categories that have blocks
      for (const [catId, cat] of Object.entries(cats)) {
        const catStats = stats.get(catId);
        if (catStats && catStats.block_count > 0) {
          updated[catId] = {
            ...cat,
            block_count: catStats.block_count,
            char_count: catStats.char_count
          };
        }
        // Categories with 0 blocks are removed
      }

      return updated;
    });
  }
}

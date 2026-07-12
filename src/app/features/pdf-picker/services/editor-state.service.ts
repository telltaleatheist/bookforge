import { Injectable, signal, computed } from '@angular/core';
import { TextBlock, Category, PageDimension } from './pdf.service';
import { ClassificationThresholds, getDefaultThresholds } from './category-learner';

export interface SplitDefinition {
  originalBlockId: string;
  splitPoints: number[];       // line-group indices where splits were placed
  childBlockIds: string[];     // IDs of generated child blocks
  childBlocks: TextBlock[];    // full block data (needed for undo/redo)
}

export interface MergeDefinition {
  mergedBlockId: string;
  sourceBlockIds: string[];
  sourceBlocks: TextBlock[];   // full source block data (needed for undo)
  mergedBlock: TextBlock;
}

/** Axis-aligned rectangle in PDF page-point space (same space as TextBlock.x/y/w/h). */
export interface CropGeometryRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A persistent crop applied to one page. The crop is a display-only region that
 * marks everything OUTSIDE `rect` as removed. `deletedBlockIds` records exactly
 * which live blocks THIS crop deleted on that page, so the crop can be reversed
 * without disturbing blocks that were already deleted by other means.
 */
export interface CropRegion {
  rect: CropGeometryRect;
  deletedBlockIds: string[];
}

export interface HistoryAction {
  type: 'delete' | 'restore' | 'textEdit' | 'toggleBackgrounds' | 'move' | 'resize' | 'deletePage' | 'restorePage' | 'reorderPages' | 'selection' | 'paragraphBreak' | 'categoryCorrection' | 'splitBlock' | 'mergeBlocks' | 'cropApply' | 'cropClear';
  blockIds: string[];
  selectionBefore: string[];
  selectionAfter: string[];
  // For textEdit actions
  textBefore?: string | null;  // null means no correction (original text)
  textAfter?: string | null;
  // For toggleBackgrounds actions
  backgroundsBefore?: boolean;
  backgroundsAfter?: boolean;
  // For move actions
  offsetXBefore?: number;
  offsetYBefore?: number;
  offsetXAfter?: number;
  offsetYAfter?: number;
  // For resize actions
  widthBefore?: number;
  heightBefore?: number;
  widthAfter?: number;
  heightAfter?: number;
  // For page actions
  pageNumbers?: number[];
  pageOrderBefore?: number[];
  pageOrderAfter?: number[];
  // For paragraph break actions
  paragraphBreaksBefore?: string[];
  paragraphBreaksAfter?: string[];
  // For category correction actions
  categoryCorrectionsBefore?: [string, string][];
  categoryCorrectionsAfter?: [string, string][];
  blockCategoryBefore?: string;  // block's category_id before correction
  blockCategoryAfter?: string;   // block's category_id after correction
  bulkBlockCategoriesBefore?: [string, string][];  // for bulk: blockId → previous categoryId
  bulkBlockCategoriesAfter?: [string, string][];   // for bulk: blockId → new categoryId
  // For splitBlock actions
  splitDefinition?: SplitDefinition;
  // For mergeBlocks actions
  mergeDefinitions?: MergeDefinition[];
  // For cropApply / cropClear actions — composite crop region + block-deletion
  // reversal. Stored as plain Records (page number → value) so the action
  // round-trips through JSON when history is serialized into the project file.
  // A null value means "no crop region on that page".
  cropPagesBefore?: Record<string, CropRegion | null>;
  cropPagesAfter?: Record<string, CropRegion | null>;
  // Block IDs whose deleted-state this action toggled. On cropApply these were
  // newly deleted (apply/redo add them, undo restores them). On cropClear these
  // were restored (apply/redo restore them, undo re-deletes them).
  cropBlockIdsToggled?: string[];
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
 * A crop history action must carry all three crop fields; a partial one means
 * corrupted history (e.g. a bad project file) and undoing/redoing it would
 * silently half-apply. Fail loudly instead.
 */
function requireCropFields(action: HistoryAction): {
  cropPagesBefore: Record<string, CropRegion | null>;
  cropPagesAfter: Record<string, CropRegion | null>;
  cropBlockIdsToggled: string[];
} {
  const { cropPagesBefore, cropPagesAfter, cropBlockIdsToggled } = action;
  if (!cropPagesBefore || !cropPagesAfter || !cropBlockIdsToggled) {
    throw new Error(`History action '${action.type}' is missing crop fields — corrupted history`);
  }
  return { cropPagesBefore, cropPagesAfter, cropBlockIdsToggled };
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

  /** True while background text extraction is in progress (analyzeText running) */
  readonly textLoading = signal(false);

  // Selection and deletion state
  readonly deletedBlockIds = signal<Set<string>>(new Set());
  readonly selectedBlockIds = signal<string[]>([]);
  readonly pageOrder = signal<number[]>([]);
  readonly deletedPages = signal<Set<number>>(new Set());  // Pages excluded from export

  // Background removal state
  readonly removeBackgrounds = signal(false);

  // Paragraph break detection state
  readonly paragraphBreaks = signal<Set<string>>(new Set());

  // Block splits: originalBlockId → SplitDefinition (user-driven block splitting)
  readonly blockSplits = signal<Map<string, SplitDefinition>>(new Map());

  // Block merges: mergedBlockId → MergeDefinition (user-driven block merging)
  readonly blockMerges = signal<Map<string, MergeDefinition>>(new Map());

  // Persistent crop regions: 0-indexed page number → CropRegion. The single
  // source of truth for crop — durable, undoable, and serialized into the
  // project file. A page with an entry has everything OUTSIDE its rect removed.
  readonly cropRegions = signal<Map<number, CropRegion>>(new Map());

  // Category corrections: blockId → target categoryId (explicit user overrides)
  readonly categoryCorrections = signal<Map<string, string>>(new Map());

  // Learned category assignments from re-detect (not user-explicit, no outline)
  readonly learnedCategories = signal<Map<string, string>>(new Map());

  // Classification thresholds (user-adjustable per-book)
  readonly classificationThresholds = signal<ClassificationThresholds>(getDefaultThresholds());

  // Show text layer overlay (for OCR verification)
  readonly showTextLayer = signal(false);

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
    deletedPages?: Set<number>;
    pageOrder?: number[];
    blockEdits?: Map<string, BlockEdit>;
    textCorrections?: Map<string, string>;  // Legacy support
    paragraphBreaks?: Set<string>;
    categoryCorrections?: Map<string, string>;
    learnedCategories?: Map<string, string>;
    classificationThresholds?: ClassificationThresholds;
    cropRegions?: Map<number, CropRegion>;
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
    this.deletedPages.set(data.deletedPages || new Set());
    this.blockSplits.set(new Map());
    this.blockMerges.set(new Map());
    this.cropRegions.set(data.cropRegions || new Map());
    this.removeBackgrounds.set(false);  // Always reset background removal for new document
    this.showTextLayer.set(false);  // Always reset text layer visibility for new document
    this.paragraphBreaks.set(data.paragraphBreaks || new Set());
    this.categoryCorrections.set(data.categoryCorrections || new Map());
    this.learnedCategories.set(data.learnedCategories || new Map());
    this.classificationThresholds.set(data.classificationThresholds || getDefaultThresholds());

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

    // Apply all category overrides (learned + explicit) to blocks
    if (this.learnedCategories().size > 0 || this.categoryCorrections().size > 0) {
      this.applyCategoryCorrections();
      this.updateCategoryStats();
    }

    // Clear history on new document load
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
    this.textLoading.set(false);
  }

  /**
   * Update blocks and categories after background text extraction completes.
   * Called when analyzeText() finishes for a document that was opened with analyzeQuick().
   * Re-applies any existing category corrections since the new blocks arrive with
   * their original PDF-analyzed category_ids.
   */
  updateTextData(data: { blocks: TextBlock[]; categories: Record<string, Category> }): void {
    const learned = this.learnedCategories();
    const corrections = this.categoryCorrections();

    this.blocks.set(data.blocks);
    this.categories.set(data.categories);
    this.textLoading.set(false);

    // New blocks from PDF analysis have original category_ids.
    // Re-apply any saved overrides (learned + explicit).
    if (learned.size > 0 || corrections.size > 0) {
      this.applyCategoryCorrections();
      this.updateCategoryStats();
    }
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
    this.showTextLayer.set(false);
    this.paragraphBreaks.set(new Set());
    this.categoryCorrections.set(new Map());
    this.learnedCategories.set(new Map());
    this.classificationThresholds.set(getDefaultThresholds());
    this.blockEdits.set(new Map());
    this.blockSplits.set(new Map());
    this.blockMerges.set(new Map());
    this.cropRegions.set(new Map());
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
  setBlockPosition(blockId: string, offsetX: number, offsetY: number, addToHistory: boolean = false): void {
    if (addToHistory) {
      const edit = this.blockEdits().get(blockId);
      const prevOffsetX = edit?.offsetX ?? 0;
      const prevOffsetY = edit?.offsetY ?? 0;

      // Only add to history if position actually changed
      if (offsetX !== prevOffsetX || offsetY !== prevOffsetY) {
        this.pushHistory({
          type: 'move',
          blockIds: [blockId],
          selectionBefore: [...this.selectedBlockIds()],
          selectionAfter: [...this.selectedBlockIds()],
          offsetXBefore: prevOffsetX,
          offsetYBefore: prevOffsetY,
          offsetXAfter: offsetX,
          offsetYAfter: offsetY,
        });
      }
    }
    this.updateBlockEdit(blockId, { offsetX, offsetY });
  }

  clearBlockPosition(blockId: string, addToHistory: boolean = false): void {
    const edit = this.blockEdits().get(blockId);
    if (edit && (edit.offsetX !== undefined || edit.offsetY !== undefined)) {
      if (addToHistory) {
        this.pushHistory({
          type: 'move',
          blockIds: [blockId],
          selectionBefore: [...this.selectedBlockIds()],
          selectionAfter: [...this.selectedBlockIds()],
          offsetXBefore: edit.offsetX ?? 0,
          offsetYBefore: edit.offsetY ?? 0,
          offsetXAfter: 0,
          offsetYAfter: 0,
        });
      }

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
  setBlockSize(blockId: string, width: number, height: number, addToHistory: boolean = false): void {
    if (addToHistory) {
      const edit = this.blockEdits().get(blockId);
      const block = this.blocks().find(b => b.id === blockId);
      const prevWidth = edit?.width ?? block?.width ?? 0;
      const prevHeight = edit?.height ?? block?.height ?? 0;

      // Only add to history if size actually changed
      if (width !== prevWidth || height !== prevHeight) {
        this.pushHistory({
          type: 'resize',
          blockIds: [blockId],
          selectionBefore: [...this.selectedBlockIds()],
          selectionAfter: [...this.selectedBlockIds()],
          widthBefore: prevWidth,
          heightBefore: prevHeight,
          widthAfter: width,
          heightAfter: height,
        });
      }
    }
    this.updateBlockEdit(blockId, { width, height });
  }

  clearBlockSize(blockId: string, addToHistory: boolean = false): void {
    const edit = this.blockEdits().get(blockId);
    if (edit && (edit.width !== undefined || edit.height !== undefined)) {
      if (addToHistory) {
        const block = this.blocks().find(b => b.id === blockId);
        this.pushHistory({
          type: 'resize',
          blockIds: [blockId],
          selectionBefore: [...this.selectedBlockIds()],
          selectionAfter: [...this.selectedBlockIds()],
          widthBefore: edit.width ?? block?.width ?? 0,
          heightBefore: edit.height ?? block?.height ?? 0,
          widthAfter: block?.width ?? 0,
          heightAfter: block?.height ?? 0,
        });
      }

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

  /**
   * Record a move action in history with explicit before/after values.
   * Used when drag completes to record the full move.
   */
  recordMove(blockId: string, offsetXBefore: number, offsetYBefore: number, offsetXAfter: number, offsetYAfter: number): void {
    // Only record if there was an actual change
    if (offsetXBefore === offsetXAfter && offsetYBefore === offsetYAfter) {
      return;
    }

    this.pushHistory({
      type: 'move',
      blockIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      offsetXBefore,
      offsetYBefore,
      offsetXAfter,
      offsetYAfter,
    });
  }

  /**
   * Record a resize action in history with explicit before/after values.
   */
  recordResize(blockId: string, widthBefore: number, heightBefore: number, widthAfter: number, heightAfter: number): void {
    if (widthBefore === widthAfter && heightBefore === heightAfter) {
      return;
    }

    this.pushHistory({
      type: 'resize',
      blockIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      widthBefore,
      heightBefore,
      widthAfter,
      heightAfter,
    });
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

    // Allow deletion of any block (OCR blocks are now deletable - user has undo if needed)
    const blocksById = new Map(this.blocks().map(b => [b.id, b]));
    const deletableIds = blockIds.filter(id => !!blocksById.get(id));

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

  // Page deletion with history
  deletePages(pageNumbers: number[]): void {
    if (pageNumbers.length === 0) return;

    const deleted = new Set(this.deletedPages());
    pageNumbers.forEach(p => deleted.add(p));
    this.deletedPages.set(deleted);

    this.pushHistory({
      type: 'deletePage',
      blockIds: [],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      pageNumbers: [...pageNumbers]
    });

    this.markChanged();
  }

  restorePages(pageNumbers: number[]): void {
    if (pageNumbers.length === 0) return;

    const deleted = new Set(this.deletedPages());
    pageNumbers.forEach(p => deleted.delete(p));
    this.deletedPages.set(deleted);

    this.pushHistory({
      type: 'restorePage',
      blockIds: [],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      pageNumbers: [...pageNumbers]
    });

    this.markChanged();
  }

  // Toggle page deletion (delete if not deleted, restore if deleted)
  togglePageDeletion(pageNumbers: number[]): void {
    if (pageNumbers.length === 0) return;

    const deleted = this.deletedPages();
    const allDeleted = pageNumbers.every(p => deleted.has(p));

    if (allDeleted) {
      this.restorePages(pageNumbers);
    } else {
      // Delete only the non-deleted pages
      const toDelete = pageNumbers.filter(p => !deleted.has(p));
      this.deletePages(toDelete);
    }
  }

  // Page reordering with history
  setPageOrder(newOrder: number[], pushToHistory = true): void {
    const oldOrder = [...this.pageOrder()];
    this.pageOrder.set(newOrder);

    if (pushToHistory) {
      this.pushHistory({
        type: 'reorderPages',
        blockIds: [],
        selectionBefore: [...this.selectedBlockIds()],
        selectionAfter: [...this.selectedBlockIds()],
        pageOrderBefore: oldOrder,
        pageOrderAfter: [...newOrder]
      });
    }

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
    } else if (action.type === 'move') {
      // Reverse move
      const blockId = action.blockIds[0];
      if (action.offsetXBefore === 0 && action.offsetYBefore === 0) {
        this.clearBlockPosition(blockId, false);
      } else {
        this.setBlockPosition(blockId, action.offsetXBefore ?? 0, action.offsetYBefore ?? 0, false);
      }
    } else if (action.type === 'resize') {
      // Reverse resize
      const blockId = action.blockIds[0];
      const block = this.blocks().find(b => b.id === blockId);
      if (action.widthBefore === block?.width && action.heightBefore === block?.height) {
        this.clearBlockSize(blockId, false);
      } else {
        this.setBlockSize(blockId, action.widthBefore ?? 0, action.heightBefore ?? 0, false);
      }
    } else if (action.type === 'deletePage') {
      // Reverse page deletion - restore pages
      const deleted = new Set(this.deletedPages());
      action.pageNumbers?.forEach(p => deleted.delete(p));
      this.deletedPages.set(deleted);
    } else if (action.type === 'restorePage') {
      // Reverse page restoration - delete pages again
      const deleted = new Set(this.deletedPages());
      action.pageNumbers?.forEach(p => deleted.add(p));
      this.deletedPages.set(deleted);
    } else if (action.type === 'reorderPages') {
      // Reverse page reorder
      this.pageOrder.set(action.pageOrderBefore ?? []);
    } else if (action.type === 'paragraphBreak') {
      this.paragraphBreaks.set(new Set(action.paragraphBreaksBefore || []));
    } else if (action.type === 'categoryCorrection') {
      this.categoryCorrections.set(new Map(action.categoryCorrectionsBefore || []));
      // Restore block category_ids — bulk or single
      if (action.bulkBlockCategoriesBefore && action.bulkBlockCategoriesBefore.length > 0) {
        const beforeMap = new Map(action.bulkBlockCategoriesBefore);
        this.blocks.update(blocks =>
          blocks.map(b => beforeMap.has(b.id) ? { ...b, category_id: beforeMap.get(b.id)! } : b)
        );
      } else if (action.blockIds.length > 0 && action.blockCategoryBefore !== undefined) {
        const blockId = action.blockIds[0];
        this.blocks.update(blocks =>
          blocks.map(b => b.id === blockId ? { ...b, category_id: action.blockCategoryBefore! } : b)
        );
      }
      this.updateCategoryStats();
    } else if (action.type === 'splitBlock' && action.splitDefinition) {
      const def = action.splitDefinition;
      // Remove child blocks from blocks array
      const childIds = new Set(def.childBlockIds);
      this.blocks.update(blocks => blocks.filter(b => !childIds.has(b.id)));
      // Remove original from deletedBlockIds
      this.deletedBlockIds.update(deleted => {
        const next = new Set(deleted);
        next.delete(def.originalBlockId);
        return next;
      });
      // Remove from blockSplits
      this.blockSplits.update(map => {
        const next = new Map(map);
        next.delete(def.originalBlockId);
        return next;
      });
    } else if (action.type === 'mergeBlocks' && action.mergeDefinitions) {
      // Undo merge: remove merged blocks, re-add source blocks
      const mergedIds = new Set(action.mergeDefinitions.map(d => d.mergedBlockId));
      const restoredBlocks = action.mergeDefinitions.flatMap(d => d.sourceBlocks);
      this.blocks.update(blocks => [
        ...blocks.filter(b => !mergedIds.has(b.id)),
        ...restoredBlocks,
      ]);
      // Remove from blockMerges map
      this.blockMerges.update(map => {
        const next = new Map(map);
        for (const def of action.mergeDefinitions!) {
          next.delete(def.mergedBlockId);
        }
        return next;
      });
    } else if (action.type === 'cropApply') {
      // Reverse a crop apply: restore prior regions + un-delete the blocks it deleted.
      this.setCropRegionsFromRecord(requireCropFields(action).cropPagesBefore);
      this.toggleDeletedBlocks(requireCropFields(action).cropBlockIdsToggled, false);
    } else if (action.type === 'cropClear') {
      // Reverse a crop clear: restore the cleared regions + re-delete their blocks.
      this.setCropRegionsFromRecord(requireCropFields(action).cropPagesBefore);
      this.toggleDeletedBlocks(requireCropFields(action).cropBlockIdsToggled, true);
    } else if (action.type === 'selection') {
      // Selection-only action: restore handled below
    } else if (action.type === 'delete' || action.type === 'restore') {
      // Reverse block delete/restore action
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
    if (action.type !== 'selection') this.markChanged();

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
    } else if (action.type === 'move') {
      // Re-apply move
      const blockId = action.blockIds[0];
      if (action.offsetXAfter === 0 && action.offsetYAfter === 0) {
        this.clearBlockPosition(blockId, false);
      } else {
        this.setBlockPosition(blockId, action.offsetXAfter ?? 0, action.offsetYAfter ?? 0, false);
      }
    } else if (action.type === 'resize') {
      // Re-apply resize — if "after" equals the block's natural size this was a
      // clear-size action, so clear instead of recording a spurious explicit edit
      const blockId = action.blockIds[0];
      const block = this.blocks().find(b => b.id === blockId);
      if (action.widthAfter === block?.width && action.heightAfter === block?.height) {
        this.clearBlockSize(blockId, false);
      } else {
        this.setBlockSize(blockId, action.widthAfter ?? 0, action.heightAfter ?? 0, false);
      }
    } else if (action.type === 'deletePage') {
      // Re-apply page deletion
      const deleted = new Set(this.deletedPages());
      action.pageNumbers?.forEach(p => deleted.add(p));
      this.deletedPages.set(deleted);
    } else if (action.type === 'restorePage') {
      // Re-apply page restoration
      const deleted = new Set(this.deletedPages());
      action.pageNumbers?.forEach(p => deleted.delete(p));
      this.deletedPages.set(deleted);
    } else if (action.type === 'reorderPages') {
      // Re-apply page reorder
      this.pageOrder.set(action.pageOrderAfter ?? []);
    } else if (action.type === 'paragraphBreak') {
      this.paragraphBreaks.set(new Set(action.paragraphBreaksAfter || []));
    } else if (action.type === 'categoryCorrection') {
      this.categoryCorrections.set(new Map(action.categoryCorrectionsAfter || []));
      // Apply block category_ids — bulk or single
      if (action.bulkBlockCategoriesAfter && action.bulkBlockCategoriesAfter.length > 0) {
        const afterMap = new Map(action.bulkBlockCategoriesAfter);
        this.blocks.update(blocks =>
          blocks.map(b => afterMap.has(b.id) ? { ...b, category_id: afterMap.get(b.id)! } : b)
        );
      } else if (action.blockIds.length > 0 && action.blockCategoryAfter !== undefined) {
        const blockId = action.blockIds[0];
        this.blocks.update(blocks =>
          blocks.map(b => b.id === blockId ? { ...b, category_id: action.blockCategoryAfter! } : b)
        );
      }
      this.updateCategoryStats();
    } else if (action.type === 'splitBlock' && action.splitDefinition) {
      const def = action.splitDefinition;
      // Re-add child blocks
      this.blocks.update(blocks => [...blocks, ...def.childBlocks]);
      // Re-delete original
      this.deletedBlockIds.update(deleted => {
        const next = new Set(deleted);
        next.add(def.originalBlockId);
        return next;
      });
      // Re-store split definition
      this.blockSplits.update(map => {
        const next = new Map(map);
        next.set(def.originalBlockId, def);
        return next;
      });
    } else if (action.type === 'mergeBlocks' && action.mergeDefinitions) {
      // Redo merge: remove source blocks, re-add merged blocks
      const allSourceIds = new Set<string>();
      for (const def of action.mergeDefinitions) {
        for (const srcId of def.sourceBlockIds) allSourceIds.add(srcId);
      }
      this.blocks.update(blocks => [
        ...blocks.filter(b => !allSourceIds.has(b.id)),
        ...action.mergeDefinitions!.map(d => d.mergedBlock),
      ]);
      // Re-store merge definitions
      this.blockMerges.update(map => {
        const next = new Map(map);
        for (const def of action.mergeDefinitions!) {
          next.set(def.mergedBlockId, def);
        }
        return next;
      });
    } else if (action.type === 'cropApply') {
      // Re-apply a crop: set the new regions + re-delete their blocks.
      this.setCropRegionsFromRecord(requireCropFields(action).cropPagesAfter);
      this.toggleDeletedBlocks(requireCropFields(action).cropBlockIdsToggled, true);
    } else if (action.type === 'cropClear') {
      // Re-apply a crop clear: remove the regions + restore their blocks.
      this.setCropRegionsFromRecord(requireCropFields(action).cropPagesAfter);
      this.toggleDeletedBlocks(requireCropFields(action).cropBlockIdsToggled, false);
    } else if (action.type === 'selection') {
      // Selection-only action: restore handled below
    } else if (action.type === 'delete' || action.type === 'restore') {
      // Re-apply block delete/restore action
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
    if (action.type !== 'selection') this.markChanged();

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

  // Block split methods
  splitBlock(definition: SplitDefinition, addToHistory: boolean = true): void {
    // Add child blocks to the blocks array
    this.blocks.update(blocks => [...blocks, ...definition.childBlocks]);

    // Hide the original block by adding it to deletedBlockIds
    this.deletedBlockIds.update(deleted => {
      const next = new Set(deleted);
      next.add(definition.originalBlockId);
      return next;
    });

    // Store split definition
    this.blockSplits.update(map => {
      const next = new Map(map);
      next.set(definition.originalBlockId, definition);
      return next;
    });

    if (addToHistory) {
      this.pushHistory({
        type: 'splitBlock',
        blockIds: [definition.originalBlockId],
        selectionBefore: [...this.selectedBlockIds()],
        selectionAfter: definition.childBlockIds,
        splitDefinition: definition,
      });
    }

    // Select the new child blocks
    this.selectedBlockIds.set(definition.childBlockIds);
    this.markChanged();
  }

  // Block merge methods
  mergeBlocks(definitions: MergeDefinition[], addToHistory: boolean = true): void {
    // Remove source blocks from blocks array and add merged blocks in one update
    const allSourceIds = new Set<string>();
    for (const def of definitions) {
      for (const srcId of def.sourceBlockIds) {
        allSourceIds.add(srcId);
      }
    }
    this.blocks.update(blocks => [
      ...blocks.filter(b => !allSourceIds.has(b.id)),
      ...definitions.map(d => d.mergedBlock),
    ]);

    // Store merge definitions
    this.blockMerges.update(map => {
      const next = new Map(map);
      for (const def of definitions) {
        next.set(def.mergedBlockId, def);
      }
      return next;
    });

    if (addToHistory) {
      this.pushHistory({
        type: 'mergeBlocks',
        blockIds: definitions.map(d => d.mergedBlockId),
        selectionBefore: [...this.selectedBlockIds()],
        selectionAfter: definitions.map(d => d.mergedBlockId),
        mergeDefinitions: definitions,
      });
    }

    // Select the new merged blocks
    this.selectedBlockIds.set(definitions.map(d => d.mergedBlockId));
    this.markChanged();
  }

  // ── Crop methods ──────────────────────────────────────────────────────────
  //
  // A crop is a persistent, undoable region per page. Applying a crop is ONE
  // composite history action that both records the region(s) and deletes the
  // blocks that fall outside them. Clearing is the exact symmetric inverse.

  /**
   * Apply a crop to one or more pages in a single undoable action.
   * @param entries    page number → crop rectangle (already scaled/clamped to
   *                   that page by the caller).
   * @param blockIdsToDelete  IDs of blocks (across all target pages) that fall
   *                   fully outside their page's rect. Already-deleted or
   *                   non-existent IDs are ignored. Each surviving ID is
   *                   attributed to its page's CropRegion for exact reversal.
   */
  applyCrop(entries: Map<number, CropGeometryRect>, blockIdsToDelete: string[]): void {
    if (entries.size === 0) return;

    const selectionBefore = [...this.selectedBlockIds()];
    const blocksById = new Map(this.blocks().map(b => [b.id, b]));
    const currentDeleted = this.deletedBlockIds();

    // Only newly-delete blocks that exist and aren't already deleted, so this
    // action owns exactly the deletions it will reverse.
    const toDelete = blockIdsToDelete.filter(id => blocksById.has(id) && !currentDeleted.has(id));

    // Attribute each deletion to the page it lives on.
    const deletedByPage = new Map<number, string[]>();
    for (const id of toDelete) {
      const page = blocksById.get(id)!.page;
      const arr = deletedByPage.get(page);
      if (arr) arr.push(id);
      else deletedByPage.set(page, [id]);
    }

    const before: Record<string, CropRegion | null> = {};
    const after: Record<string, CropRegion | null> = {};
    const regions = new Map(this.cropRegions());
    for (const [page, rect] of entries) {
      const prev = regions.get(page);
      before[String(page)] = prev
        ? { rect: { ...prev.rect }, deletedBlockIds: [...prev.deletedBlockIds] }
        : null;
      const region: CropRegion = {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        deletedBlockIds: deletedByPage.get(page) ?? [],
      };
      after[String(page)] = region;
      regions.set(page, region);
    }
    this.cropRegions.set(regions);

    // Delete outside blocks and drop them from the selection.
    if (toDelete.length > 0) {
      const deleted = new Set(currentDeleted);
      toDelete.forEach(id => deleted.add(id));
      this.deletedBlockIds.set(deleted);
      const toDeleteSet = new Set(toDelete);
      this.selectedBlockIds.set(this.selectedBlockIds().filter(id => !toDeleteSet.has(id)));
    }

    this.pushHistory({
      type: 'cropApply',
      blockIds: [...toDelete],
      selectionBefore,
      selectionAfter: [...this.selectedBlockIds()],
      cropPagesBefore: before,
      cropPagesAfter: after,
      cropBlockIdsToggled: [...toDelete],
    });

    this.markChanged();
  }

  /**
   * Clear the crop on the given pages (composite inverse of applyCrop): removes
   * each page's region entry and restores the blocks that region deleted,
   * skipping any IDs that no longer exist. One undoable action.
   */
  clearCrop(pages: number[]): void {
    const regions = this.cropRegions();
    const targetPages = pages.filter(p => regions.has(p));
    if (targetPages.length === 0) return;

    const selectionBefore = [...this.selectedBlockIds()];
    const existingIds = new Set(this.blocks().map(b => b.id));

    const before: Record<string, CropRegion | null> = {};
    const after: Record<string, CropRegion | null> = {};
    const toRestore: string[] = [];
    for (const page of targetPages) {
      const region = regions.get(page)!;
      before[String(page)] = { rect: { ...region.rect }, deletedBlockIds: [...region.deletedBlockIds] };
      after[String(page)] = null;
      for (const id of region.deletedBlockIds) {
        if (existingIds.has(id)) toRestore.push(id);
      }
    }

    const next = new Map(regions);
    for (const page of targetPages) next.delete(page);
    this.cropRegions.set(next);

    this.toggleDeletedBlocks(toRestore, false);

    this.pushHistory({
      type: 'cropClear',
      blockIds: [...toRestore],
      selectionBefore,
      selectionAfter: [...this.selectedBlockIds()],
      cropPagesBefore: before,
      cropPagesAfter: after,
      cropBlockIdsToggled: [...toRestore],
    });

    this.markChanged();
  }

  /** Replay a crop action's region record onto cropRegions (null = delete entry). */
  private setCropRegionsFromRecord(pages: Record<string, CropRegion | null>): void {
    const regions = new Map(this.cropRegions());
    for (const [pageStr, region] of Object.entries(pages)) {
      const page = Number(pageStr);
      if (region === null) {
        regions.delete(page);
      } else {
        regions.set(page, { rect: { ...region.rect }, deletedBlockIds: [...region.deletedBlockIds] });
      }
    }
    this.cropRegions.set(regions);
  }

  /** Add or remove a set of block IDs from the deleted set. */
  private toggleDeletedBlocks(ids: string[], deleted: boolean): void {
    if (ids.length === 0) return;
    const set = new Set(this.deletedBlockIds());
    if (deleted) ids.forEach(id => set.add(id));
    else ids.forEach(id => set.delete(id));
    this.deletedBlockIds.set(set);
  }

  // Paragraph break methods
  setParagraphBreaks(breaks: Set<string>, addToHistory: boolean = true): void {
    if (addToHistory) {
      this.pushHistory({
        type: 'paragraphBreak',
        blockIds: [],
        selectionBefore: [...this.selectedBlockIds()],
        selectionAfter: [...this.selectedBlockIds()],
        paragraphBreaksBefore: [...this.paragraphBreaks()],
        paragraphBreaksAfter: [...breaks],
      });
    }
    this.paragraphBreaks.set(new Set(breaks));
    this.markChanged();
  }

  toggleParagraphBreak(blockId: string): void {
    const before = this.paragraphBreaks();
    const after = new Set(before);
    if (after.has(blockId)) {
      after.delete(blockId);
    } else {
      after.add(blockId);
    }
    this.pushHistory({
      type: 'paragraphBreak',
      blockIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      paragraphBreaksBefore: [...before],
      paragraphBreaksAfter: [...after],
    });
    this.paragraphBreaks.set(after);
    this.markChanged();
  }

  clearParagraphBreaks(): void {
    if (this.paragraphBreaks().size === 0) return;
    this.pushHistory({
      type: 'paragraphBreak',
      blockIds: [],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      paragraphBreaksBefore: [...this.paragraphBreaks()],
      paragraphBreaksAfter: [],
    });
    this.paragraphBreaks.set(new Set());
    this.markChanged();
  }

  // Category correction methods
  setCategoryCorrection(blockId: string, categoryId: string): void {
    const before = [...this.categoryCorrections().entries()] as [string, string][];

    // Capture block's current category_id before the correction
    const block = this.blocks().find(b => b.id === blockId);
    const blockCategoryBefore = block?.category_id;

    this.categoryCorrections.update(map => {
      const newMap = new Map(map);
      newMap.set(blockId, categoryId);
      return newMap;
    });
    const after = [...this.categoryCorrections().entries()] as [string, string][];

    // Update the block's category_id directly
    this.blocks.update(blocks =>
      blocks.map(b => b.id === blockId ? { ...b, category_id: categoryId } : b)
    );

    this.pushHistory({
      type: 'categoryCorrection',
      blockIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      categoryCorrectionsBefore: before,
      categoryCorrectionsAfter: after,
      blockCategoryBefore,
      blockCategoryAfter: categoryId,
    });
    this.markChanged();
    this.updateCategoryStats();
  }

  setBulkCategoryCorrections(entries: Array<{ blockId: string; categoryId: string }>): void {
    const before = [...this.categoryCorrections().entries()] as [string, string][];

    // Capture each block's current category_id
    const blocksById = new Map(this.blocks().map(b => [b.id, b]));
    const blockCategoriesBefore = new Map<string, string>();
    for (const { blockId } of entries) {
      const block = blocksById.get(blockId);
      if (block) blockCategoriesBefore.set(blockId, block.category_id);
    }

    // Apply corrections to the map
    this.categoryCorrections.update(map => {
      const newMap = new Map(map);
      for (const { blockId, categoryId } of entries) {
        newMap.set(blockId, categoryId);
      }
      return newMap;
    });
    const after = [...this.categoryCorrections().entries()] as [string, string][];

    // Update block category_ids
    const entryMap = new Map(entries.map(e => [e.blockId, e.categoryId]));
    this.blocks.update(blocks =>
      blocks.map(b => entryMap.has(b.id) ? { ...b, category_id: entryMap.get(b.id)! } : b)
    );

    this.pushHistory({
      type: 'categoryCorrection',
      blockIds: entries.map(e => e.blockId),
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      categoryCorrectionsBefore: before,
      categoryCorrectionsAfter: after,
      bulkBlockCategoriesBefore: [...blockCategoriesBefore.entries()],
      bulkBlockCategoriesAfter: entries.map(e => [e.blockId, e.categoryId] as [string, string]),
    });
    this.markChanged();
    this.updateCategoryStats();
  }

  clearCategoryCorrection(blockId: string): void {
    if (!this.categoryCorrections().has(blockId)) return;
    const before = [...this.categoryCorrections().entries()] as [string, string][];

    // Capture block's current category_id before clearing
    const block = this.blocks().find(b => b.id === blockId);
    const blockCategoryBefore = block?.category_id;

    this.categoryCorrections.update(map => {
      const newMap = new Map(map);
      newMap.delete(blockId);
      return newMap;
    });
    const after = [...this.categoryCorrections().entries()] as [string, string][];

    this.pushHistory({
      type: 'categoryCorrection',
      blockIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      categoryCorrectionsBefore: before,
      categoryCorrectionsAfter: after,
      blockCategoryBefore,
    });
    this.markChanged();
    this.updateCategoryStats();
  }

  clearAllCategoryCorrections(): void {
    if (this.categoryCorrections().size === 0) return;
    const before = [...this.categoryCorrections().entries()] as [string, string][];
    this.categoryCorrections.set(new Map());
    this.pushHistory({
      type: 'categoryCorrection',
      blockIds: [],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()],
      categoryCorrectionsBefore: before,
      categoryCorrectionsAfter: [],
    });
    this.markChanged();
  }

  // Classification threshold methods
  updateThreshold(path: string, value: number): void {
    const current = this.classificationThresholds();
    const updated = JSON.parse(JSON.stringify(current)) as ClassificationThresholds;
    const parts = path.split('.');
    if (parts.length === 2) {
      (updated as any)[parts[0]][parts[1]] = value;
    }
    this.classificationThresholds.set(updated);
    this.markChanged();
  }

  resetThresholdsToDefault(): void {
    this.classificationThresholds.set(getDefaultThresholds());
    this.markChanged();
  }

  /**
   * Apply all category corrections to blocks.
   * Called after loading a project to sync block category_ids with the corrections map.
   * Blocks are re-analyzed from the PDF and have their original category_ids,
   * so corrections must be re-applied.
   */
  applyCategoryCorrections(): void {
    const learned = this.learnedCategories();
    const corrections = this.categoryCorrections();
    if (learned.size === 0 && corrections.size === 0) return;

    // Merge: learned first, then explicit corrections override
    const merged = new Map(learned);
    for (const [blockId, catId] of corrections) {
      merged.set(blockId, catId);
    }

    let applied = 0;
    this.blocks.update(blocks =>
      blocks.map(b => {
        const newCat = merged.get(b.id);
        if (newCat) {
          if (b.category_id !== newCat) applied++;
          return { ...b, category_id: newCat };
        }
        return b;
      })
    );
    console.log('[applyCategoryCorrections] learned:', learned.size,
      'explicit:', corrections.size, 'applied:', applied);
  }

  pushSelectionHistory(selectionBefore: string[], selectionAfter: string[]): void {
    this.pushHistory({
      type: 'selection',
      blockIds: [],
      selectionBefore,
      selectionAfter
    });
  }

  // Cap so long sessions don't grow saves unboundedly — split/merge actions
  // embed full block payloads and history is serialized into the project file
  private static readonly MAX_HISTORY = 200;

  private pushHistory(action: HistoryAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > PdfEditorStateService.MAX_HISTORY) {
      this.undoStack.splice(0, this.undoStack.length - PdfEditorStateService.MAX_HISTORY);
    }
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

  resetPageOrder(): void {
    this.pageOrder.set([]);
    this.markChanged();
  }

  // Change tracking.
  // changeCounter is a monotonic count of change events — savers snapshot it
  // before serializing and only clear the dirty flag if no edit happened
  // while the save IPC was in flight.
  private changeCounter = 0;

  changeGeneration(): number {
    return this.changeCounter;
  }

  markChanged(): void {
    this.changeCounter++;
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

  // Permanently remove blocks from the document (not undoable)
  removeBlocks(blockIds: string[]): void {
    if (blockIds.length === 0) return;
    const idsToRemove = new Set(blockIds);
    this.blocks.update(existing => existing.filter(b => !idsToRemove.has(b.id)));
    // Also clean up any deleted references to these blocks
    this.deletedBlockIds.update(deleted => {
      const updated = new Set(deleted);
      for (const id of blockIds) updated.delete(id);
      return updated;
    });
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

  // Update category stats (block_count, char_count).
  // Empty categories are kept (counts zeroed) — deleting them breaks undo,
  // which can restore blocks into a category that no longer has a definition.
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

      for (const [catId, cat] of Object.entries(cats)) {
        const catStats = stats.get(catId);
        updated[catId] = {
          ...cat,
          block_count: catStats?.block_count ?? 0,
          char_count: catStats?.char_count ?? 0
        };
      }

      return updated;
    });
  }
}

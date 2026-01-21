import { Injectable, signal, computed } from '@angular/core';
import {
  EpubHighlight,
  EpubCategory,
  EpubCategoryHighlights,
  EpubHistoryAction,
  getEpubHighlightId,
  serializeCategoryHighlights,
  deserializeCategoryHighlights,
  SerializedCategoryHighlights,
} from '../../../core/models/epub-highlight.types';
import { BookMetadata, EpubChapter } from '../../../core/models/book-metadata.types';

/**
 * EpubEditorStateService - Manages all editor state for an EPUB document
 *
 * Mirrors the PdfEditorStateService pattern but adapted for EPUB/CFI-based editing.
 *
 * This service holds:
 * - Document metadata
 * - Category highlights
 * - Selection state
 * - Deletion state
 * - Undo/redo history
 */
@Injectable({
  providedIn: 'root'
})
export class EpubEditorStateService {
  // Core document state
  readonly epubPath = signal('');
  readonly epubName = signal('');
  readonly libraryPath = signal('');
  readonly fileHash = signal('');
  readonly epubLoaded = signal(false);

  // Metadata
  readonly title = signal('');
  readonly author = signal('');
  readonly coverUrl = signal<string | null>(null);

  // Chapter info
  readonly totalChapters = signal(0);
  readonly currentChapterId = signal<string | null>(null);

  // Categories and highlights
  readonly categories = signal<Record<string, EpubCategory>>({});
  readonly categoryHighlights = signal<EpubCategoryHighlights>(new Map());

  // Selection and deletion state
  readonly deletedHighlightIds = signal<Set<string>>(new Set());
  readonly selectedHighlightIds = signal<string[]>([]);

  // Block-based deletion state (new system)
  readonly deletedBlockIds = signal<Set<string>>(new Set());
  readonly selectedBlockIds = signal<string[]>([]);

  // Chapter markers for export
  readonly chapters = signal<EpubChapter[]>([]);
  readonly chaptersSource = signal<'toc' | 'heuristic' | 'manual' | 'mixed'>('manual');
  readonly selectedChapterId = signal<string | null>(null);

  // Book metadata for export
  readonly metadata = signal<BookMetadata>({});

  // Undo/redo state
  private undoStack: EpubHistoryAction[] = [];
  private redoStack: EpubHistoryAction[] = [];
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  // Change tracking
  readonly hasUnsavedChanges = signal(false);

  /**
   * Get the effective path for file operations.
   */
  readonly effectivePath = computed(() => this.libraryPath() || this.epubPath());

  /**
   * Categories as a sorted array
   */
  readonly categoriesArray = computed(() => {
    return Object.values(this.categories()).sort((a, b) => b.charCount - a.charCount);
  });

  /**
   * Total included characters (non-deleted highlights)
   */
  readonly includedChars = computed(() => {
    const deleted = this.deletedHighlightIds();
    let total = 0;

    this.categoryHighlights().forEach((chapterMap, categoryId) => {
      chapterMap.forEach((highlights, chapterId) => {
        for (const highlight of highlights) {
          const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
          if (!deleted.has(id)) {
            total += highlight.text.length;
          }
        }
      });
    });

    return total;
  });

  /**
   * Total excluded characters (deleted highlights)
   */
  readonly excludedChars = computed(() => {
    const deleted = this.deletedHighlightIds();
    let total = 0;

    this.categoryHighlights().forEach((chapterMap, categoryId) => {
      chapterMap.forEach((highlights, chapterId) => {
        for (const highlight of highlights) {
          const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
          if (deleted.has(id)) {
            total += highlight.text.length;
          }
        }
      });
    });

    return total;
  });

  /**
   * Get highlights for a specific chapter
   */
  getHighlightsForChapter(chapterId: string): Map<string, EpubHighlight[]> {
    const result = new Map<string, EpubHighlight[]>();

    this.categoryHighlights().forEach((chapterMap, categoryId) => {
      const highlights = chapterMap.get(chapterId);
      if (highlights && highlights.length > 0) {
        result.set(categoryId, highlights);
      }
    });

    return result;
  }

  /**
   * Get all highlights for a category across all chapters
   */
  getHighlightsForCategory(categoryId: string): EpubHighlight[] {
    const chapterMap = this.categoryHighlights().get(categoryId);
    if (!chapterMap) return [];

    const allHighlights: EpubHighlight[] = [];
    chapterMap.forEach(highlights => {
      allHighlights.push(...highlights);
    });

    return allHighlights;
  }

  /**
   * Check if a highlight is deleted
   */
  isHighlightDeleted(categoryId: string, chapterId: string, cfi: string): boolean {
    const id = getEpubHighlightId(categoryId, chapterId, cfi);
    return this.deletedHighlightIds().has(id);
  }

  /**
   * Check if a highlight is selected
   */
  isHighlightSelected(categoryId: string, chapterId: string, cfi: string): boolean {
    const id = getEpubHighlightId(categoryId, chapterId, cfi);
    return this.selectedHighlightIds().includes(id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Load/Reset Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Load document data
   */
  loadDocument(data: {
    epubPath: string;
    epubName: string;
    libraryPath?: string;
    fileHash?: string;
    title: string;
    author: string;
    coverUrl?: string | null;
    totalChapters: number;
    categories?: Record<string, EpubCategory>;
    categoryHighlights?: EpubCategoryHighlights | SerializedCategoryHighlights;
    deletedHighlightIds?: Set<string> | string[];
    deletedBlockIds?: Set<string> | string[];
    chapters?: EpubChapter[];
    chaptersSource?: 'toc' | 'heuristic' | 'manual' | 'mixed';
    metadata?: BookMetadata;
  }): void {
    this.epubPath.set(data.epubPath);
    this.epubName.set(data.epubName);
    this.libraryPath.set(data.libraryPath || data.epubPath);
    this.fileHash.set(data.fileHash || '');
    this.title.set(data.title);
    this.author.set(data.author);
    this.coverUrl.set(data.coverUrl || null);
    this.totalChapters.set(data.totalChapters);
    this.categories.set(data.categories || {});

    // Handle category highlights (could be Map or serialized object)
    if (data.categoryHighlights) {
      if (data.categoryHighlights instanceof Map) {
        this.categoryHighlights.set(data.categoryHighlights);
      } else {
        this.categoryHighlights.set(deserializeCategoryHighlights(data.categoryHighlights));
      }
    } else {
      this.categoryHighlights.set(new Map());
    }

    // Handle deleted highlight IDs (could be Set or array)
    if (data.deletedHighlightIds) {
      if (data.deletedHighlightIds instanceof Set) {
        this.deletedHighlightIds.set(data.deletedHighlightIds);
      } else {
        this.deletedHighlightIds.set(new Set(data.deletedHighlightIds));
      }
    } else {
      this.deletedHighlightIds.set(new Set());
    }

    this.selectedHighlightIds.set([]);

    // Handle deleted block IDs (could be Set or array)
    if (data.deletedBlockIds) {
      if (data.deletedBlockIds instanceof Set) {
        this.deletedBlockIds.set(data.deletedBlockIds);
      } else {
        this.deletedBlockIds.set(new Set(data.deletedBlockIds));
      }
    } else {
      this.deletedBlockIds.set(new Set());
    }
    this.selectedBlockIds.set([]);

    // Handle chapters
    this.chapters.set(data.chapters || []);
    this.chaptersSource.set(data.chaptersSource || 'manual');
    this.selectedChapterId.set(null);

    // Handle metadata (initialize from EPUB metadata if not provided)
    this.metadata.set(data.metadata || {
      title: data.title,
      author: data.author,
    });

    this.currentChapterId.set(null);
    this.epubLoaded.set(true);

    // Clear history on new document load
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.epubPath.set('');
    this.epubName.set('');
    this.libraryPath.set('');
    this.fileHash.set('');
    this.title.set('');
    this.author.set('');
    this.coverUrl.set(null);
    this.totalChapters.set(0);
    this.currentChapterId.set(null);
    this.categories.set({});
    this.categoryHighlights.set(new Map());
    this.deletedHighlightIds.set(new Set());
    this.selectedHighlightIds.set([]);
    this.deletedBlockIds.set(new Set());
    this.selectedBlockIds.set([]);
    this.chapters.set([]);
    this.chaptersSource.set('manual');
    this.selectedChapterId.set(null);
    this.metadata.set({});
    this.epubLoaded.set(false);
    this.clearHistory();
    this.hasUnsavedChanges.set(false);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Category Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add or update a category
   */
  addCategory(category: EpubCategory): void {
    this.categories.update(cats => ({
      ...cats,
      [category.id]: category
    }));
    this.markChanged();
  }

  /**
   * Remove a category and its highlights
   */
  removeCategory(categoryId: string): void {
    // Store for undo
    const category = this.categories()[categoryId];
    if (!category) return;

    // Remove from categories
    this.categories.update(cats => {
      const { [categoryId]: removed, ...rest } = cats;
      return rest;
    });

    // Remove highlights
    this.categoryHighlights.update(map => {
      const newMap = new Map(map);
      newMap.delete(categoryId);
      return newMap;
    });

    // Remove from deleted set (no need to track deleted highlights for removed category)
    this.deletedHighlightIds.update(set => {
      const newSet = new Set(set);
      for (const id of set) {
        if (id.startsWith(categoryId + ':')) {
          newSet.delete(id);
        }
      }
      return newSet;
    });

    this.markChanged();
  }

  /**
   * Add highlights for a category
   */
  addHighlights(categoryId: string, highlights: EpubHighlight[]): void {
    this.categoryHighlights.update(map => {
      const newMap = new Map(map);
      const existing = newMap.get(categoryId) || new Map<string, EpubHighlight[]>();

      for (const highlight of highlights) {
        const chapterId = highlight.chapterId;
        const chapterHighlights = existing.get(chapterId) || [];
        chapterHighlights.push(highlight);
        existing.set(chapterId, chapterHighlights);
      }

      newMap.set(categoryId, existing);
      return newMap;
    });

    // Update category stats
    this.updateCategoryStats(categoryId);
    this.markChanged();
  }

  /**
   * Update category statistics
   */
  updateCategoryStats(categoryId: string): void {
    const chapterMap = this.categoryHighlights().get(categoryId);
    if (!chapterMap) return;

    let highlightCount = 0;
    let charCount = 0;

    chapterMap.forEach(highlights => {
      highlightCount += highlights.length;
      charCount += highlights.reduce((sum, h) => sum + h.text.length, 0);
    });

    this.categories.update(cats => {
      const category = cats[categoryId];
      if (!category) return cats;
      return {
        ...cats,
        [categoryId]: { ...category, highlightCount, charCount }
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Selection Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Select a highlight
   */
  selectHighlight(highlightId: string, addToSelection: boolean = false): void {
    if (addToSelection) {
      const current = this.selectedHighlightIds();
      if (current.includes(highlightId)) {
        this.selectedHighlightIds.set(current.filter(id => id !== highlightId));
      } else {
        this.selectedHighlightIds.set([...current, highlightId]);
      }
    } else {
      this.selectedHighlightIds.set([highlightId]);
    }
  }

  /**
   * Select multiple highlights
   */
  selectHighlights(highlightIds: string[], addToSelection: boolean = false): void {
    if (addToSelection) {
      const current = new Set(this.selectedHighlightIds());
      highlightIds.forEach(id => current.add(id));
      this.selectedHighlightIds.set(Array.from(current));
    } else {
      this.selectedHighlightIds.set(highlightIds);
    }
  }

  /**
   * Clear selection
   */
  clearSelection(): void {
    this.selectedHighlightIds.set([]);
  }

  /**
   * Select all highlights in a category
   */
  selectAllInCategory(categoryId: string): void {
    const deleted = this.deletedHighlightIds();
    const chapterMap = this.categoryHighlights().get(categoryId);
    if (!chapterMap) return;

    const ids: string[] = [];
    chapterMap.forEach((highlights, chapterId) => {
      for (const highlight of highlights) {
        const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
        if (!deleted.has(id)) {
          ids.push(id);
        }
      }
    });

    this.selectedHighlightIds.set(ids);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Deletion Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Delete highlights by IDs
   */
  deleteHighlights(highlightIds: string[]): void {
    if (highlightIds.length === 0) return;

    const selectionBefore = [...this.selectedHighlightIds()];
    const deleted = new Set(this.deletedHighlightIds());
    highlightIds.forEach(id => deleted.add(id));
    this.deletedHighlightIds.set(deleted);

    // Clear selection of deleted highlights
    this.selectedHighlightIds.set(
      this.selectedHighlightIds().filter(id => !highlightIds.includes(id))
    );

    // Push to undo stack
    this.pushHistory({
      type: 'delete',
      highlightIds: [...highlightIds],
      selectionBefore,
      selectionAfter: [...this.selectedHighlightIds()]
    });

    this.markChanged();
  }

  /**
   * Delete selected highlights
   */
  deleteSelectedHighlights(): void {
    this.deleteHighlights(this.selectedHighlightIds());
  }

  /**
   * Restore highlights by IDs
   */
  restoreHighlights(highlightIds: string[]): void {
    if (highlightIds.length === 0) return;

    const selectionBefore = [...this.selectedHighlightIds()];
    const deleted = new Set(this.deletedHighlightIds());
    highlightIds.forEach(id => deleted.delete(id));
    this.deletedHighlightIds.set(deleted);

    // Push to undo stack
    this.pushHistory({
      type: 'restore',
      highlightIds: [...highlightIds],
      selectionBefore,
      selectionAfter: [...this.selectedHighlightIds()]
    });

    this.markChanged();
  }

  /**
   * Toggle deletion of a highlight
   */
  toggleHighlightDeletion(highlightId: string): void {
    const deleted = this.deletedHighlightIds();
    if (deleted.has(highlightId)) {
      this.restoreHighlights([highlightId]);
    } else {
      this.deleteHighlights([highlightId]);
    }
  }

  /**
   * Delete all highlights in a category
   */
  deleteCategory(categoryId: string): void {
    const chapterMap = this.categoryHighlights().get(categoryId);
    if (!chapterMap) return;

    const ids: string[] = [];
    chapterMap.forEach((highlights, chapterId) => {
      for (const highlight of highlights) {
        ids.push(getEpubHighlightId(categoryId, chapterId, highlight.cfi));
      }
    });

    this.deleteHighlights(ids);
  }

  /**
   * Restore all highlights in a category
   */
  restoreCategory(categoryId: string): void {
    const chapterMap = this.categoryHighlights().get(categoryId);
    if (!chapterMap) return;

    const ids: string[] = [];
    chapterMap.forEach((highlights, chapterId) => {
      for (const highlight of highlights) {
        ids.push(getEpubHighlightId(categoryId, chapterId, highlight.cfi));
      }
    });

    this.restoreHighlights(ids);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Block-Based Deletion Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Toggle deletion state of a block
   */
  toggleBlockDeletion(blockId: string): void {
    const deleted = new Set(this.deletedBlockIds());
    const wasDeleted = deleted.has(blockId);

    if (wasDeleted) {
      deleted.delete(blockId);
    } else {
      deleted.add(blockId);
    }

    this.deletedBlockIds.set(deleted);

    // Push to undo stack
    this.pushHistory({
      type: wasDeleted ? 'restore' : 'delete',
      highlightIds: [blockId],
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()]
    });

    this.markChanged();
  }

  /**
   * Delete multiple blocks
   */
  deleteBlocks(blockIds: string[]): void {
    if (blockIds.length === 0) return;

    const deleted = new Set(this.deletedBlockIds());
    blockIds.forEach(id => deleted.add(id));
    this.deletedBlockIds.set(deleted);

    this.pushHistory({
      type: 'delete',
      highlightIds: blockIds,
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: []
    });

    this.selectedBlockIds.set([]);
    this.markChanged();
  }

  /**
   * Restore multiple blocks
   */
  restoreBlocks(blockIds: string[]): void {
    if (blockIds.length === 0) return;

    const deleted = new Set(this.deletedBlockIds());
    blockIds.forEach(id => deleted.delete(id));
    this.deletedBlockIds.set(deleted);

    this.pushHistory({
      type: 'restore',
      highlightIds: blockIds,
      selectionBefore: [...this.selectedBlockIds()],
      selectionAfter: [...this.selectedBlockIds()]
    });

    this.markChanged();
  }

  /**
   * Check if a block is deleted
   */
  isBlockDeleted(blockId: string): boolean {
    return this.deletedBlockIds().has(blockId);
  }

  /**
   * Select a block
   */
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

  /**
   * Clear block selection
   */
  clearBlockSelection(): void {
    this.selectedBlockIds.set([]);
  }

  /**
   * Delete selected blocks
   */
  deleteSelectedBlocks(): void {
    this.deleteBlocks(this.selectedBlockIds());
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a chapter marker
   */
  addChapter(chapter: EpubChapter): void {
    this.chapters.update(chapters => {
      const newChapters = [...chapters, chapter];
      // Sort by section index, then by y position
      return newChapters.sort((a, b) => {
        if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
        return (a.y || 0) - (b.y || 0);
      });
    });
    this.selectedChapterId.set(chapter.id);
    this.updateChaptersSource();
    this.markChanged();
  }

  /**
   * Remove a chapter marker
   */
  removeChapter(chapterId: string): void {
    this.chapters.update(chapters => chapters.filter(c => c.id !== chapterId));
    if (this.selectedChapterId() === chapterId) {
      this.selectedChapterId.set(null);
    }
    this.updateChaptersSource();
    this.markChanged();
  }

  /**
   * Rename a chapter
   */
  renameChapter(chapterId: string, newTitle: string): void {
    this.chapters.update(chapters =>
      chapters.map(c => c.id === chapterId ? { ...c, title: newTitle } : c)
    );
    this.markChanged();
  }

  /**
   * Update chapter position (for dragging)
   */
  updateChapterPosition(chapterId: string, sectionIndex: number, sectionHref: string, y: number, blockId?: string, blockText?: string): void {
    this.chapters.update(chapters => {
      const updated = chapters.map(c => {
        if (c.id === chapterId) {
          const updatedChapter = { ...c, sectionIndex, sectionHref, y, blockId };
          // Optionally update title if snapped to a new block (only for manually named chapters)
          if (blockText && c.source === 'manual') {
            updatedChapter.title = blockText.length > 80 ? blockText.substring(0, 77) + '...' : blockText;
          }
          return updatedChapter;
        }
        return c;
      });
      // Re-sort after update
      return updated.sort((a, b) => {
        if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
        return (a.y || 0) - (b.y || 0);
      });
    });
    this.markChanged();
  }

  /**
   * Clear all chapters
   */
  clearChapters(): void {
    this.chapters.set([]);
    this.selectedChapterId.set(null);
    this.chaptersSource.set('manual');
    this.markChanged();
  }

  /**
   * Set chapters from TOC or detection
   */
  setChapters(chapters: EpubChapter[], source: 'toc' | 'heuristic' | 'manual'): void {
    this.chapters.set(chapters);
    this.chaptersSource.set(source);
    this.markChanged();
  }

  /**
   * Update chapters source based on current chapters
   */
  private updateChaptersSource(): void {
    const chapters = this.chapters();
    if (chapters.length === 0) {
      this.chaptersSource.set('manual');
      return;
    }

    const sources = new Set(chapters.map(c => c.source));
    if (sources.size === 1) {
      const firstSource = sources.values().next().value;
      this.chaptersSource.set(firstSource ?? 'manual');
    } else {
      this.chaptersSource.set('mixed');
    }
  }

  /**
   * Update book metadata
   */
  updateMetadata(metadata: BookMetadata): void {
    this.metadata.set(metadata);
    this.markChanged();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Undo/Redo Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Undo last action
   */
  undo(): EpubHistoryAction | undefined {
    const action = this.undoStack.pop();
    if (!action) return undefined;

    if (action.type === 'delete') {
      // Reverse deletion - restore blocks
      const deleted = new Set(this.deletedBlockIds());
      action.highlightIds.forEach(id => deleted.delete(id));
      this.deletedBlockIds.set(deleted);
    } else if (action.type === 'restore') {
      // Reverse restoration - delete blocks
      const deleted = new Set(this.deletedBlockIds());
      action.highlightIds.forEach(id => deleted.add(id));
      this.deletedBlockIds.set(deleted);
    }

    // Restore selection
    this.selectedBlockIds.set(action.selectionBefore);

    // Push to redo stack
    this.redoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();

    return action;
  }

  /**
   * Redo last undone action
   */
  redo(): EpubHistoryAction | undefined {
    const action = this.redoStack.pop();
    if (!action) return undefined;

    if (action.type === 'delete') {
      // Re-apply deletion
      const deleted = new Set(this.deletedBlockIds());
      action.highlightIds.forEach(id => deleted.add(id));
      this.deletedBlockIds.set(deleted);
    } else if (action.type === 'restore') {
      // Re-apply restoration
      const deleted = new Set(this.deletedBlockIds());
      action.highlightIds.forEach(id => deleted.delete(id));
      this.deletedBlockIds.set(deleted);
    }

    // Restore selection
    this.selectedBlockIds.set(action.selectionAfter);

    // Push to undo stack
    this.undoStack.push(action);
    this.updateHistorySignals();
    this.markChanged();

    return action;
  }

  private pushHistory(action: EpubHistoryAction): void {
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

  /**
   * Get history for serialization
   */
  getHistory(): { undoStack: EpubHistoryAction[]; redoStack: EpubHistoryAction[] } {
    return {
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack]
    };
  }

  /**
   * Restore history from serialization
   */
  setHistory(history: { undoStack: EpubHistoryAction[]; redoStack: EpubHistoryAction[] }): void {
    this.undoStack = [...history.undoStack];
    this.redoStack = [...history.redoStack];
    this.updateHistorySignals();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mark document as changed
   */
  markChanged(): void {
    this.hasUnsavedChanges.set(true);
  }

  /**
   * Mark document as saved
   */
  markSaved(): void {
    this.hasUnsavedChanges.set(false);
  }

  /**
   * Get serializable project data
   */
  getProjectData(): {
    epubPath: string;
    epubName: string;
    libraryPath: string;
    fileHash: string;
    categories: Record<string, EpubCategory>;
    categoryHighlights: SerializedCategoryHighlights;
    deletedHighlightIds: string[];
    deletedBlockIds: string[];
    chapters: EpubChapter[];
    chaptersSource: 'toc' | 'heuristic' | 'manual' | 'mixed';
    metadata: BookMetadata;
    undoStack: EpubHistoryAction[];
    redoStack: EpubHistoryAction[];
  } {
    return {
      epubPath: this.epubPath(),
      epubName: this.epubName(),
      libraryPath: this.libraryPath(),
      fileHash: this.fileHash(),
      categories: this.categories(),
      categoryHighlights: serializeCategoryHighlights(this.categoryHighlights()),
      deletedHighlightIds: Array.from(this.deletedHighlightIds()),
      deletedBlockIds: Array.from(this.deletedBlockIds()),
      chapters: this.chapters(),
      chaptersSource: this.chaptersSource(),
      metadata: this.metadata(),
      undoStack: this.undoStack,
      redoStack: this.redoStack,
    };
  }
}

/**
 * EPUB Highlight Types
 *
 * Analogous to MatchRect for PDFs, but using CFI (Canonical Fragment Identifiers)
 * instead of pixel coordinates for precise text location tracking.
 *
 * CFI format: epubcfi(/6/4!/4/2/1:0,/4/2/1:10) - identifies a range within an EPUB
 */

/**
 * Represents a highlighted/matched region in an EPUB.
 * Uses CFI strings for location instead of pixel coordinates.
 */
export interface EpubHighlight {
  /** EPUB CFI string - unique identifier for the text location */
  cfi: string;
  /** Spine item ID (chapter identifier) for grouping */
  chapterId: string;
  /** The matched text content */
  text: string;
  /** Surrounding context for display/verification */
  excerpt?: string;
  /** Character offset within the chapter (alternative location method) */
  charOffset?: number;
  /** Character length of the match */
  charLength?: number;
}

/**
 * Storage structure for EPUB category highlights.
 * Outer map: categoryId -> chapter highlights
 * Inner map: chapterId -> array of highlights
 */
export type EpubCategoryHighlights = Map<string, Map<string, EpubHighlight[]>>;

/**
 * Generate a unique highlight ID from its components.
 * Format: "categoryId:chapterId:cfi_hash"
 */
export function getEpubHighlightId(categoryId: string, chapterId: string, cfi: string): string {
  // Use a simple hash of the CFI to keep IDs manageable
  const cfiHash = hashCfi(cfi);
  return `${categoryId}:${chapterId}:${cfiHash}`;
}

/**
 * Parse a highlight ID back into its components.
 */
export function parseEpubHighlightId(highlightId: string): {
  categoryId: string;
  chapterId: string;
  cfiHash: string;
} | null {
  const parts = highlightId.split(':');
  if (parts.length < 3) return null;
  return {
    categoryId: parts[0],
    chapterId: parts[1],
    cfiHash: parts.slice(2).join(':'), // CFI hash might contain colons
  };
}

/**
 * Simple hash function for CFI strings.
 * Creates a short, consistent identifier from a CFI.
 */
function hashCfi(cfi: string): string {
  let hash = 0;
  for (let i = 0; i < cfi.length; i++) {
    const char = cfi.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to base36 for shorter string
  return Math.abs(hash).toString(36);
}

/**
 * Category definition for EPUB editor (similar to PDF Category)
 */
export interface EpubCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Type of category: built-in or custom (user-created) */
  type: 'builtin' | 'custom';
  /** Pattern used to match text (regex or sample-based) */
  pattern?: string;
  /** Whether this category is enabled for deletion/export */
  enabled: boolean;
  /** Number of highlights in this category */
  highlightCount: number;
  /** Total character count of highlights */
  charCount: number;
}

/**
 * EPUB editor project data (for saving/loading)
 */
export interface EpubEditorProject {
  version: number;
  /** Original EPUB path */
  sourcePath: string;
  /** Original filename */
  sourceName: string;
  /** Library path (if imported to library) */
  libraryPath?: string;
  /** SHA256 hash for deduplication */
  fileHash?: string;
  /** IDs of deleted highlights */
  deletedHighlightIds: string[];
  /** Custom categories created by user */
  customCategories: EpubCategory[];
  /** Category highlights (serialized) */
  categoryHighlights: SerializedCategoryHighlights;
  /** Undo/redo stacks */
  undoStack?: EpubHistoryAction[];
  redoStack?: EpubHistoryAction[];
  createdAt: string;
  modifiedAt: string;
}

/**
 * Serializable version of category highlights (Maps don't serialize to JSON)
 */
export interface SerializedCategoryHighlights {
  [categoryId: string]: {
    [chapterId: string]: EpubHighlight[];
  };
}

/**
 * Convert EpubCategoryHighlights to serializable format
 */
export function serializeCategoryHighlights(highlights: EpubCategoryHighlights): SerializedCategoryHighlights {
  const result: SerializedCategoryHighlights = {};
  highlights.forEach((chapterMap, categoryId) => {
    result[categoryId] = {};
    chapterMap.forEach((highlightArray, chapterId) => {
      result[categoryId][chapterId] = highlightArray;
    });
  });
  return result;
}

/**
 * Convert serialized highlights back to Map structure
 */
export function deserializeCategoryHighlights(serialized: SerializedCategoryHighlights): EpubCategoryHighlights {
  const result: EpubCategoryHighlights = new Map();
  for (const categoryId of Object.keys(serialized)) {
    const chapterMap = new Map<string, EpubHighlight[]>();
    for (const chapterId of Object.keys(serialized[categoryId])) {
      chapterMap.set(chapterId, serialized[categoryId][chapterId]);
    }
    result.set(categoryId, chapterMap);
  }
  return result;
}

/**
 * History action for undo/redo in EPUB editor
 */
export interface EpubHistoryAction {
  type: 'delete' | 'restore' | 'addCategory' | 'removeCategory';
  /** Affected highlight IDs */
  highlightIds: string[];
  /** Selection state before action */
  selectionBefore: string[];
  /** Selection state after action */
  selectionAfter: string[];
  /** For category actions */
  categoryId?: string;
  categoryData?: EpubCategory;
}

/**
 * Search result from epub.js
 */
export interface EpubSearchResult {
  cfi: string;
  excerpt: string;
}

/**
 * Chapter info from epub.js spine
 */
export interface EpubChapterInfo {
  id: string;
  href: string;
  label: string;
  index: number;
}

/**
 * Text removal instruction for export
 */
export interface TextRemovalInstruction {
  chapterId: string;
  chapterHref: string;
  /** CFI string identifying the text to remove */
  cfi: string;
  /** Plain text to remove (for verification) */
  text: string;
  /** Character offset in the chapter content */
  startOffset: number;
  /** Character length to remove */
  length: number;
}

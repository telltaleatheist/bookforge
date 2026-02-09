/**
 * Studio Types - Unified type definitions for books and articles
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unified Item Type
// ─────────────────────────────────────────────────────────────────────────────

export type StudioItemType = 'book' | 'article';
export type StudioItemStatus = 'draft' | 'ready' | 'processing' | 'completed' | 'error';

/**
 * Edit action for undo/redo (articles only)
 */
export interface EditAction {
  type: 'delete' | 'restore';
  selectors: string[];
  timestamp: string;
}

/**
 * Unified item type for both books and articles
 */
export interface StudioItem {
  id: string;
  type: StudioItemType;

  // Common fields
  title: string;
  author?: string;
  status: StudioItemStatus;
  createdAt: string;
  modifiedAt: string;

  // Book-specific
  epubPath?: string;
  bfpPath?: string;
  coverPath?: string;
  coverData?: string;  // Base64 cover image

  // Article-specific
  sourceUrl?: string;
  htmlPath?: string;
  deletedSelectors?: string[];
  undoStack?: EditAction[];
  redoStack?: EditAction[];
  sourceLang?: string;
  targetLang?: string;
  byline?: string;
  excerpt?: string;
  wordCount?: number;
  content?: string;      // HTML content for preview
  textContent?: string;  // Plain text content
  contentFinalized?: boolean;  // True when user finalizes content edits

  // Processing state
  hasCleaned?: boolean;
  cleanedEpubPath?: string;
  hasTranslated?: boolean;
  audiobookPath?: string;
  vttPath?: string;
  skippedChunksPath?: string;

  // Bilingual audiobook paths (separate from mono audiobook)
  bilingualAudioPath?: string;
  bilingualVttPath?: string;

  // Error message if status is 'error'
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow State
// ─────────────────────────────────────────────────────────────────────────────

export type StudioWorkflowState =
  | 'empty'      // No item selected
  | 'content'    // Article content editing (element selection)
  | 'metadata'   // Book/article metadata editing
  | 'process'    // Combined: AI cleanup → Translate → TTS
  | 'stream'     // Live TTS streaming
  | 'play'       // Play existing audiobook with VTT sync
  | 'diff'       // Review changes (after cleanup)
  | 'skipped'    // Skipped chunks review
  | 'enhance'    // Audio post-processing
  | 'chapters'   // Chapter recovery
  | 'analytics'; // Processing analytics

// Steps within the Process workflow
export type ProcessStep = 'cleanup' | 'translate' | 'tts';

// ─────────────────────────────────────────────────────────────────────────────
// Language Configuration (for articles)
// ─────────────────────────────────────────────────────────────────────────────

export interface SupportedLanguage {
  code: string;
  name: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ko', name: 'Korean' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Add Modal Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddModalMode = 'epub' | 'url';

export interface AddModalResult {
  type: StudioItemType;
  item: StudioItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Result (for URL fetching)
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchUrlResult {
  success: boolean;
  htmlPath?: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  content?: string;
  textContent?: string;
  wordCount?: number;
  error?: string;
}

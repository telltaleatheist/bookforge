/**
 * Studio Types - Unified type definitions for books and articles
 */

import type { SourceType } from '../../../core/models/manifest.types';

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
  year?: string;
  language?: string;
  status: StudioItemStatus;
  createdAt: string;
  modifiedAt: string;

  // Book-specific
  /**
   * The project's source document, ON DISK — or **null when it has none**.
   *
   * Nullable, and deliberately NOT optional, so that every construction site has to
   * state which it is and every reader has to handle the null. It used to be
   * `string | undefined` filled in by a last-resort `${projectDir}/source/original.epub`
   * — a path that was merely plausible: for 74 of 377 book projects in the measured
   * library no such file exists (no archive entry with role 'original', no
   * source/original.*). Every consumer then believed it had a document and only found
   * out on use, deep in a job or an editor window, as an ENOENT naming a file the user
   * had never seen.
   *
   * null therefore means exactly one thing: this project has no readable source
   * document. An action that needs one must be disabled or must say so — never run on
   * a synthesized path.
   */
  epubPath: string | null;
  /**
   * The pristine source document — the PDF or original EPUB as imported, before
   * any cleanup or export — or null when the project has none on disk.
   *
   * Distinct from `epubPath`, which prefers the exported EPUB. Training labels must be
   * made against what OCR will actually see in production, so label mode opens this
   * rather than a processed derivative. For the same reason it does NOT fall back to
   * `epubPath` when no pristine import survives: a derived EPUB is not what OCR saw,
   * so answering with one would defeat the field's whole purpose (and, when epubPath
   * was itself synthesized, inherited a path that did not exist).
   */
  originalSourcePath: string | null;
  /**
   * The project's own export EPUB (manifest `outputs.epub`), ON DISK — or null
   * when the user has not finalized in the editor yet.
   *
   * The export is named after the book, so `epubPath.includes('exported.epub')`
   * cannot answer "has this been exported?" any more. Nothing may infer it from
   * a filename; this field is the answer.
   */
  exportedEpubPath: string | null;
  /**
   * What the project was IMPORTED from — manifest.source.type, verbatim. This is
   * provenance, not the currently-selected file: a project imported from a scanned
   * PDF stays 'pdf' forever, even though every later stage works on the export.
   * The cleanup wizard defaults OCR repair from it (scans need it, born-digital
   * EPUBs don't).
   */
  sourceType?: SourceType;
  /** Absolute project DIRECTORY ({library}/projects/{slug}) — never a file. */
  projectDir?: string;
  coverPath?: string;
  coverRelPath?: string;  // Library-relative cover path (for on-demand full-res load in the metadata editor)
  coverData?: string;  // Base64 cover THUMBNAIL (~200px) for the list/grid — NOT full-res

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
  hasCleaned?: boolean;       // Has cleaned.epub (AI cleanup output)
  hasSimplified?: boolean;    // Has simplified.epub (AI simplify output)
  hasCleanupCheckpoint?: boolean;  // Has cleanup-progress.json (in-progress or interrupted job)
  cleanedEpubPath?: string;
  hasAnalysis?: boolean;      // Has stages/04-analysis/analysis.json
  hasTranslated?: boolean;
  translatedEpubPath?: string;
  hasTtsCache?: boolean;
  audiobookPath?: string;
  vttPath?: string;
  skippedChunksPath?: string;
  // Narration flags are INDEPENDENT, not two halves of one choice: a book can carry a
  // bought human-narrated m4b and a TTS render side by side, and it belongs under both
  // filters. Both false means the book has no audiobook at all — which is why "AI" can't
  // be expressed as "not professional".
  hasProfessionalNarration?: boolean;  // Has ≥1 audiobook variant flagged "professionally read"
  hasAiNarration?: boolean;            // Has ≥1 audiobook variant NOT flagged "professionally read"

  // Bilingual audiobook paths (separate from mono audiobook)
  // Legacy single-pair fields (still used for backward compat with hasBilingualAudio)
  bilingualAudioPath?: string;
  bilingualVttPath?: string;
  bilingualSentencePairsPath?: string;

  // All bilingual outputs keyed by language pair (e.g., "en-de", "en-es")
  bilingualOutputs?: Record<string, {
    audioPath: string;
    vttPath: string;
    sentencePairsPath?: string;
    sourceLang: string;
    targetLang: string;
  }>;

  // Metadata
  outputFilename?: string;
  contributors?: Array<{ first: string; last: string }>;

  // Organization
  tags?: string[];
  archived?: boolean;
  sortOrder?: number;
  archiveCount?: number;

  // Error message if status is 'error'
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow State - Hierarchical Navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main tabs: top-level navigation
 * Editor and Listen are buttons that open their own windows, not tabs.
 */
// Book view tabs. Internal values kept for continuity:
//   'files' = Versions tab, 'audiobook' = Process tab (unified pipeline wizard),
//   Content analysis is configured in a source-locked modal; 'analytics' = job
//   performance history (timing/throughput per stage).
//   'language-learning' is legacy/unused from the UI.
export type MainTab = 'files' | 'content' | 'audiobook' | 'language-learning' | 'analytics' | 'skipped';

/**
 * Sub-tabs under Audiobook main tab
 */
export type AudiobookSubTab = 'process' | 'stream' | 'play' | 'review' | 'skipped' | 'chapters';

/**
 * Sub-tabs under Language Learning main tab
 */
export type LanguageLearningSubTab = 'process' | 'play' | 'review';

/**
 * Legacy workflow state - kept for backwards compatibility during refactor
 * @deprecated Use MainTab + sub-tab combinations instead
 */
export type StudioWorkflowState =
  | 'empty'      // No item selected
  | 'content'    // Article content editing (element selection)
  | 'metadata'   // Book/article metadata editing
  | 'process'    // Combined: AI cleanup → Translate → TTS
  | 'stream'     // Live TTS streaming
  | 'play'       // Play existing audiobook with VTT sync
  | 'diff'       // Review changes (after cleanup)
  | 'skipped'    // Skipped chunks review
  | 'chapters'   // Chapter recovery
  | 'analytics'  // Processing analytics
  | 'bilingual'; // Bilingual sentence cache management

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

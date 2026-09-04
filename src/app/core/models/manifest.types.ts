/**
 * Unified Project Manifest Types
 *
 * Single source of truth for all project data (books and articles).
 * All paths in the manifest are stored as relative paths with forward slashes
 * and resolved at runtime using the configured library path.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

import type { NarrationDeletions, NarrationEpubOutput } from '@shared/vlm/narration-deletions';
import type { EditorLayoutIdentity } from '@shared/document/editor-layout';

export type { NarrationDeletions, NarrationEpubOutput, EditorLayoutIdentity };

export type ProjectType = 'book' | 'article';
export type SourceType = 'pdf' | 'epub' | 'url' | 'audiobook';

export type PipelineStageStatus = 'none' | 'pending' | 'processing' | 'complete' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Schema (Version 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectManifest {
  version: 2;
  projectId: string;
  projectType: ProjectType;
  createdAt: string;          // ISO timestamp
  modifiedAt: string;         // ISO timestamp

  source: ManifestSource;
  metadata: ManifestMetadata;
  chapters: ManifestChapter[];
  pipeline: ManifestPipeline;
  outputs: ManifestOutputs;

  /**
   * LEGACY LOCATION — see electron/manifest-types.ts.
   *
   * Editor state lives in `<projectDir>/editor-state.json` now, and a manifest
   * that comes back from `manifest:get` / `manifest:list` will not carry this
   * key once its project has been migrated. Renderer code must ask for editor
   * state through `projects:load-from-path` or `manifest:get-editor-state`,
   * never off a manifest object.
   */
  editor?: ManifestEditorState;

  // Organization
  archived?: boolean;          // Hidden from active lists, shown in Archived section
  sortOrder?: number;          // Manual sort order (ascending); fallback to modifiedAt

  // Archive
  archive?: ArchiveEntry[];

  /**
   * The project's WORKING CHAINS, one per archive-grade EPUB — see
   * shared/document/book-families.ts and BookFamily below. Mirrors
   * electron/manifest-types.ts, which is the writing side.
   */
  families?: BookFamily[];

  // Book variants — distinct editions/languages/formats of the SAME book in one
  // project. The primaryVariantId variant represents the project (its metadata
  // mirrors `metadata`). Separate from pipeline versions (original/exported/…).
  variants?: ProjectVariant[];
  primaryVariantId?: string;

  /**
   * WHICH version the user marked as this book's TTS file, or absent.
   *
   * MIRRORS `ttsVariantId` in electron/manifest-types.ts (the writing side).
   * At most one per book — a scalar pointer beside `primaryVariantId`, so
   * marking a second version clears the first by construction. Never set
   * automatically; absent means the user has not said.
   */
  ttsVariantId?: string;

  /**
   * Completed audiobook analyses, keyed by the stable audiobook variant id.
   * Entries are cryptographic pointers; consumers must verify them before use.
   * Document analysis remains in pipeline.analysis.
   */
  audiobookAnalyses?: Record<string, AudiobookAnalysisManifestEntry>;

  /**
   * WHICH hosted-Foundry project is this book's, or absent — see
   * FoundryProjectRef below. Absent is the ordinary state: no project yet.
   */
  foundryProject?: FoundryProjectRef;

  // `foundryExports?: FoundryExportRecord[]` was declared here from 2026-08-16
  // to 2026-08-17. Retired and deleted: an export lands as an ordinary variant
  // carrying `foundrySource`, and nothing reads the old list. See
  // electron/manifest-types.ts for the full note.
}

/**
 * The hosted Foundry project this book belongs to.
 *
 * MIRRORS `FoundryProjectRef` in electron/manifest-types.ts (the writing side);
 * keep the two in step. `dir` is the project KEY — the folder name under
 * `<libraryRoot>/foundry/projects/` — never a path, because a path names a
 * volume and stops being true when the library moves. Main joins it; the
 * renderer never does.
 */
export interface FoundryProjectRef {
  dir: string;
  /**
   * WHICH version of this book was imported into that Foundry project — the
   * parent every export from it derives from — or absent when the import named
   * no version of ours. Learned at first contact; never inferred later.
   */
  sourceVariantId?: string;
}

/**
 * WHERE a version came from, when Foundry made it.
 *
 * MIRRORS `FoundryVariantSource` in electron/manifest-types.ts (the writing
 * side); keep the two in step. Present only on variants a Foundry export landed
 * as, and cleared when the user promotes one to `archive/`.
 *
 * `projectKey` + `fileName` are the re-export identity: a landing matching both
 * replaces that variant's file in place rather than adding another version.
 * `parentVariantId` is null when the mapping records no source version, and a
 * null parent renders at top level rather than under a guessed one.
 */
export interface FoundryVariantSource {
  projectKey: string;
  fileName: string;
  parentVariantId: string | null;
  /** ISO timestamp of the landing; refreshed on re-export. */
  landedAt: string;
}

export interface AudiobookAnalysisManifestEntry {
  protocolVersion: 1;
  analysisId: string;
  variantId: string;
  reportPath: string; // project-relative canonical report path
  reportHashAlgorithm: 'sha256';
  reportSha256: string;
  m4bHashAlgorithm: 'sha256';
  m4bSha256: string;
  m4bSizeBytes: number;
  transcriptDigestAlgorithm: 'bookforge-vtt-cues-v1';
  transcriptSha256: string;
  cueCount: number;
  analyzedAt: string;
}

export type VariantKind = 'ebook' | 'audiobook';

export interface VariantMetadata {
  title?: string;
  subtitle?: string;
  author?: string;
  /** Structured authors, when the source declared them — mirrors ProjectMetadata's. */
  contributors?: Array<{ first: string; last: string }>;
  year?: string;
  language?: string;
  narrator?: string;
  series?: string;
  seriesPosition?: number;
  description?: string;
  coverPath?: string; // library-relative, e.g. "media/cover_ab12.jpg"
}

export interface ProjectVariant {
  id: string;
  kind: VariantKind;
  format: string;
  path: string;
  descriptor?: string;
  metadata: VariantMetadata;
  vttPath?: string;
  sourceFileHash?: string;
  addedAt: string;
  professionallyRead?: boolean;  // audiobook variants: user-settable "professionally read" flag
  /**
   * This version is a Foundry EXPORT, and this says which and from what.
   * Absent on every version the user added themselves — which is what makes it
   * the test for "render this nested under its parent".
   */
  foundrySource?: FoundryVariantSource;
  /**
   * THIS VERSION *WAS* A FOUNDRY EXPORT AND THE USER KEPT IT — the record that
   * survives the promotion.
   *
   * `promoteVariantToArchive` deletes `foundrySource`, deliberately: the row is
   * one of the book's own files now, it must stop drawing "Temporary — keep",
   * and it must stop being nested under a parent.
   *
   * But the export sweep builds its ALREADY-LANDED set from `foundrySource`, so
   * deleting it told the sweep that the file still sitting in Foundry's tray had
   * never been taken — and the next sweep landed it AGAIN as a second version.
   * Owen hit exactly that on 2026-08-19: he pressed Keep, then Open in Foundry,
   * and watched a new EPUB appear in the position he had just cleared. His
   * Pokemon project was carrying two archive versions and a re-landed export when
   * it was found.
   *
   * So the provenance is kept and only its MEANING changes: `foundrySource` says
   * "this is Foundry's file, on loan"; this says "this WAS Foundry's file, and it
   * is ours now". The sweep reads both, which is what closes the loop.
   */
  promotedFrom?: FoundryVariantSource;
}

/**
 * A variant as it arrives from `variant:list` — with its file already resolved.
 *
 * MIRRORS `ResolvedProjectVariant` in electron/manifest-types.ts (the renderer
 * cannot import from electron/); keep the two in step.
 *
 * `path` is project-relative and slash-separated, so it means nothing without the
 * project directory it belongs to — and the renderer must NOT supply that itself.
 * It once did, reading the live "currently selected book" path at click time: since
 * the rows load asynchronously, a row could be joined to a DIFFERENT book's
 * directory in the window between the selection changing and the rows finishing
 * their reload, addressing a file that has never existed. `absPath` is computed in
 * main from the project the variant was actually read from, so the pairing cannot
 * drift; `exists` is that path stat'ed at list time, so an action can be refused
 * with a message naming the missing file rather than failing later and deeper.
 *
 * There is deliberately no renderer-side way to rebuild absPath: see
 * studio/services/editor-route.service.ts for the same doctrine ("NO PATH
 * ARITHMETIC HAPPENS HERE").
 */
export interface ResolvedProjectVariant extends ProjectVariant {
  absPath: string;  // absolute, platform-native, NFC-normalized
  exists: boolean;  // absPath was a regular file when this list was produced
  /**
   * `vttPath` resolved the same way, or null when the variant declares no VTT.
   * The paired transcript is project-relative too, so it was subject to exactly the
   * same crossed-project join — the player window used to build it from the live
   * selection. Audio-only playback is legitimate, so null is a normal answer.
   */
  vttAbsPath: string | null;
  /** vttAbsPath was a regular file when this list was produced (false when null). */
  vttExists: boolean;
}

/**
 * What is known about one audiobook, and what main is still working out.
 *
 * MIRRORS `AudiobookFacts` in electron/versions-page-data.ts; keep the two in
 * step. It arrives twice: once inside `versions:page-data` (the cached answers,
 * with anything uncached marked `deriving`), and again on the
 * `versions:audiobook-facts` push once the derivation lands.
 *
 * `deriving` is a THIRD state and the reason this is not a pair of booleans.
 * Checking whether an m4b carries an embedded transcript means running ffmpeg
 * over a file that can be three gigabytes, and a page that drew "not checked
 * yet" as "has no transcript" would offer to generate one over a transcript
 * that is already in there. Unknown is not ineligible — see
 * StudioVersionsComponent.transcriptEligibilityKnown.
 */
export interface VersionsAudiobookFacts {
  variantId: string;
  /** Whether this audiobook has an authoritative transcript that parses. */
  transcript: 'eligible' | 'ineligible' | 'deriving';
  /** How many cues that transcript has. Null when there is not one. */
  cueCount: number | null;
  /** Whether the recorded content-analysis report still binds to these bytes. */
  reportStatus: 'valid' | 'stale' | 'missing' | 'deriving';
  analyzedAt: string | null;
  flagCount: number | null;
}

export interface ArchiveEntry {
  path: string;           // Relative: "archive/Title. Author. (2022).pdf"
  role: 'original' | 'translation' | 'export' | 'audiobook';
  format: string;         // 'pdf', 'epub', 'm4b', etc.
  language?: string;      // For translations: 'en', 'de', etc.
  label?: string;         // User-facing: "Original PDF", "English Translation"
  archivedAt: string;     // ISO timestamp
  size?: number;          // File size in bytes
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Information
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestSource {
  type: SourceType;
  originalFilename: string;   // Original filename before import
  fileHash?: string;          // SHA256 hash for deduplication

  // For articles (type: 'url')
  url?: string;               // Source URL
  fetchedAt?: string;         // When URL was fetched

  // For PDFs - editor-specific source data
  deletedBlockIds?: string[]; // Blocks deleted in editor
  /**
   * INERT. The scan-line identity a deletion used to be recorded under; nothing
   * resolves it any more — a deletion is `/FoundryDeleted` on the block's own
   * annotation in the working document. Still declared because manifests on
   * disk carry it (mirrors electron/manifest-types.ts).
   */
  deletedBlockLines?: { scanId: string; lineIds: string[] };
  /**
   * INERT, for the same reason: the editor's one-title rule is gone, and a
   * relabel is a category written into the block's own annotation.
   */
  foundryAutoDiscardedLines?: { scanId: string; lineIds: string[] };
  pageOrder?: number[];       // Reordered pages
  /**
   * Pages the picker struck out, by the page number of the LAYOUT they were
   * struck in. Written by main's `project:save-to-path` since long before this
   * declaration existed — it was missing here while the main-process type had
   * it, which is exactly the asymmetry these two files exist to avoid.
   */
  deletedPages?: number[];
  /**
   * WHICH LAYOUT the three records above, and everything under `editor`, were
   * made against — see shared/document/editor-layout.ts.
   *
   * A page number and a block id are functions of a PAGINATION, and in August
   * 2026 the pagination of an EPUB changed (mupdf's reflow → quire's
   * fragmentation of the book's own DOM: 218 pages → 183 on Killing America,
   * and block ids minted from a different string). A save states the layout it
   * was made in; an EPUB project carrying records but no stamp is the mupdf era.
   * A PDF project never carries one — its pages are the PDF's own.
   */
  editorLayout?: EditorLayoutIdentity;

  // Written by the markup-preserving EPUB export — see ExportProvenance
  exportProvenance?: ExportProvenance;
}

/**
 * Which file an export came out of, and what came out.
 *
 * The markup-preserving EPUB export aligns the editor's blocks against a
 * specific EPUB; the edits only mean anything against THAT file. Recording both
 * hashes binds the three artifacts together — the source, the edit set that was
 * applied to it, and the produced exported.epub — so a later reader can prove
 * the export still matches what it claims to (the same dual-hash discipline as
 * `audiobookAnalyses`, which will not trust a report whose hashes drifted).
 */
export interface ExportProvenance {
  sourceSha256: string;      // hash of the epub the edits were aligned against
  sourceRelPath: string;     // project-relative, slash-separated
  exportedSha256: string;    // hash of the produced export EPUB
  exportedAt: string;        // ISO timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestMetadata {
  title: string;
  subtitle?: string;
  author: string;             // Author or byline for articles
  authorFileAs?: string;      // "Last, First" format for sorting
  year?: string;
  language: string;           // Primary/source language (ISO 639-1)
  publisher?: string;
  description?: string;
  coverPath?: string;         // Relative path: "source/cover.jpg"

  // Article-specific
  byline?: string;            // Article author info from Readability
  excerpt?: string;           // Article summary
  wordCount?: number;         // Article word count

  // Audiobook-specific
  narrator?: string;
  series?: string;
  seriesPosition?: number;
  outputFilename?: string;    // Custom output filename
  contributors?: Array<{ first: string; last: string }>;
  tags?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapters with Stable IDs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ TWO DIFFERENT THINGS ARE WRITTEN TO `manifest.chapters` — see the full
 * account on the matching declaration in electron/manifest-types.ts.
 *
 * In short, measured 2026-08-09: every one of the 942 chapter entries on the
 * library's EPUB projects is the PICKER's `Chapter`
 * (`{ id, title, page, blockId?, level, source, … }`), and none carries
 * `sentences`. This type has no live writer; its only reader — the bilingual
 * player — filters on `sentences` and therefore silently finds nothing.
 * Pre-existing, and left to whoever owns the picker's chapter surface to
 * resolve, since giving one of the two concepts a different key is a change to
 * that surface rather than to this file.
 */
export interface ManifestChapter {
  id: string;                 // Stable UUID
  title: string;
  order: number;              // Sort order within book

  // Chapter-level metadata
  sourceIndex?: number;       // Original index in source document

  // Sentences with multi-language support
  sentences: ManifestSentence[];
}

export interface ManifestSentence {
  id: string;                 // Stable UUID

  // Multi-language text: { "en": "Hello", "de": "Hallo", "ko": "안녕" }
  text: Record<string, string>;

  // Audio paths per language: { "en": "stages/03-tts/en/0001.wav" }
  audio?: Record<string, string>;

  // Sentence-level metadata
  order: number;              // Sort order within chapter
  deleted?: boolean;          // Soft-deleted by user
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline State
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestPipeline {
  cleanup?: CleanupStage;
  translations?: Record<string, TranslationStage>;  // Keyed by language code
  tts?: Record<string, TTSStage>;                   // Keyed by language code
  bilingualAssembly?: Record<string, BilingualAssemblyStage>;  // Keyed by lang pair
  analysis?: AnalysisStage;
}

export interface CleanupStage {
  status: PipelineStageStatus;
  outputPath?: string;        // Relative: "stages/01-cleanup/cleaned.epub"
  completedAt?: string;
  error?: string;
  model?: string;             // AI model used
  skippedChunks?: SkippedChunkInfo[];
}

export interface SkippedChunkInfo {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;
  originalText: string;
  modelOutput: string;
  reason: string;
}

export interface TranslationStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  model?: string;             // AI model used
  sentenceCount?: number;     // Number of sentences translated
}

export interface TTSStage {
  status: PipelineStageStatus;
  sessionId?: string;         // e2a session UUID
  sessionDir?: string;        // Relative path to session directory
  completedAt?: string;
  error?: string;
  progress?: {
    completed: number;
    total: number;
  };
  settings?: TTSSettings;
}

export interface TTSSettings {
  engine: 'xtts' | 'orpheus';
  device: 'gpu' | 'mps' | 'cpu';
  voice: string;
  temperature?: number;
  speed?: number;
  workerCount?: number;
}

export interface BilingualAssemblyStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  sourceLang: string;
  targetLang: string;
  pauseDuration?: number;     // Pause between source/target in ms
  gapDuration?: number;       // Gap between sentence pairs in ms
}

export interface AnalysisStage {
  status: PipelineStageStatus;
  outputPath?: string;        // Relative: "stages/04-analysis/analysis.json"
  completedAt?: string;
  error?: string;
  model?: string;             // AI model used
  flagCount?: number;         // Total flags found
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE WORKING CHAIN: an archive-grade EPUB and everything derived from it — the
 * working copy, its ledger, its strikes, its narration copy.
 *
 * Mirrors `BookFamily` in electron/manifest-types.ts. The identity rules (which
 * chain a question is about, what its files are named after) are pure and live
 * in shared/document/book-families.ts, so main and this side cannot disagree
 * about which book a row is standing on.
 */
export interface BookFamily {
  id: string;
  source: {
    path: string;
    kind: 'archive-epub' | 'generated-epub';
    /** Null when the source was not on disk when the chain was minted. */
    sha256: string | null;
  };
  epub?: EpubOutput;
  ttsEpub?: NarrationEpubOutput;
}

export interface ManifestOutputs {
  // Single-language audiobook
  audiobook?: AudiobookOutput;

  // Bilingual audiobooks keyed by "sourceLang-targetLang" (e.g., "en-de")
  bilingualAudiobooks?: Record<string, AudiobookOutput>;

  // LEGACY, and nothing in the renderer may read either. The book and its
  // narration copy moved into the chain that owns them (`families[].epub`,
  // `families[].ttsEpub`) when a project became able to hold more than one; a
  // one-time migration in main moves them the first time anything asks about the
  // project. They stay declared because a manifest read before that has them.
  epub?: EpubOutput;
  ttsEpub?: NarrationEpubOutput;

  // Playback position bookmarks keyed by output identifier: "audiobook", "en-de", etc.
  bookmarks?: Record<string, BookmarkState>;

  // User-created named bookmarks keyed by output identifier
  namedBookmarks?: Record<string, NamedBookmark[]>;
}

/**
 * The EPUB the editor produced: the project's converted book, not a throwaway
 * TTS artifact. Its filename comes from the book's title, so this record is the
 * ONE authority on where it is — nothing may scan `source/` for a name pattern.
 */
export interface EpubOutput {
  // Project-relative, forward slashes, e.g. `source/The Waste Land.epub`.
  path: string;
  modifiedAt: string;
  // Every pass applied to this file, oldest first. A pass rewrites the book in
  // place, so this list is the only record of what was done to it — and what
  // Studio reads instead of scanning for the stage copies it replaced.
  appliedPasses?: AppliedPass[];
  // The LEDGER: the passes the user committed to, oldest first, each keeping a
  // snapshot of the book as it left it so it can be taken back on its own
  // (`book:delete-ledger-entry`). A superset of an `appliedPasses` entry — a
  // pass that ran before the ledger existed, or one that changed the book's
  // element structure, is in that list and not this one, because it happened and
  // cannot be undone in isolation. See electron/manifest-types.ts for the full
  // record; the renderer only ever reads these fields.
  ledger?: Array<{
    id: string;
    kind: AppliedPassKind;
    label: string;
    createdAt: string;
    // Project-relative path to the diff frozen when the pass ran, or null when
    // the pass recorded none (translate deliberately does not).
    receipt: string | null;
  }>;
  // What the user has struck out of this book FOR NARRATION — never applied to
  // the file itself. Inside this record so a rebuild drops it with the
  // provenance it belongs to.
  narrationDeletions?: NarrationDeletions;
}

// What has ever been done to a book. ONLY THE RUNNABLE SET SHRINKS: a manifest
// is a book's own history, so a name that leaves the pipeline stays in this type
// forever (see electron/manifest-types.ts, which this mirrors). A run today is
// Simplify and Translate over the book; making the book is `vlm-convert`.
// `RetiredPassKind` cannot be requested — the Aug 2026 wave retired the whole
// Tesseract-era document pipeline when `foundry vlm-convert` became the only
// PDF→EPUB conversion.
export type RetiredPassKind =
  | 'get-text'
  | 'blocks'
  | 'reflow'
  | 'footnotes'
  | 'tesseract'
  | 'ocr-correction'
  | 'detection';

export type AppliedPassKind =
  | 'simplify'
  | 'translate'
  // The digits-only footnote-reference strip, applied to the BOOK. Distinct
  // from the retired 'footnotes' below, which was an AI pass that decided for
  // itself what a footnote was.
  | 'footnote-refs'
  // The narration text cleanup: punctuation, the number rules, then the model on
  // the residue. It edits the BOOK and stamps it; a render refuses a book that
  // has not had it. Mirrors electron/manifest-types.ts.
  | 'narration-text'
  // The route to a book: a document vision model read the pages
  // (`foundry vlm-convert`). A book's ORIGIN — never a transformation of one,
  // and never a queue job.
  | 'vlm-convert'
  | RetiredPassKind;

// One completed pass. Appended when the pass finishes, never on failure.
export interface AppliedPass {
  kind: AppliedPassKind;
  // ISO timestamp of completion.
  at: string;
  // What the pass was told to do — model, mode, languages. Free-form per kind.
  params?: Record<string, unknown>;
  // Project-relative path to this pass's diff, forward slashes. Absent for the
  // passes with nothing to diff against (tesseract) or nothing meaningful
  // to diff (translate).
  diff?: string;
}

export interface BookmarkState {
  position: number;        // currentTime in seconds
  chapterId?: string;
  cueIndex?: number;
  lastPlayedAt: string;    // ISO timestamp
  speed?: number;          // playback speed (mono player)
  sourceSpeed?: number;    // source language speed (bilingual)
  targetSpeed?: number;    // target language speed (bilingual)
}

export interface NamedBookmark {
  name: string;
  position: number;        // seconds
  chapterId?: string;
  createdAt: string;       // ISO timestamp
}

export interface AudiobookOutput {
  path: string;               // Relative: "output/audiobook.m4b"
  vttPath?: string;           // Relative: "output/audiobook.vtt"
  sentencePairsPath?: string; // Relative: "stages/02-translate/sentence_pairs_de.json"
  duration?: number;          // Duration in seconds
  completedAt?: string;
  professionallyRead?: boolean;  // user-settable "professionally read" flag
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor State (for PDF source)
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestEditorState {
  // Undo/redo stacks
  undoStack?: EditorHistoryAction[];
  redoStack?: EditorHistoryAction[];

  // Article-specific: deleted selectors
  deletedSelectors?: string[];
}

export interface EditorHistoryAction {
  type: 'delete' | 'restore' | 'reorder';
  ids: string[];              // Block IDs or selectors
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Support
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrationResult {
  success: boolean;
  projectId?: string;
  manifestPath?: string;
  error?: string;
  warnings?: string[];
}

export interface MigrationProgress {
  phase: 'scanning' | 'migrating' | 'complete' | 'error';
  current: number;
  total: number;
  currentProject?: string;
  migratedProjects: string[];
  failedProjects: Array<{ path: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Result Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which kinds of narration a project actually has. Both can be true — a book can
 * carry a bought human-narrated m4b AND a TTS render — and both false means it has
 * no audiobook at all, which is why "AI" is not the negation of "professional".
 *
 * Derived in the main process from getVariants(), the ONE place that knows how
 * audiobook outputs dedupe against real variants and which default each kind takes.
 * Never persisted to a manifest.
 */
export interface NarrationFlags {
  professional: boolean;
  ai: boolean;
}

/**
 * WHICH file the shelf's Process button would narrate for one book, and why.
 *
 * MIRRORS `TtsTarget` in electron/manifest-types.ts (the deriving side); keep the
 * two in step. Owen, 2026-08-16: "im going to need a tts processing button on the
 * homepage once i export a tts-able epub."
 *
 * Precedence: the version the user MARKED, else the newest EPUB Foundry exported
 * (the case the button exists for — a book that has been through Foundry has at
 * least two EPUBs, so "sole EPUB" would almost never fire for it), else the sole
 * EPUB version. Several EPUBs with none marked and none exported yields NO
 * target and no button: the shelf cannot say which, and the versions page keeps
 * the choice. `absPath` is resolved in main; the renderer never joins it.
 */
export interface TtsTarget {
  variantId: string;
  absPath: string;
  exists: boolean;
  title: string;
  rule: 'marked' | 'newest-export' | 'sole-epub';
}

export interface ManifestListResult {
  success: boolean;
  projects?: ProjectManifest[];
  /** Narration flags per projectId. Populated for EVERY returned project. */
  narration?: Record<string, NarrationFlags>;
  /**
   * The shelf's Process target per projectId — present ONLY for books that have
   * one. A missing entry means "no Process button for this book on the shelf",
   * which is a real answer and never "look one up".
   */
  ttsTargets?: Record<string, TtsTarget>;
  error?: string;
}

export interface ManifestGetResult {
  success: boolean;
  manifest?: ProjectManifest;
  projectPath?: string;       // Absolute path to project folder
  error?: string;
}

export interface ManifestSaveResult {
  success: boolean;
  manifestPath?: string;
  error?: string;
}

export interface ManifestCreateResult {
  success: boolean;
  projectId?: string;
  projectPath?: string;
  manifestPath?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Partial manifest for updates - all fields optional except projectId
 */
export type ManifestUpdate = Partial<Omit<ProjectManifest, 'projectId' | 'version'>> & {
  projectId: string;
};


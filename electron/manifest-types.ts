/**
 * Manifest Types for Electron Main Process
 *
 * These types mirror the Angular types in src/app/core/models/manifest.types.ts
 * Keep both in sync when making changes.
 */

import type { TextBlock, Category } from '../shared/ocr/text-block';
import type { NarrationDeletions, NarrationEpubOutput } from '../shared/vlm/narration-deletions';
import type { EditorLayoutIdentity } from '../shared/document/editor-layout';

export type { NarrationDeletions, NarrationEpubOutput, EditorLayoutIdentity };

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

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
  createdAt: string;
  modifiedAt: string;
  source: ManifestSource;
  metadata: ManifestMetadata;
  chapters: ManifestChapter[];
  pipeline: ManifestPipeline;
  outputs: ManifestOutputs;
  editor?: ManifestEditorState;

  // Organization
  archived?: boolean;
  sortOrder?: number;

  // Archive
  archive?: ArchiveEntry[];

  // Book variants — distinct editions/languages/formats of the SAME book in one
  // project (English epub, German epub, the m4b audiobook…). The primaryVariantId
  // variant represents the project (its metadata mirrors `metadata`). Separate
  // from pipeline "versions" (original/exported/cleaned…), which are stages of the
  // active source. Derived lazily from archive[]/outputs for older projects.
  variants?: ProjectVariant[];
  primaryVariantId?: string;

  /**
   * Completed audiobook analyses, keyed by the stable audiobook variant id.
   * The referenced report is usable only after the protocol verifies both hashes
   * against the current variant. Document analysis remains in pipeline.analysis.
   */
  audiobookAnalyses?: Record<string, AudiobookAnalysisManifestEntry>;
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
  author?: string;
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
  format: string; // 'epub' | 'pdf' | 'm4b' | …
  path: string;   // project-relative: "archive/…epub" or "output/…m4b"
  descriptor?: string; // free text: "German", "First edition", "TTS", …
  metadata: VariantMetadata;
  vttPath?: string;        // audiobook variants: project-relative synced transcript
  sourceFileHash?: string; // dedup
  addedAt: string;
  professionallyRead?: boolean;  // audiobook variants: user-settable "professionally read" flag
}

/**
 * A variant as handed to the RENDERER — with its file already resolved.
 *
 * `ProjectVariant.path` is project-relative and slash-separated, so it means
 * nothing without the project directory it belongs to. The renderer used to join
 * the two itself, reading the live "currently selected book" path at click time;
 * because the variant rows load asynchronously, a row could be paired with a
 * DIFFERENT book's directory in the window between the selection changing and the
 * rows finishing their reload — addressing a file that has never existed
 * ("<project B>/archive/<book A>.pdf": ENOENT).
 *
 * So resolution happens HERE, in main, in the same call that produces the row:
 * `absPath` is bound to the project the variant was read from and cannot drift.
 * `exists` is that path stat'ed at list time, so a caller can refuse an action
 * with a message that names the missing file instead of failing later, deeper,
 * with a path the user cannot place.
 */
export interface ResolvedProjectVariant extends ProjectVariant {
  absPath: string;  // absolute, platform-native, NFC-normalized
  exists: boolean;  // absPath was a regular file when this list was produced
  /** `vttPath` resolved the same way, or null when the variant declares no VTT. */
  vttAbsPath: string | null;
  /** vttAbsPath was a regular file when this list was produced (false when null). */
  vttExists: boolean;
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

export interface ManifestSource {
  type: SourceType;
  originalFilename: string;
  fileHash?: string;
  url?: string;
  fetchedAt?: string;
  deletedBlockIds?: string[];
  /**
   * INERT. The scan-line identity a deletion used to be recorded under, from
   * when block ids were re-minted by every blocks run and the exporter had to
   * re-resolve them against the scan on disk.
   *
   * Nothing reads it any more: a deletion is `/FoundryDeleted` on the block's own
   * annotation in the working document, which is the block itself rather than a
   * name for it, so there is nothing left to re-resolve and nothing that can go
   * stale. Still declared because manifests on disk carry it and a type that
   * refused to admit a field the file has would make those projects unreadable.
   */
  deletedBlockLines?: { scanId: string; lineIds: string[] };
  /**
   * INERT, for the same reason as `deletedBlockLines` above: the editor's
   * one-title rule is gone, and a relabel is now a category written into the
   * block's own annotation rather than a ruling held beside it.
   */
  foundryAutoDiscardedLines?: { scanId: string; lineIds: string[] };
  pageOrder?: number[];
  /**
   * Pages the picker struck out, by the page number of the LAYOUT they were
   * struck in — the PDF's own pages for a PDF project, mupdf's pagination of the
   * book for a project curated on an EPUB.
   *
   * Written by the project save (main's `project:save-to-path`) since long
   * before this declaration existed; declared now because the narration export
   * reads it (electron/narration-editor-state.ts), and a field the type refused
   * to admit would have to be read through a cast, which is how it went
   * unnoticed that nothing read it at all.
   */
  deletedPages?: number[];
  /**
   * WHICH LAYOUT the two records above, and everything under `editor`, were made
   * against — see shared/document/editor-layout.ts.
   *
   * A page number and a block id are both functions of a pagination rather than
   * of the book, and in August 2026 the pagination of an EPUB changed: mupdf's
   * reflow gave way to quire's fragmentation of the book's own DOM, which puts
   * *Killing America* on 183 pages where mupdf put it on 218 and mints block ids
   * from a different string entirely. Replaying a record from one layout against
   * the other strikes out paragraphs the user never touched.
   *
   * So a save STATES the layout it was made in, and an EPUB project that carries
   * records but no stamp is read as the mupdf era — the absence is the answer,
   * not a gap. A PDF project never carries one: mupdf's pagination of a PDF is
   * the PDF's own pages and did not change.
   */
  editorLayout?: EditorLayoutIdentity;
  /** Written by the markup-preserving EPUB export — see ExportProvenance. */
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

export interface ManifestMetadata {
  title: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
  publisher?: string;
  description?: string;
  coverPath?: string;
  byline?: string;
  excerpt?: string;
  wordCount?: number;
  narrator?: string;
  series?: string;
  seriesPosition?: number;
  outputFilename?: string;
  contributors?: Array<{ first: string; last: string }>;
  tags?: string[];
  /**
   * Per-format overrides for the AUDIOBOOK, independent from the ebook/canonical
   * fields above. Only the fields the user changed for the audiobook are stored;
   * unset fields fall back to the canonical values (see effectiveAudiobookMetadata).
   * This is what gets embedded into the m4b's tags.
   */
  audiobook?: {
    title?: string;
    author?: string;
    year?: string;
    narrator?: string;
    series?: string;
    seriesPosition?: number;
    description?: string;
    coverPath?: string;
  };
}

/**
 * ⚠ TWO DIFFERENT THINGS ARE WRITTEN TO `manifest.chapters`, AND THIS IS ONLY
 * ONE OF THEM. Measured across the library 2026-08-09, pre-existing, not
 * introduced by the quire cutover.
 *
 * What is ACTUALLY on disk is the PICKER's `Chapter` — declared three times over
 * (electron/pdf-analyzer.ts, electron/preload.ts,
 * src/app/core/services/electron.service.ts) as
 * `{ id, title, page, blockId?, mergedBlockIds?, y?, level, source, confidence? }`
 * — written verbatim by main's `project:save-to-path`
 * (`manifest.chapters = mergedData.chapters`) from the picker's own
 * `chapters` signal, and read back verbatim by `projects:load-from-path`.
 * Of the 942 chapter entries on EPUB projects, 942 carry `page` and ZERO carry
 * `sentences`; 159 carry a `blockId`.
 *
 * `ManifestChapter` — this type, `order` + `sentences` — has NO live writer
 * anywhere in the repo. Its one reader is the bilingual player
 * (src/app/features/language-learning/components/bilingual-player), which
 * filters on `ch.sentences?.length > 0` and sorts on `a.order - b.order`:
 * against every real manifest that filter removes everything and that sort
 * compares undefined, so the lookup silently yields nothing. It is a leftover
 * of the pre-picker sentence pipeline.
 *
 * Left declared rather than repaired here on purpose: `manifest.chapters` is
 * the picker's field and the picker is being rebuilt for EPUBs in parallel
 * (Phase B/C of the quire cutover). Deciding which of the two concepts owns the
 * key — and giving the other one its own — is a change to that surface, and
 * doing it from this file would be two agents editing the same contract. What
 * belongs here is the record that the collision exists, since neither
 * declaration admitted it before.
 *
 * NOTE for the quire cutover: because the picker's markers carry a `page`, they
 * are layout-keyed like `deletedPages`, and `source.editorLayout` governs them —
 * a stale-layout project's chapters are withheld on load and left alone on save
 * (electron/legacy-epub-layout.ts).
 */
export interface ManifestChapter {
  id: string;
  title: string;
  order: number;
  sourceIndex?: number;
  sentences: ManifestSentence[];
}

export interface ManifestSentence {
  id: string;
  text: Record<string, string>;
  audio?: Record<string, string>;
  order: number;
  deleted?: boolean;
}

export interface ManifestPipeline {
  cleanup?: CleanupStage;
  translations?: Record<string, TranslationStage>;
  tts?: Record<string, TTSStage>;
  bilingualAssembly?: Record<string, BilingualAssemblyStage>;
}

export interface CleanupStage {
  status: PipelineStageStatus;
  outputPath?: string;
  completedAt?: string;
  error?: string;
  model?: string;
}

export interface TranslationStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  model?: string;
  sentenceCount?: number;
}

export interface TTSStage {
  status: PipelineStageStatus;
  sessionId?: string;
  sessionDir?: string;
  completedAt?: string;
  error?: string;
  progress?: { completed: number; total: number };
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
  pauseDuration?: number;
  gapDuration?: number;
}

export interface ManifestOutputs {
  audiobook?: AudiobookOutput;
  bilingualAudiobooks?: Record<string, AudiobookOutput>;
  /**
   * The book cast from a PDF's pages — archive-grade, and never the file the
   * user edits. See GeneratedEpubOutput.
   */
  generatedEpub?: GeneratedEpubOutput;
  /** The project's converted book — see EpubOutput. */
  epub?: EpubOutput;
  /**
   * The narration copy: the book with what the user struck out of it removed.
   *
   * A SECOND file, never the book. `outputs.epub` is the complete converted book
   * and stays complete; this is what the TTS step reads when it is there, and
   * the wizard says which of the two it is using rather than swapping one for
   * the other. Written by `book:export-narration-epub` from
   * `epub.narrationDeletions`; see shared/vlm/narration-deletions.ts.
   */
  ttsEpub?: NarrationEpubOutput;
}

/**
 * The book a page reader cast from a PDF — `source/<archive basename>.generated.epub`.
 *
 * ── Why a PDF project has TWO EPUBs now ─────────────────────────────────────
 *
 * Owen, 2026-08-09: "same goes for an epub generated from a pdf. it should be
 * treated as an archive file. a working copy of the generated epub is created."
 *
 * `foundry vlm-convert` used to write straight onto `outputs.epub`, which made
 * the cast book and the editable book ONE file. That put an hour of GPU inside
 * the thing a user throws away when they want to start their edits over: erasing
 * changes meant re-reading every page. So the cast lands here instead, this file
 * joins `archive/` in the class of things nothing may write to, and
 * `outputs.epub` is a byte-identical working copy minted from it — the same
 * derivation, digest check and reset an EPUB-native project's copy gets.
 *
 * Deliberately NOT an entry in `manifest.archive`. That list is the files the
 * USER handed us, and `archiveOriginalEntry` / `workingEpubStem` key the whole
 * naming convention off it; a generated book is derived, so it lives with the
 * other derived artifacts and the archive keeps meaning what it says.
 */
export interface GeneratedEpubOutput {
  /** Project-relative, forward slashes, e.g. `source/Killing America.generated.epub`. */
  path: string;
  /** When it was written (a cast) or adopted (a migration). */
  modifiedAt: string;
  /** Its sha256 when it was recorded — what a working copy is proved against. */
  sha256: string;
  /**
   * Where these bytes came from, and it changes what "erase all changes" means.
   *
   *  - `cast` — foundry read the PDF's pages and wrote this. Erasing changes
   *    puts the book back exactly as the reader cast it.
   *  - `adopted` — the project was made before generated books were kept, so its
   *    working copy WAS the cast and had already been edited when BookForge
   *    started keeping one. These bytes are that copy at the moment of the
   *    migration, which is the earliest state of the book still on this disk;
   *    the pristine cast is not recoverable without re-reading the pages. Said
   *    out loud rather than papered over, because a user erasing their changes
   *    is entitled to know which book they land on.
   */
  origin: 'cast' | 'adopted';
}

/**
 * The EPUB the editor produced: the project's converted book, not a throwaway
 * TTS artifact. Its filename comes from the book's title, so this record is the
 * ONE authority on where it is — nothing may scan `source/` for a name pattern.
 */
export interface EpubOutput {
  /** Project-relative, forward slashes, e.g. `source/The Waste Land.epub`. */
  path: string;
  modifiedAt: string;
  /**
   * Every pass that has been applied to this file, oldest first.
   *
   * A pass rewrites the book IN PLACE, so the file itself carries no evidence of
   * what was done to it — this list is the only record. It is also what Studio
   * reads to answer "has this been OCR-corrected / simplified / translated?",
   * which is why it is per-file rather than a pipeline stage status: the stage
   * copies it replaced (`stages/01-cleanup/cleaned.epub`, `simplified.epub`) are
   * gone for the mono pipeline.
   */
  appliedPasses?: AppliedPass[];
  /**
   * The LEDGER: the passes the user committed to, each one deletable on its own,
   * oldest first.
   *
   * Absent is a real state and the common one — a book nothing has been run
   * over. It is never an empty list standing in for "we did not look".
   *
   * A ledger entry is a SUPERSET of an `appliedPasses` entry, and the two answer
   * different questions. `appliedPasses` says what has been done to the bytes
   * that are there now; the ledger says what can be TAKEN BACK, and it can only
   * say that because each entry keeps a snapshot of the book as its pass left
   * it. A pass that ran before the ledger existed, or one whose snapshot was
   * refused (see `registerLedgerPass`), appears in `appliedPasses` and not here:
   * it happened, and it cannot be undone in isolation.
   *
   * It lives inside this record deliberately, where `registerEpubExport` drops
   * it — a rebuild writes a book the snapshots are not a chain to, so a ledger
   * that survived would offer to "go back" to a file that is not this book's
   * ancestor. The one derivation that means to keep it says so, by carrying it
   * (`deriveWorkingCopy` → `registerEpubExport`'s `carry`).
   */
  ledger?: LedgerEntry[];
  /**
   * What the user has struck out of this book FOR NARRATION — never applied to
   * the file itself.
   *
   * It lives inside this record on purpose: `registerEpubExport` replaces
   * `outputs.epub` wholesale on a rebuild, so a book that has been rebuilt loses
   * the strikes made against the old one in the same act that ends its
   * provenance. See shared/vlm/narration-deletions.ts for the identity of an
   * element and why the record is stamped with the book's sha256 anyway.
   */
  narrationDeletions?: NarrationDeletions;
  /**
   * Every edit that rewrote this book's own MARKUP, oldest first.
   *
   * Distinct from `appliedPasses`, which names WHICH PASS ran over the whole
   * file. These are single, deliberate, user-made edits to particular elements,
   * and each one carries what the element said before and what it says now.
   *
   * Owen, 2026-08-09, on the chapter-opening fold: "as long as we have a record
   * of what it was before and what it was changed to, it can be changed." This
   * list IS that record, and it is why the edit is allowed at all — the working
   * copy is editable, the archive original beside it is not, and the difference
   * between an edit and a corruption is whether the book can say what happened
   * to it.
   */
  bookEdits?: BookEdit[];
}

/**
 * The chapter-opening fold: one opening rewritten to its chapter's stored name,
 * with the elements folded into it removed from the markup.
 *
 * `openerKey` and the folded keys are narration element keys — `<zip entry>#<index>`,
 * positions in the one enumeration walk everything shares
 * (shared/vlm/narration-deletions.ts). They name POSITIONS IN THE BOOK BEFORE
 * THIS EDIT, which is the only book those numbers ever described: the fold
 * renumbers everything after the folds, and the strike record is carried across
 * in the same manifest transaction that appends this entry.
 */
export interface MergeChapterOpeningEdit {
  kind: 'merge-chapter-opening';
  at: string;
  /** The zip entry that was rewritten. */
  file: string;
  openerKey: string;
  /** What the opening printed before, whitespace collapsed. */
  openerTextBefore: string;
  /** What it says now: the chapter's stored name, single line. */
  openerTextAfter: string;
  /** The elements that went, each with the text it held. */
  folded: Array<{ key: string; textBefore: string }>;
  /** The book's sha256 before the edit and after it. */
  fromSha256: string;
  toSha256: string;
}

/**
 * The chapter-opening NAMING: every named chapter's opening rewritten to say
 * what the book's own table of contents calls that chapter.
 *
 * Unattended — it runs when the project opens and after a chapter is renamed —
 * and TEXT-ONLY. No element is removed, which is the whole difference from
 * {@link MergeChapterOpeningEdit}: every text-unit index and image ordinal is
 * where it was, so the narration strike record is re-stamped onto the book's
 * new bytes with its keys untouched rather than migrated.
 *
 * One entry per RUN, not per chapter: a pass that named nineteen openings is
 * one act, and the nineteen are its subject. A run that named nothing writes no
 * entry at all.
 */
export interface NameChapterOpenersEdit {
  kind: 'name-chapter-openers';
  at: string;
  /** Every opening rewritten, with the words it printed before. */
  named: Array<{
    /** The zip entry it is in. */
    file: string;
    /** `<zip entry>#<index>` — the position, unchanged by this edit. */
    openerKey: string;
    /** What it printed, whitespace collapsed: "2", "CHAPTER TWO", "". */
    textBefore: string;
    /** What it says now: the chapter's stored name, single line. */
    textAfter: string;
  }>;
  /** The book's sha256 before the pass and after it. */
  fromSha256: string;
  toSha256: string;
}

/**
 * One edit to a book's markup. A union on purpose: every edit gets its own
 * `kind` and its own before/after fields rather than a shared "details" bag
 * nothing can read.
 */
export type BookEdit = MergeChapterOpeningEdit | NameChapterOpenersEdit;

/**
 * What has ever been done to a book — the things that can be done to one now,
 * plus every name books already record.
 *
 * ONLY THE RUNNABLE SET SHRINKS. A manifest is a BOOK'S OWN HISTORY, so a name
 * that leaves the pipeline stays in this type forever: dropping it would make a
 * real book's provenance unreadable — the history would silently shorten rather
 * than say what happened.
 *
 * `RetiredPassKind` is everything that can no longer be asked for. The Aug 2026
 * wave is the big one: `foundry vlm-convert` became the only PDF→EPUB
 * conversion, and the whole Tesseract-era document pipeline went with it —
 * `get-text` (the cast), `blocks` (Detect), `reflow` (the exporter) and the AI
 * `footnotes` pass, which had already absorbed `tesseract`, `ocr-correction`
 * and `detection` from the wave before it.
 */
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
  // The digits-only footnote-reference strip, applied to the BOOK rather than to
  // the narration copy (shared/text/sup-markers.ts,
  // `stripFootnoteReferencesFromBook`). Deterministic and seconds long, which is
  // why it is offered a synchronous door as well as the queue — and distinct
  // from the retired `footnotes` kind below, which was an AI pass that decided
  // for itself what a footnote was.
  | 'footnote-refs'
  // The route to a book: a document vision model read the pages and foundry
  // assembled them (`foundry vlm-convert`). A book's ORIGIN rather than a
  // transformation of one, so it is the first record in a converted book's
  // provenance and never appears after another pass. It is not a queue job type
  // and the chain planner refuses it — see shared/vlm/conversion.ts.
  | 'vlm-convert'
  | RetiredPassKind;

/** One completed pass. Appended when the pass finishes, never on failure. */
export interface AppliedPass {
  kind: AppliedPassKind;
  /** ISO timestamp of completion. */
  at: string;
  /** What the pass was told to do — model, mode, languages. Free-form per kind. */
  params?: Record<string, unknown>;
  /**
   * Project-relative path to this pass's diff, forward slashes
   * (`stages/02-footnotes/diff.json`). Absent for the passes that have nothing
   * to diff against (tesseract) or nothing meaningful to diff (translate).
   */
  diff?: string;
}

/**
 * One entry in the book's ledger: a pass, and the book as that pass left it.
 *
 * ── Why a snapshot and not a reverse diff ───────────────────────────────────
 *
 * Because a pass is an AI rewrite of a whole book, and the only thing that can
 * reliably put the previous text back is the previous text. Owen licensed the
 * copies outright — "we can create as many copies as we need logistically, this
 * is just how the ui should work" — so the entry keeps the bytes rather than a
 * recipe for reconstructing them.
 *
 * The chain reads base → entry[0].snapshot → entry[1].snapshot → …, and the
 * working copy is derived from the LAST snapshot. Deleting an entry re-derives
 * from the one before it (`deleteLedgerEntry` in manifest-service).
 */
export interface LedgerEntry {
  /**
   * Stable, unique, and also the name of the directory this entry owns —
   * `NN-<kind>-<random>`, e.g. `01-simplify-3f2a9c11`. The ordinal is for a
   * human reading `source/ledger/`; the random tail is what keeps two runs of
   * the same pass at the same position from colliding.
   */
  id: string;
  kind: AppliedPassKind;
  /** What the row says, e.g. "Simplify". */
  label: string;
  /** When the pass finished — the same instant as `pass.at`. */
  createdAt: string;
  /** The directory this entry owns, project-relative: `source/ledger/<id>`. */
  dir: string;
  /**
   * The book as this pass left it, project-relative. Deriving the working copy
   * from it is a byte-for-byte copy, proved by digest like every other mint.
   */
  snapshot: string;
  /** The snapshot's sha256 when it was taken — what a derivation proves against. */
  snapshotSha256: string;
  /**
   * The pass's diff, FROZEN into this entry's directory when the pass ran, or
   * null.
   *
   * Owen: "the diff is frozen in time when the footnote removal ran." It is a
   * copy rather than a pointer at `stages/NN-<kind>/diff.json` precisely because
   * that directory is cleared by every rebuild of the book
   * (`passesAfterEpubEvent`), and a receipt that vanished when the book was
   * re-derived would be a review button with nothing behind it.
   *
   * Null is a REAL state, not a missing value: `translate` deliberately records
   * no diff (a translation shares no words with what it replaced), and a pass
   * whose diff was never written has none to freeze. It is reported as "no diff
   * was recorded", never rebuilt.
   */
  receipt: string | null;
  /**
   * The provenance record these snapshot bytes carry.
   *
   * Held on the entry so a derivation can put `appliedPasses` back truthfully:
   * `registerEpubExport` ends the old book's provenance wholesale, which is
   * right for a rebuild and wrong for a re-derivation of a book that still HAS
   * these passes applied. Its `diff` points at this entry's frozen receipt, not
   * at the stage directory, for the reason above.
   */
  pass: AppliedPass;
}

export interface AudiobookOutput {
  path: string;
  vttPath?: string;
  sentencePairsPath?: string;
  duration?: number;
  completedAt?: string;
  professionallyRead?: boolean;  // user-settable "professionally read" flag
}

export interface ManifestEditorState {
  undoStack?: EditorHistoryAction[];
  redoStack?: EditorHistoryAction[];
  deletedSelectors?: string[];
  /**
   * A completed OCR pass: the categorized paragraph blocks, and the category
   * records they were classified into.
   *
   * Written by the picker's save (`project:save-to-path`) and by
   * `cli/ocr-pdf.js --project` via `ocr-project-store.ts`; read back by
   * `projects:load-from-path`, which is what makes reopening an OCR'd book show
   * the stored blocks instead of re-OCRing. Typed here because the CLI writes
   * them from outside the renderer — `project:save-to-path` still assigns them
   * through an untyped parsed manifest, so this declaration documents the
   * contract rather than enforcing it there.
   *
   * Block IDs are FROZEN once written: `categoryCorrections` keys hand labels by
   * block id, so replacing these blocks orphans those labels.
   */
  ocrBlocks?: TextBlock[];
  ocrCategories?: Record<string, Category>;

  // ── The rest of what `project:save-to-path` actually writes ───────────────
  //
  // Measured 2026-08-09: main's save handler persists SIXTEEN keys under
  // `manifest.editor`, and until this block twelve of them appeared in neither
  // this declaration nor the renderer's. They round-trip through
  // `projects:load-from-path` and are cleared by `pipeline:reset-editor-state`,
  // so they are as real as the five above — the type simply did not admit them,
  // which is how it went unnoticed that a change of paginator invalidates most
  // of them (see `editorLayout` on ManifestSource).
  //
  // They are typed as loosely as they are written. The picker owns their exact
  // shapes and this file is not the place to re-specify them; what it must state
  // is that they EXIST and which of them a layout explains, because that is what
  // the migration reads. `unknown` rather than `any`, so nothing here can be
  // silently mis-consumed by a reader that guesses.
  //
  // LAYOUT-KEYED (block ids or page numbers — retired by a paginator change,
  // see LAYOUT_KEYED_EDITOR_FIELDS in shared/document/editor-layout.ts):
  /** `{ "<block id>": { text } }` — hand-edited block text. */
  blockEdits?: Record<string, unknown>;
  /** Highlight rectangles, each on a page of the layout. */
  customCategories?: unknown;
  /** Blocks the user drew by hand, each with an id and a page. */
  manualBlocks?: TextBlock[];
  /** `[["<block id>", "<category>"], …]` — labels set by hand. */
  categoryCorrections?: unknown;
  /** The same pairs, learned from the corrections rather than set. */
  learnedCategories?: unknown;
  /** `["<block id>", …]` — where a paragraph was declared to break. */
  paragraphBreaks?: string[];
  /** Split definitions, keyed by the block that was split. */
  blockSplits?: unknown;
  /** `[{ mergedBlockId, sourceBlockIds }]`. */
  blockMerges?: unknown;
  /** Crop rectangles, each on a page of the layout. */
  cropRegions?: unknown;
  /** Text fixes, keyed by block id. */
  textCorrections?: unknown;
  //
  // NOT layout-keyed — these survive a change of paginator untouched:
  /** Tuning numbers for the classifier. Names no position. */
  classificationThresholds?: unknown;
  /** sha256 of the source file the editor state was made against. */
  sourceFileSha256?: string;
  /**
   * A rubric run's predictions, keyed in THAT run's own id space
   * (`ocr_p4_0_7r8inz`) rather than in the picker's, and naming files outside
   * the project. Not the picker's block ids, so not the picker's layout.
   */
  rubricPredictions?: unknown;
}

export interface EditorHistoryAction {
  type: 'delete' | 'restore' | 'reorder';
  ids: string[];
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestGetResult {
  success: boolean;
  manifest?: ProjectManifest;
  projectPath?: string;
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

export interface ManifestListResult {
  success: boolean;
  projects?: ProjectManifest[];
  /** Narration flags per projectId. Populated for EVERY returned project. */
  narration?: Record<string, NarrationFlags>;
  error?: string;
}

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

export interface ProjectSummary {
  projectId: string;
  projectType: ProjectType;
  title: string;
  author: string;
  coverPath?: string;
  coverData?: string;
  language: string;
  createdAt: string;
  modifiedAt: string;
  hasCleanup: boolean;
  hasTranslations: string[];
  hasTTS: string[];
  hasAudiobook: boolean;
  hasBilingualAudiobooks: string[];
  sourceUrl?: string;
  wordCount?: number;
}

/**
 * A patch for `updateManifest`. The sub-objects it merges — source, metadata,
 * pipeline, outputs, editor — are SHALLOW-MERGED into the stored manifest
 * (`{...manifest.source, ...update.source}`), so a caller is meant to send only
 * the fields it is changing. `Partial<ProjectManifest>` alone made each of those
 * optional-but-complete, which forced callers to either restate required fields
 * they were not touching or cast the whole patch away.
 */
export type ManifestUpdate =
  Partial<Omit<ProjectManifest, 'projectId' | 'version' | 'source' | 'metadata' | 'pipeline' | 'outputs' | 'editor'>>
  & {
    projectId: string;
    source?: Partial<ProjectManifest['source']>;
    metadata?: Partial<ProjectManifest['metadata']>;
    pipeline?: Partial<ProjectManifest['pipeline']>;
    outputs?: Partial<ProjectManifest['outputs']>;
    editor?: Partial<ProjectManifest['editor']>;
  };

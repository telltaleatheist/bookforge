/**
 * The processing-run wire format — one declaration, three programs.
 *
 * The wizard composes a run, main plans and executes it, and the queue persists
 * the plan into queue.json. All three have to agree on these shapes down to the
 * field name, and the two previous attempts at "the renderer's view of the wire"
 * in this codebase (preload's re-declared types) are re-declared precisely
 * because their main-side originals reach for `electron` at load. These do not:
 * they are types and nothing else, so both programs import THEM rather than a
 * copy of them.
 *
 * The model they describe is in docs/PROCESSING_PIPELINE_V2.md.
 */

/** The five things a run can do to a book. Mirrors AppliedPassKind. */
export type ProcessingPassKind =
  | 'tesseract'
  | 'ocr-correction'
  | 'footnotes'
  | 'simplify'
  | 'translate';

/** The queue job type each pass is persisted as. These strings live in queue.json. */
export type PassJobType =
  | 'foundry-scan'
  | 'foundry-ocr-correct'
  | 'foundry-footnotes'
  | 'simplify'
  | 'translate-pass';

/**
 * Who runs a text pass. 'local' is the bundled llama.cpp server — the app's own
 * default AI, and the only one that works with nothing configured — so a pass
 * that could not name it could not express what most runs actually use.
 */
export type PassAiProvider = 'ollama' | 'claude' | 'openai' | 'local';

export interface SimplifyPassParams {
  /** de-jargon | de-stiffen | language-learner. Validated by ai-bridge. */
  mode: 'dejargon' | 'destiffen' | 'learner';
  aiProvider: PassAiProvider;
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  customInstructions?: string;
  testMode?: boolean;
  testModeChunks?: number;
}

/**
 * Footnote removal's one option, and it belongs to EPUB mode only.
 *
 * `foundry footnotes --epub` skips two populations of prose by default — note
 * BODIES (a unit opening with an intra-book back-link, whose leading number is
 * the note's own label) and index entries (index-shaped units in a document
 * dense enough to BE an index). Both have the shape the model deletes without
 * carrying a marker, so asking about them is false-fire risk and nothing else.
 * `--ask-everything` turns those two skips off; the navigation skip is
 * structural and stays either way.
 */
export interface FootnotesPassParams {
  askEverything?: boolean;
}

export interface TranslatePassParams {
  sourceLang: string;
  targetLang: string;
  aiProvider: PassAiProvider;
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  translationPrompt?: string;
  customInstructions?: string;
}

/**
 * One pass, fully resolved. Everything decidable is decided when the chain is
 * planned — a job carries no "figure it out at run time" field, because a chain
 * that only discovers at step four that it cannot run has already spent hours.
 */
export interface PassJobConfig {
  kind: ProcessingPassKind;
  /** Absolute project directory. */
  projectDir: string;
  /** Project-relative stage dir this pass works and writes its diff in. */
  stageRelDir: string;
  /** Foundry passes: the PDF being read, absolute. */
  pdfPath?: string;
  /** Foundry passes: document pages, zero-based, in reading order. */
  pages?: number[];
  /** Foundry run identity. Defaults to the PDF's path. */
  bookKey?: string;
  /** Tesseract only: wipe the run directory and scan from scratch. */
  redo?: boolean;
  /**
   * This is the last foundry pass of its chain: export the book EPUB from the
   * run directory when it finishes, and record the passes that produced it.
   */
  exportAfter?: boolean;
  /**
   * The foundry passes this export materializes, in execution order, INCLUDING
   * this one. They cannot record themselves earlier: until the export runs, the
   * project has no book for a pass record to describe.
   */
  exportPasses?: Array<{ kind: ProcessingPassKind; diff?: string; params?: Record<string, unknown> }>;
  /**
   * Footnote removal only, and REQUIRED for it: which of its two modes this job
   * is. The pass has one name and two implementations, and which one runs is a
   * fact about the RUN (what the passes read), not about the job type — so the
   * planner decides it and the executor is never left to infer it from which
   * other fields happen to be set.
   *
   *  - `foundry-run` — a stage of the PDF chain. Reads the run directory the
   *    scan built, writes `footnotes/deletions.json`, and the book comes out of
   *    the export at the end of the chain.
   *  - `epub` — `foundry footnotes --epub` over the project's book EPUB,
   *    rewriting it in place like every other EPUB pass.
   */
  footnotesMode?: 'foundry-run' | 'epub';
  footnotes?: FootnotesPassParams;
  simplify?: SimplifyPassParams;
  translate?: TranslatePassParams;
}

export interface ChainPassRequest {
  kind: ProcessingPassKind;
  /** Tesseract only: start the scan over instead of resuming. */
  redo?: boolean;
  /** Footnote removal over an EPUB. Refused on a PDF run, where it means nothing. */
  footnotes?: FootnotesPassParams;
  simplify?: SimplifyPassParams;
  translate?: TranslatePassParams;
}

export interface ProcessingChainRequest {
  /** Either is enough; projectDir wins when both are given. */
  projectDir?: string;
  projectId?: string;
  /**
   * Which of the project's files the passes apply to. A variant id is what the
   * wizard's variant cards carry; an explicit path is for a caller that already
   * resolved one. Absent means the obvious file: the project's PDF for a chain
   * with foundry passes, its book EPUB otherwise.
   */
  variantId?: string;
  sourcePath?: string;
  /**
   * The foundry run identity, when the caller already has one it is watching.
   *
   * The pdf-picker keys a run by the document's file hash, and it paints the run
   * directory that key names. A chain submitted from that window must therefore
   * use the same key or the blocks land somewhere nothing is looking. Absent —
   * the wizard's case — the planner uses the source path, which is what the run
   * directory has always been keyed by for a project opened in place.
   */
  bookKey?: string;
  passes: ChainPassRequest[];
}

export interface PlannedPassJob {
  jobType: PassJobType;
  /** Row label for the queue. */
  label: string;
  config: PassJobConfig;
}

export interface ProcessingChainPlan {
  projectId: string;
  projectDir: string;
  title: string;
  /** The file the passes read: the PDF for a foundry chain, else the book EPUB. */
  sourcePath: string;
  /** Where the book EPUB is (or will be) when the chain finishes. */
  bookEpubPath: string;
  /** True when a foundry pass in this chain will (re)build the book EPUB. */
  producesEpub: boolean;
  jobs: PlannedPassJob[];
}

/** One pass that left a diff, as listed for Review Changes. */
export interface PassDiffEntry {
  kind: ProcessingPassKind;
  at: string;
  params?: Record<string, unknown>;
  /** Project-relative, forward slashes. */
  relPath: string;
  absPath: string;
}

export interface PassJobResult {
  success: boolean;
  /** The book EPUB, after the pass. Absent for a pass that produced no book. */
  outputPath?: string;
  error?: string;
}

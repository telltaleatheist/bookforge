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
 * The model they describe is in docs/DOCUMENT_PIPELINE.md.
 */

/**
 * The six things a run can do to a book, as document transformations.
 *
 * Every one of the first three is document-in → document-out, and each is named
 * for the document it produces rather than for the machinery inside it:
 *
 *  - `get-text` casts `<Original>.working.pdf` from the archive original and
 *    puts the words in it. For a scan that is Tesseract; for a PDF that already
 *    carries text it is one pass over the publisher's own layer. Open the
 *    result in any reader and the text selects.
 *  - `blocks` labels every block and writes the answer INTO that document as
 *    real PDF annotations. There is one detect.
 *  - `reflow` reads the working document and writes `<Original>.epub`. It is
 *    THE exporter — there is no second one and no gate choosing between them —
 *    and OCR correction happens inside it, on the KEPT lines only, so blocks
 *    the user culled cost zero GPU.
 *
 * `ocr-correction` and `detection` are gone as passes. Repair is a step of
 * Reflow, not a stage a user schedules; labelling is `blocks`. `tesseract` is
 * gone too: reading the pages is what `get-text` IS, rather than a phantom
 * pass beside it. All three survive in `AppliedPassKind` because a book records
 * what was done to it and those books exist.
 */
export type ProcessingPassKind =
  | 'get-text'
  | 'blocks'
  | 'reflow'
  | 'footnotes'
  | 'simplify'
  | 'translate';

/**
 * The queue job type each pass is persisted as. These strings live in queue.json.
 *
 * The `foundry-*` names for the scan chain are RETIRED (Aug 2026) along with the
 * run-directory model they described: `foundry-scan`, `foundry-ocr-correct`,
 * `foundry-ocr` and `foundry-detect`. A queue.json restored from before the
 * change carries rows of those types; they are failed on load with a message
 * naming the change, never run — nothing knows what they would do now.
 */
export type PassJobType =
  | 'document-get-text'
  | 'document-blocks'
  | 'document-reflow'
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

/** Reflow's options. Everything else it needs is in the working document. */
export interface ReflowPassParams {
  /**
   * Whole categories to drop from this export, e.g. `footnote`.
   *
   * A statement about THIS export rather than about the book — which is why it
   * is a pass parameter and not a document edit. Deleting the blocks is the
   * other way to say it, and that one is durable.
   */
  excludeCategories?: string[];
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
  /**
   * Which of the project's PDFs the document passes read.
   *
   * A project can hold several versions of a book, and the working document is
   * cast from ONE of them. The plan records which; the executor never picks.
   */
  variantId?: string;
  /** An absolute path the planner already resolved, inside the project. */
  sourcePath?: string;
  /**
   * Footnote removal only, and REQUIRED for it: which document it reads.
   *
   * The pass has one name and two implementations, and which one runs is a fact
   * about the RUN, not about the job type — so the planner decides it and the
   * executor is never left to infer it from which other fields happen to be set.
   *
   *  - `pdf` — `foundry footnotes --pdf` over the working document, rewriting
   *    its text layer. Scanned class only; foundry refuses to re-lay-out a
   *    publisher's page description from a parse of it.
   *  - `epub` — `foundry footnotes --epub` over the project's book, rewriting it
   *    in place. The DEFAULT for a scanned book, run after Reflow: the adapter
   *    measures 97.0% applied / 0.5% false-fire on clean text against
   *    90.5% / 2.1% on raw OCR text.
   */
  footnotesMode?: 'pdf' | 'epub';
  reflow?: ReflowPassParams;
  footnotes?: FootnotesPassParams;
  simplify?: SimplifyPassParams;
  translate?: TranslatePassParams;
}

export interface ChainPassRequest {
  kind: ProcessingPassKind;
  /** Footnote removal over an EPUB. Refused on a PDF run, where it means nothing. */
  footnotes?: FootnotesPassParams;
  reflow?: ReflowPassParams;
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
   * with document passes, its book EPUB otherwise.
   */
  variantId?: string;
  sourcePath?: string;
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
  /** The file the passes read: the PDF for a document chain, else the book EPUB. */
  sourcePath: string;
  /** Where the book EPUB is (or will be) when the chain finishes. */
  bookEpubPath: string;
  /** True when a Reflow pass in this chain will (re)build the book EPUB. */
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

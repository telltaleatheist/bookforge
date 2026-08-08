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
 */

/**
 * The two things a run can do to a book.
 *
 * Both are EPUB passes: they read `manifest.outputs.epub`, transform it, and
 * rename the result back onto the same path. A run therefore needs a book to
 * exist before it starts, and nothing in a run produces one.
 *
 * Making the book is not a pass and never was one of these: `foundry
 * vlm-convert` reads the pages and assembles them (electron/vlm-convert.ts),
 * which is a document STAGE — a book's origin rather than a transformation of
 * one. The Tesseract-era document passes (`get-text`, `blocks`, `reflow`) and
 * the AI footnote pass went with it in Aug 2026. They all survive in
 * `AppliedPassKind`, because a book records what was done to it and those books
 * exist.
 */
export type ProcessingPassKind = 'simplify' | 'translate';

/**
 * The queue job type each pass is persisted as. These strings live in queue.json.
 *
 * Every job type the removed passes used — `document-get-text`,
 * `document-blocks`, `document-reflow`, `foundry-footnotes`, and the
 * `foundry-*` scan-chain vocabulary before them — is RETIRED. A queue.json
 * restored from before the change carries rows of those types; they are failed
 * on load with a message naming the change, never run, because nothing knows
 * what they would do now.
 */
export type PassJobType = 'simplify' | 'translate-pass';

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
  simplify?: SimplifyPassParams;
  translate?: TranslatePassParams;
}

export interface ChainPassRequest {
  kind: ProcessingPassKind;
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
   * resolved one. Absent means the obvious file: the project's book EPUB.
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
  /** The book the passes read and rewrite. */
  sourcePath: string;
  /** Where the book EPUB is. The same file — a pass never moves it. */
  bookEpubPath: string;
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

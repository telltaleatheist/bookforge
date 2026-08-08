/**
 * vlm conversion — the second route from a PDF to this project's book.
 *
 * `foundry vlm-convert` hands each page picture to a document vision model
 * (dots.ocr) and takes back a description of the page: a box, a category and the
 * words, in reading order. Foundry assembles those into an EPUB and stamps every
 * element it writes with `data-bf-cat` (the model's own category) and
 * `data-bf-page` (the PDF page it was read from) — see foundry README
 * §vlm-convert. That EPUB is the COMPLETE book: footnotes collected at the end
 * of their chapter, figures cropped and embedded, captions kept.
 *
 * This module is the wire contract for driving that from BookForge, and it is
 * pure: the categories dots answers with, how they are said in BookForge's own
 * palette, and how one of foundry's progress lines is read. Main, preload and
 * the renderer all import it, so there is one spelling of each.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * It is not a processing PASS. A pass reads `manifest.outputs.epub`, transforms
 * it, and renames the result back onto the same path (docs/PROCESSING_PIPELINE_V2.md);
 * a conversion is where the book COMES FROM, so there is nothing to read and
 * nothing to diff against. It is a document stage — claimed, announced and
 * cancelled through the same registry the cast and the detect use — and the
 * chain planner never sees it.
 */

/**
 * The categories dots.ocr answers with, lower-cased, exactly as foundry stamps
 * them (`CATEGORY_ATTRIBUTE` in foundry src/vlm/dots-book.ts).
 *
 * `page-header` and `page-footer` are absent because foundry DROPS those blocks
 * — running heads and folios never reach the book — so no element can carry
 * them. Adding them here would describe a stamp that is never written.
 */
export const VLM_CATEGORIES = [
  'text',
  'title',
  'section-header',
  'footnote',
  'caption',
  'table',
  'picture',
  'quote',
  'formula',
  'list-item',
] as const;

export type VlmCategory = (typeof VLM_CATEGORIES)[number];

/**
 * dots' category → BookForge's block-category palette (shared/ocr/block-categories.ts).
 *
 * The two vocabularies were written for different jobs and the map is the whole
 * of the translation between them, stated once. Three of them need saying:
 *
 *  - `title` and `section-header` are foundry's two heading levels. BookForge
 *    has four (`title`, `chapter`, `heading`, `subheading`), and NOTHING here
 *    guesses which of the middle two a heading is: dots was not asked that
 *    question, so an answer would be invented. `title` → `title`,
 *    `section-header` → `heading`, and the user relabels a chapter opening in
 *    the picker where the page is in front of them.
 *  - `list-item` → `list`, which is BookForge's name for entry-per-line content.
 *  - `formula` has no counterpart, and that is a real gap rather than a missing
 *    value: a display equation is body content that is not a sentence. It goes
 *    to `body` — it IS narrated unless the user strikes it — and is named here
 *    so the choice is visible rather than buried in a `??`.
 *
 * A category outside this table is a disagreement between foundry and BookForge
 * about what the model can answer, and `blockCategoryForVlm` throws naming it.
 */
export const VLM_CATEGORY_TO_BLOCK: Readonly<Record<VlmCategory, string>> = {
  'text': 'body',
  'title': 'title',
  'section-header': 'heading',
  'footnote': 'footnote',
  'caption': 'caption',
  'table': 'table',
  'picture': 'image',
  'quote': 'quote',
  'formula': 'body',
  'list-item': 'list',
};

/**
 * The palette id for a `data-bf-cat` value, or a refusal naming it.
 *
 * Never a fallback: a stamp this app cannot read means the book was written by a
 * foundry that answers with categories this build does not know, and painting it
 * as body text would hide that behind a plausible screen.
 */
export function blockCategoryForVlm(stamped: string, whatFor: string): string {
  const mapped = VLM_CATEGORY_TO_BLOCK[stamped as VlmCategory];
  if (mapped === undefined) {
    throw new Error(
      `${whatFor}: an element is stamped data-bf-cat="${stamped}", which is not a category this `
      + `build of BookForge knows. The ten foundry's vlm-convert writes are `
      + `${VLM_CATEGORIES.join(', ')}. Update BookForge, or re-convert with the foundry it ships with.`
    );
  }
  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stage's user-facing name — the label the registry refuses a second run
 * with, the one the picker's progress modal shows, and the one that travels on
 * every `document:stage-*` message. Said once so those three cannot differ.
 */
export const VLM_CONVERT_STAGE = 'Convert to EPUB';

export interface VlmConvertRequest {
  /** Absolute project directory. */
  projectDir: string;
  /** The PDF variant to read, when the project holds more than one. */
  variantId?: string;
  /** An absolute PDF inside the project, when the caller already chose. */
  sourcePath?: string;
  /**
   * Which machine reads the pages. Absent, or carrying an empty `url`, means
   * MLX on THIS machine — see {@link VlmEndpointConfig}. The renderer owns the
   * setting (it lives in the same localStorage bundle as the Ollama URL) and
   * hands it over per run, exactly as `ollamaBaseUrl` travels on a job config.
   */
  endpoint?: VlmEndpointConfig;
}

export interface VlmConvertResult {
  /**
   * The server that read the pages, or null when MLX on this machine did.
   *
   * Reported rather than assumed: the two routes produce the same EPUB from the
   * same prompt at the same dpi, so nothing in the file says which GPU answered,
   * and "which one ran" is the first question about a book that came out wrong.
   */
  endpoint: string | null;
  /** Absolute path to the book that was written — also `manifest.outputs.epub`. */
  epubPath: string;
  /** Project-relative, forward slashes. */
  relPath: string;
  /** Pages the model was asked for in THIS run. Zero when everything resumed. */
  inferredPages: number;
  /** Every page of the PDF. */
  totalPages: number;
  /**
   * Pages that are NOT in the book, each with foundry's own reason. Never
   * silent: a page the model could not read is a page of the user's book that
   * is missing, and it is reported rather than absorbed.
   */
  unreadable: Array<{ page: number; reason: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which machine reads the pages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The endpoint setting: one shape, persisted and on the wire.
 *
 * MLX holds the model in a Python process on THIS machine and reads one page at
 * a time, which is what Apple silicon can do — and it is all Apple silicon can
 * do, so on every other machine there is no local route at all. `--vlm-endpoint`
 * points foundry at an OpenAI-compatible server instead (a vLLM on a 3090 reads
 * twelve at a time); everything else about the run — the verbatim prompt, the
 * 200 dpi render, the dialect — is identical by design. See foundry
 * src/vlm/endpoint.ts.
 *
 * Every field is REQUIRED and its unset value is stated, so there is no second
 * shape for "the parts the user filled in" and nothing has to guess whether an
 * absent field means default-or-forgotten. Python is still needed on this
 * machine either way: with an endpoint foundry puts its helper in render-only
 * mode, and PyMuPDF is what turns a page into a picture.
 */
export interface VlmEndpointConfig {
  /** '' = read the pages here with MLX. Otherwise an OpenAI-compatible base URL. */
  url: string;
  /** '' = the name foundry's own registry entry for the model carries. */
  model: string;
  /** 0 = foundry's default, {@link DEFAULT_VLM_CONCURRENCY}. */
  concurrency: number;
}

/** Nothing configured: the local route, which is the default on Apple silicon. */
export const DEFAULT_VLM_ENDPOINT_CONFIG: VlmEndpointConfig = {
  url: '',
  model: '',
  concurrency: 0,
};

/**
 * foundry's default pages-in-flight, mirrored here so the placeholder in
 * Settings states the real number rather than a remembered one. It is the
 * measured knee on the machine foundry was built against
 * (`DEFAULT_VLM_CONCURRENCY`, foundry src/vlm/endpoint.ts) and it is an option
 * precisely because it is a property of somebody else's GPU.
 */
export const DEFAULT_VLM_CONCURRENCY = 12;

/**
 * The configured endpoint, or null for the local route — and a refusal BY NAME
 * for anything in between.
 *
 * Throws rather than repairing: a URL with a typo in it, silently dropped, is a
 * ninety-minute run on the wrong machine — or, on Windows, a Python traceback
 * about MLX that names nothing the user set. Half a setting (a model name, a
 * concurrency) with no URL is refused for the same reason: it can only mean the
 * user believes a server is being used, and it is not.
 */
export function resolveVlmEndpoint(
  config: VlmEndpointConfig | null | undefined,
): VlmEndpointConfig | null {
  if (!config) return null;

  const url = (config.url ?? '').trim();
  const model = (config.model ?? '').trim();
  const concurrency = config.concurrency ?? 0;

  if (url.length === 0) {
    if (model.length > 0) {
      throw new Error(
        `A VLM endpoint model name ("${model}") is set with no endpoint URL, so nothing would be `
        + 'sent to a server and the pages would be read on this machine instead. Set the URL in '
        + 'Settings → AI → Reading pages, or clear the model name.'
      );
    }
    if (concurrency !== 0) {
      throw new Error(
        `A VLM endpoint concurrency (${concurrency}) is set with no endpoint URL. Pages in flight `
        + 'is a property of the server; the local route reads one page at a time. Set the URL in '
        + 'Settings → AI → Reading pages, or clear the concurrency.'
      );
    }
    return null;
  }

  if (!/^https?:\/\/[^\s]+$/.test(url)) {
    throw new Error(
      `"${url}" is not a URL a VLM endpoint can be reached at. It is the base URL of an `
      + 'OpenAI-compatible server, e.g. http://127.0.0.1:8000/v1. Set it in '
      + 'Settings → AI → Reading pages.'
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 0) {
    throw new Error(
      `A VLM endpoint concurrency of ${concurrency} is not a whole number of pages. Leave it at 0 `
      + `for foundry's default of ${DEFAULT_VLM_CONCURRENCY}, or set how many pages the server `
      + 'should have in flight at once.'
    );
  }

  return { url, model, concurrency };
}

/**
 * `foundry vlm-convert`'s endpoint flags, or nothing at all for the local route.
 *
 * A flag is passed only when the user set the thing it carries: foundry's own
 * defaults for the model name and the concurrency are the answer otherwise, and
 * repeating them here would freeze this build's copy of a number that belongs to
 * foundry.
 */
export function vlmEndpointArgs(endpoint: VlmEndpointConfig | null): string[] {
  if (endpoint === null) return [];
  const args = ['--vlm-endpoint', endpoint.url];
  if (endpoint.model.length > 0) args.push('--vlm-endpoint-model', endpoint.model);
  if (endpoint.concurrency > 0) args.push('--vlm-concurrency', String(endpoint.concurrency));
  return args;
}

/**
 * Why this machine cannot read the pages by itself, or null when it can.
 *
 * MLX is Metal, and Metal on a Mac with an Intel chip is not the runtime
 * mlx-vlm needs, so the honest test is darwin AND arm64. Called BEFORE anything
 * is spawned when no endpoint is configured: the alternative is a user watching
 * a progress modal for the time it takes Python to import mlx and then reading a
 * traceback that names a library they have never heard of.
 *
 * Pure, and given the platform rather than reading it, so the sentence a Windows
 * user will see can be tested on a Mac.
 */
export function vlmLocalReadingRefusal(platform: string, arch: string): string | null {
  if (platform === 'darwin' && arch === 'arm64') return null;
  return (
    'Reading the pages on this machine needs an Apple Silicon Mac — the local reader is MLX, '
    + `which runs on Metal and nothing else, and this machine is ${platform}/${arch}. `
    + 'Point BookForge at a vLLM (or any OpenAI-compatible) server that serves the document '
    + 'vision model: Settings → AI → Reading pages. Nothing was converted.'
  );
}

/** How the run is described while it happens: which GPU is reading the pages. */
export function vlmRouteLabel(endpoint: VlmEndpointConfig | null): string {
  return endpoint === null
    ? 'this machine (MLX)'
    : endpoint.url;
}

/**
 * Where an OpenAI-compatible server lists what it serves.
 *
 * The trailing slash is stripped the same way foundry strips it when it builds
 * `/chat/completions` (src/vlm/endpoint.ts), so a URL that works for the Test
 * button is a URL that works for the run.
 */
export function vlmEndpointModelsUrl(url: string): string {
  return `${url.trim().replace(/\/+$/, '')}/models`;
}

/** What pressing Test found. Never a boolean alone — a failure names itself. */
export interface VlmEndpointCheck {
  /** True when the server answered its model list. */
  reachable: boolean;
  /** Everything the server says it serves, in the order it listed them. */
  models: string[];
  /** The exact failure, when it did not answer. */
  error?: string;
  /**
   * The configured model name is not in the list. Reachable, but the run would
   * be refused by the server — worth saying now rather than in ninety minutes.
   */
  modelMissing?: string;
}

/**
 * What the Test button says, from what came back. Pure so the sentence is
 * testable without a server.
 */
export function describeVlmEndpointCheck(url: string, check: VlmEndpointCheck): string {
  if (!check.reachable) {
    return `${url} did not answer: ${check.error ?? 'no reason given'}`;
  }
  if (check.modelMissing !== undefined) {
    return (
      `${url} is up but does not serve "${check.modelMissing}". It serves: `
      + `${check.models.join(', ') || 'nothing'}.`
    );
  }
  if (check.models.length === 0) {
    return `${url} answered, but lists no models. Start the server with the document VLM loaded.`;
  }
  return `${url} is serving ${check.models.join(', ')}.`;
}

/**
 * What one of foundry's stderr lines says about how far the run has got, or null
 * when it says nothing about progress.
 *
 * Pure, so it can be tested against real lines without spawning anything. Two
 * shapes carry a page count, and they are the two routes through
 * `vlmConvert`:
 *
 *   vlm-convert: page 3/317 — 1300x2112, 4210 chars, …     (MLX, local)
 *   vlm-convert: page 12 (4/40) — 3980 chars, …            (an endpoint)
 *
 * The endpoint form counts pages IT was asked for, which is the honest total
 * for a resumed run — the pages already banked in the readings file are not
 * being read again and a bar that counted them would sit still at the start.
 */
export interface VlmProgressLine {
  done: number;
  total: number;
  message: string;
}

export function parseVlmProgressLine(line: string): VlmProgressLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('vlm-convert:')) return null;

  // The endpoint form is checked first: it also contains "page N", and reading
  // it with the MLX pattern would report the PDF page number as a count.
  const viaEndpoint = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/.exec(trimmed);
  if (viaEndpoint) {
    return { done: Number(viaEndpoint[1]), total: Number(viaEndpoint[2]), message: trimmed };
  }

  const local = /\bpage\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (local) {
    return { done: Number(local[1]), total: Number(local[2]), message: trimmed };
  }

  return null;
}

/**
 * blockcat-bridge — talk to the resident block-category model.
 *
 * The fine-tuned adapter runs on the training box's GPU (see
 * tools/aligner/blockcat-serve.py), so this is a thin HTTP client: the renderer
 * builds the prompts with blockcat-encoder.ts, main forwards them, and the
 * predictions come back as text for the renderer to parse.
 *
 * Main deliberately does NOT understand the prompt format. A fine-tune only
 * performs on the exact format it was trained on, so there is exactly one
 * implementation of that format (the encoder) and everything else moves opaque
 * strings. A "helpful" reformat here would degrade the model in a way that
 * looks like a bad model rather than a bad wire hop.
 *
 * Errors are returned, never swallowed: a page that failed to classify must
 * look different from a page the model thinks is empty.
 */

export interface BlockcatPagePrompt {
  system: string;
  user: string;
  /** The fully-templated string, for runtimes we drive in raw mode. */
  raw?: string;
}

/**
 * Where the model runs.
 *
 * `ollama` is the local path: the merged model is imported as an Ollama model
 * and generated RAW, with Ollama's own prompt template switched off. That is
 * not a detail — the fine-tune was trained under Qwen3's template with
 * thinking disabled, which emits an empty `<think></think>` block that
 * Ollama's stock template does not, so letting Ollama build the prompt would
 * silently feed the model a shape it never saw.
 *
 * `service` is the remote path: tools/aligner/blockcat-serve.py holding the
 * adapter resident on the training box's GPU. Kept because it needs no
 * conversion step, which makes it the fastest way to try a fresh checkpoint.
 */
export type BlockcatBackend = 'ollama' | 'service';

export interface BlockcatClassifyRequest {
  endpoint: string;
  pages: BlockcatPagePrompt[];
  batch?: number;
  backend?: BlockcatBackend;
  /** Ollama model name, e.g. "blockcat-v2". Required when backend is ollama. */
  model?: string;
  /** Token the model ends an answer with; Ollama stops generating there. */
  stop?: string;
  /** Context window. Must exceed the longest prompt or Ollama truncates it. */
  numCtx?: number;
  /**
   * How long Ollama should hold the model after a request, in seconds.
   *
   * A DEAD-MAN'S SWITCH, not an optimisation. `blockcatUnload` on quit only
   * fires on an orderly quit — a crash, a force-quit or a main-process restart
   * leaves several GB resident with nothing left alive that knows it is there.
   * Refreshing a short TTL on every request inverts that: the model's life is
   * bounded by time-since-last-request, so it goes away on its own whether or
   * not anything survives to clean up.
   *
   * Must exceed the gap between requests within a run or the model unloads
   * mid-book and every chunk pays a reload. A chunk of 8 pages measures ~10 s,
   * so the default has a wide margin over that and still releases the memory a
   * minute after the app stops asking.
   */
  keepAliveSeconds?: number;
}

/** See `keepAliveSeconds`. */
const DEFAULT_KEEP_ALIVE_SECONDS = 60;

export interface BlockcatClassifyResult {
  success: boolean;
  answers?: string[];
  error?: string;
}

export interface BlockcatModelsResult {
  success: boolean;
  models?: string[];
  error?: string;
}

export interface BlockcatHealthResult {
  success: boolean;
  adapter?: string;
  loaded?: boolean;
  error?: string;
}

/**
 * What Ollama currently holds. Drives the model picker, so the user chooses
 * from what exists instead of typing a name that may not.
 */
export async function blockcatModels(endpoint: string): Promise<BlockcatModelsResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${base(endpoint)}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { models?: Array<{ name?: string }> };
    return {
      success: true,
      models: (body.models ?? []).map(m => m.name ?? '').filter(Boolean).sort(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * The last Ollama model this app asked to be loaded, so it can be released on
 * quit. Ollama keeps a model resident on its own idle timer — several GB for
 * this one — and closing BookForge is a clear signal we are done with it.
 */
let lastOllamaLoad: { endpoint: string; model: string } | null = null;

/**
 * Ask Ollama to drop the model now. `keep_alive: 0` with an empty prompt is
 * Ollama's documented unload: it loads nothing and expires the resident copy
 * immediately.
 *
 * Best-effort by design — this runs during quit, and a shutdown must not be
 * held up (or aborted) because Ollama is already gone or slow to answer.
 */
export async function blockcatUnload(
  endpoint?: string,
  model?: string,
): Promise<{ success: boolean; error?: string }> {
  const target = endpoint && model ? { endpoint, model } : lastOllamaLoad;
  if (!target) return { success: true };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${base(target.endpoint)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.model, keep_alive: 0 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    lastOllamaLoad = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Trailing slashes would produce `//classify`, which the service 404s. */
function base(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export async function blockcatHealth(
  endpoint: string,
  backend: BlockcatBackend = 'service',
  model?: string,
): Promise<BlockcatHealthResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    if (backend === 'ollama') {
      const res = await fetch(`${base(endpoint)}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const body = await res.json() as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map(m => m.name ?? '');
      if (!model) return { success: true, adapter: '', loaded: false };
      // Ollama reports "name:tag"; a bare name should still match its :latest.
      const found = names.some(n => n === model || n.split(':')[0] === model.split(':')[0]);
      if (!found) {
        return {
          success: false,
          error: `Ollama has no model "${model}". Available: ${names.join(', ') || '(none)'}`,
        };
      }
      return { success: true, adapter: model, loaded: true };
    }

    const res = await fetch(`${base(endpoint)}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { adapter?: string; loaded?: boolean };
    return { success: true, adapter: body.adapter, loaded: body.loaded };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Ollama generates one prompt per call, so pages go through in sequence. That
 * is honest about the hardware rather than a limitation: a single GPU/Metal
 * device serializes the work anyway, and batching here would only move the
 * queue.
 */
async function classifyViaOllama(
  req: BlockcatClassifyRequest,
): Promise<BlockcatClassifyResult> {
  if (!req.model) return { success: false, error: 'no Ollama model name given' };
  lastOllamaLoad = { endpoint: req.endpoint, model: req.model };
  const answers: string[] = [];
  for (const page of req.pages) {
    const prompt = page.raw;
    if (!prompt) {
      // Never fall back to letting Ollama template it — that is precisely the
      // mismatch this path exists to avoid.
      return { success: false, error: 'page is missing its raw templated prompt' };
    }
    const res = await fetch(`${base(req.endpoint)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        prompt,
        raw: true,          // our template, not Ollama's
        stream: false,
        // Refreshed on every page, so the model expires this long after the app
        // stops asking — including when the app stopped asking because it died.
        keep_alive: `${req.keepAliveSeconds ?? DEFAULT_KEEP_ALIVE_SECONDS}s`,
        options: {
          temperature: 0,   // classification: greedy, never sampled
          num_predict: 2048,
          // Set EXPLICITLY, for correctness before economy. Ollama otherwise
          // takes the context from the GGUF metadata — 40960 for this model —
          // and allocates a KV cache to match, which measured ~6 GB of the
          // ~8.5 GB the model held. Worse, on a host configured with a SMALLER
          // default, a prompt over that limit is silently TRUNCATED: the model
          // would answer about a page whose first blocks it never saw, and
          // nothing would report an error. The longest real page measures
          // 6,529 tokens, so 8192 covers it with room for the answer.
          num_ctx: req.numCtx ?? 8192,
          stop: req.stop ? [req.stop] : undefined,
        },
      }),
    });
    const body = await res.json() as { response?: string; error?: string };
    if (!res.ok || body.error) {
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }
    answers.push(body.response ?? '');
  }
  return { success: true, answers };
}

/**
 * Classify a batch of pages. No timeout: a book is hundreds of pages and the
 * GPU serializes them, so a wall-clock limit here would abort real work. The
 * caller decides how much to send at once and reports progress between calls.
 */
export async function blockcatClassify(
  req: BlockcatClassifyRequest,
): Promise<BlockcatClassifyResult> {
  if (!req.pages?.length) {
    return { success: false, error: 'no pages to classify' };
  }
  if (req.backend === 'ollama') {
    try {
      return await classifyViaOllama(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `cannot reach ${base(req.endpoint)}: ${msg}` };
    }
  }
  try {
    const res = await fetch(`${base(req.endpoint)}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: req.pages, batch: req.batch }),
    });
    const body = await res.json() as { answers?: string[]; error?: string };
    if (!res.ok) {
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }
    if (!Array.isArray(body.answers) || body.answers.length !== req.pages.length) {
      // A short reply would silently misalign answers with pages — every page
      // after the gap would take its neighbour's labels.
      return {
        success: false,
        error: `service returned ${body.answers?.length ?? 0} answers for ${req.pages.length} pages`,
      };
    }
    return { success: true, answers: body.answers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `cannot reach ${base(req.endpoint)}: ${msg}` };
  }
}

/**
 * blocks-bridge — talk to the resident block-category model.
 *
 * The fine-tuned adapter runs on the training box's GPU (see
 * tools/aligner/blocks-serve.py), so this is a thin HTTP client: the renderer
 * builds the prompts with blocks-encoder.ts, main forwards them, and the
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

export interface BlocksPagePrompt {
  system: string;
  user: string;
  /** The fully-templated string, for runtimes we drive in raw mode. */
  raw?: string;
}

/**
 * Where the model runs.
 *
 * `local` is the DEFAULT and the shipping path: the downloaded GGUF served by
 * the bundled llama-server (blocks-server.ts). Nothing to install, nothing to
 * import by hand — Settings downloads the model and Detect works.
 *
 * `ollama` is the legacy local path, kept for anyone who already imported the
 * model into Ollama. It generates RAW, with Ollama's own prompt template
 * switched off. That is not a detail — the fine-tune was trained under Qwen3's
 * template with thinking disabled, which emits an empty `<think></think>` block
 * that Ollama's stock template does not, so letting Ollama build the prompt
 * would silently feed the model a shape it never saw. `local` avoids the whole
 * question by using /completion, which has no template.
 *
 * `service` is the remote path: tools/aligner/blocks-serve.py holding the
 * adapter resident on the training box's GPU. Kept because it needs no
 * conversion step, which makes it the fastest way to try a fresh checkpoint.
 */
export type BlocksBackend = 'local' | 'ollama' | 'service';

export interface BlocksClassifyRequest {
  endpoint: string;
  pages: BlocksPagePrompt[];
  batch?: number;
  backend?: BlocksBackend;
  /** Ollama model name, e.g. "blocks-v2". Required when backend is ollama. */
  model?: string;
  /** Token the model ends an answer with; Ollama stops generating there. */
  stop?: string;
  /** Context window. Must exceed the longest prompt or Ollama truncates it. */
  numCtx?: number;
  /**
   * How long Ollama should hold the model after a request, in seconds.
   *
   * A DEAD-MAN'S SWITCH, not an optimisation. `blocksUnload` on quit only
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

export interface BlocksClassifyResult {
  success: boolean;
  answers?: string[];
  error?: string;
}

export interface BlocksModelsResult {
  success: boolean;
  models?: string[];
  /**
   * Prompt format per model id, for the models this app publishes.
   *
   * THE CATALOG ANSWERS, THE ID NEVER DOES. `foundry-blocks-v1-4b` names release
   * 1 of a stage and ships the v5 prompt; parsing `v1` out of it would serve the
   * retired sixteen-class prompt to a twelve-class model, which scores worse
   * without erroring. Only the `local` backend can populate this — an Ollama or
   * remote-service model is somebody's own checkpoint and all we have is its name.
   */
  promptVersions?: Record<string, number>;
  error?: string;
}

export interface BlocksHealthResult {
  success: boolean;
  adapter?: string;
  loaded?: boolean;
  /** The catalog's declared prompt version for `adapter` — see BlocksModelsResult. */
  promptVersion?: number;
  error?: string;
}

/**
 * What Ollama currently holds. Drives the model picker, so the user chooses
 * from what exists instead of typing a name that may not.
 */
export async function blocksModels(
  endpoint: string,
  backend: BlocksBackend = 'ollama',
): Promise<BlocksModelsResult> {
  // The bundled path's model list is what has been DOWNLOADED, from the catalog
  // — not what some server happens to hold. Detect's dropdown should offer the
  // models this machine can actually run.
  if (backend === 'local') {
    const { listBlocksModels } = await import('./blocks-models.js');
    const present = listBlocksModels().filter(m => m.present);
    return {
      success: true,
      models: present.map(m => m.id),
      promptVersions: Object.fromEntries(present.map(m => [m.id, m.promptVersion])),
    };
  }
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
export async function blocksUnload(
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

export async function blocksHealth(
  endpoint: string,
  backend: BlocksBackend = 'service',
  model?: string,
): Promise<BlocksHealthResult> {
  try {
    // The bundled path answers from DISK, not from a running server: the health
    // question here is "can this machine classify?", and a downloaded model that
    // has not been loaded yet answers yes. Requiring a live server would mean
    // spending 30 s of model load just to populate a status line, every time the
    // panel opens.
    if (backend === 'local') {
      const { getBlocksModelDef, isBlocksModelPresent, bestInstalledBlocksModel } =
        await import('./blocks-models.js');
      const wanted = model || bestInstalledBlocksModel()?.id || '';
      if (!wanted) {
        return { success: false, error: 'no page-layout model is installed yet' };
      }
      const def = getBlocksModelDef(wanted);
      if (!def) return { success: false, error: `unknown page-layout model "${wanted}"` };
      if (!isBlocksModelPresent(wanted)) {
        return { success: false, error: `"${def.name}" is not downloaded yet` };
      }
      // `adapter` names the model; `promptVersion` is what the encoder must build
      // for, and it comes from the CATALOG because a foundry id names a release
      // rather than a prompt format. See BlocksModelDef.promptVersion.
      return { success: true, adapter: wanted, loaded: true, promptVersion: def.promptVersion };
    }

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
  req: BlocksClassifyRequest,
): Promise<BlocksClassifyResult> {
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
export async function blocksClassify(
  req: BlocksClassifyRequest,
): Promise<BlocksClassifyResult> {
  if (!req.pages?.length) {
    return { success: false, error: 'no pages to classify' };
  }
  if (req.backend === 'local') {
    // The bundled llama-server. Lazily imported so the Ollama/service paths do
    // not pull in the server lifecycle (and its GPU-arbiter dependency).
    const { blocksServer } = await import('./blocks-server.js');
    const prompts: string[] = [];
    for (const page of req.pages) {
      if (!page.raw) {
        // Same rule as the Ollama path: never let the server template it.
        return { success: false, error: 'page is missing its raw templated prompt' };
      }
      prompts.push(page.raw);
    }
    return blocksServer.generate(req.model || '', prompts, req.stop);
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

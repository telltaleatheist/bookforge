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
}

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
        options: {
          temperature: 0,   // classification: greedy, never sampled
          num_predict: 2048,
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

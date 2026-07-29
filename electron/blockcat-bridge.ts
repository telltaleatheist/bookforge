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
}

export interface BlockcatClassifyRequest {
  endpoint: string;
  pages: BlockcatPagePrompt[];
  batch?: number;
}

export interface BlockcatClassifyResult {
  success: boolean;
  answers?: string[];
  error?: string;
}

export interface BlockcatHealthResult {
  success: boolean;
  adapter?: string;
  loaded?: boolean;
  error?: string;
}

/** Trailing slashes would produce `//classify`, which the service 404s. */
function base(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export async function blockcatHealth(endpoint: string): Promise<BlockcatHealthResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
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

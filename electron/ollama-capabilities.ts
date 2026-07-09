/**
 * Ollama model-capability negotiation.
 *
 * Some models (e.g. qwen3) are "thinking" models: by default Ollama lets them
 * emit a chain-of-thought before the answer, which burns most of the generation
 * budget on tokens we throw away. Ollama's /api/generate accepts a top-level
 * `think: false` to disable that — but only models whose /api/show capabilities
 * include 'thinking' actually honor it, so we probe once per (baseUrl, model)
 * and cache the answer in-memory.
 *
 * Empirical notes (Ollama 0.31.2, 2026-07-08):
 *  - cogito:8b/14b/32b report capabilities ['completion','tools'] — NO 'thinking'.
 *    Their <think> mode is triggered purely by the chat template when the system
 *    prompt contains 'Enable deep thinking subroutine.' (none of our prompts do),
 *    so cogito does NOT think on the /api/generate path by default, and
 *    `think:false` is accepted (HTTP 200) but has no effect on it either way.
 *  - qwen3:32b reports ['completion','tools','thinking'] and thinks by default,
 *    so it gets `think:false` from this helper.
 *
 * This is explicit capability negotiation (probe + log + cache), not a silent
 * fallback: a model that doesn't report the capability simply has no `think`
 * field to send, and a failed probe (Ollama unreachable, unknown model) throws
 * so the caller fails loudly before wasting a generation.
 */

// Cache successful probes only; a failed probe is removed so the next call
// retries instead of pinning an error forever.
const thinkingCapabilityCache = new Map<string, Promise<boolean>>();

async function probeThinkingCapability(baseUrl: string, model: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/show for '${model}' returned HTTP ${response.status}`);
  }
  const data = await response.json() as { capabilities?: unknown };
  // Older Ollama versions don't report capabilities at all — that means the
  // server predates the `think` request field too, so not sending it is the
  // correct negotiated outcome (logged below), not a fallback.
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities as string[] : [];
  const supportsThinking = capabilities.includes('thinking');
  console.log(
    `[OLLAMA-CAPS] ${model} capabilities: [${capabilities.join(', ')}] — ` +
    (supportsThinking ? 'thinking model, sending think:false' : 'no thinking capability, omitting think field')
  );
  return supportsThinking;
}

/**
 * Whether the model reports the 'thinking' capability. Probes /api/show once
 * per (baseUrl, model) and caches the result for the process lifetime.
 */
export async function ollamaModelSupportsThinking(baseUrl: string, model: string): Promise<boolean> {
  const key = `${baseUrl}::${model}`;
  let cached = thinkingCapabilityCache.get(key);
  if (!cached) {
    cached = probeThinkingCapability(baseUrl, model);
    // Drop failed probes from the cache so transient errors don't stick.
    cached.catch(() => thinkingCapabilityCache.delete(key));
    thinkingCapabilityCache.set(key, cached);
  }
  return cached;
}

/**
 * Top-level request fields to merge into an Ollama /api/generate body:
 * `{ think: false }` for thinking-capable models, `{}` otherwise.
 * Spread into the request body: `{ model, prompt, ...(await getOllamaThinkFields(...)) }`.
 */
export async function getOllamaThinkFields(baseUrl: string, model: string): Promise<{ think?: false }> {
  return (await ollamaModelSupportsThinking(baseUrl, model)) ? { think: false } : {};
}

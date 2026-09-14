/**
 * tts-number-normalizer-runner.ts — the LIVE model behind the number pass.
 *
 * Kept apart from `tts-number-normalizer.ts` on purpose. That file is the pass:
 * selection, validation, the cache, the record — pure enough that every one of
 * its dispositions is reachable from a test with a scripted answer and no GPU.
 * This file is the one place that dials a model, so the test never loads it and
 * never risks a request going out.
 *
 * ── IT OWNS ITS OWN OLLAMA DOOR NOW, AND THAT IS THE POINT ────────────────
 *
 * It used to borrow `generateEditListWithOllama` from `ai-bridge.ts`. Phase 15
 * (crucible `docs/PHASE15-HOST.md` §5.3) took Ollama out of BookForge as a
 * PROVIDER: an Ollama server is an upstream the ENGINE is configured with, and
 * no text door in this app dials one any more.
 *
 * This pass is the exception, and it is an exception because of WHO IT SERVES,
 * not because of what it talks to. It runs between the narration cut and the
 * LEGACY narrator spawn (`parallel-tts-bridge.ts`, its only caller), on this
 * machine's own model, with the GPU arbiter evicting it before e2a takes the
 * card. It belongs to the legacy local spawn layer, which is deleted whole
 * after Owen's in-app pass (crucible PHASE15 §6, `docs/CRUCIBLE_ROLLOUT_PLAN.md`
 * A2) — and the request it makes therefore MOVED here rather than being kept
 * alive in a bridge that no longer has providers. One owner, and it dies with
 * the layer that needs it.
 *
 * What moved is the minimum: one non-streaming `/api/generate`, the
 * `think:false` capability probe (qwen3.5 is a thinking model and would
 * otherwise spend the whole budget on reasoning this pass throws away), and
 * `extractAnswer`, which is not an Ollama thing and stays where it is.
 */
import { estimateNumCtxForBudget, extractAnswer } from './ai-bridge.js';
import { getConfig } from './tool-paths.js';
import { DEFAULT_NORMALIZER_MODEL } from './tts-number-normalizer.js';
import type { NumberNormalizerRunner } from './tts-number-normalizer.js';

/**
 * The Ollama this pass dials. Not configurable, and deliberately so: the pass
 * is a local-GPU pass by design and there is no provider to choose.
 */
const LEGACY_OLLAMA_BASE_URL = 'http://localhost:11434';

/**
 * Does this model know `think`?
 *
 * A thinking model handed no `think:false` spends a 2048-token budget on a
 * chain of thought this pass discards, and answers nothing. A model that does
 * NOT know the field refuses the request outright if it is sent. So it is
 * ASKED — `/api/show`'s capabilities — rather than guessed from the tag, and
 * an unreadable answer sends nothing, which is the behaviour a model without
 * the field needs.
 */
async function thinkFieldsFor(model: string): Promise<{ think?: false }> {
  const response = await fetch(`${LEGACY_OLLAMA_BASE_URL}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) return {};
  const data = await response.json() as { capabilities?: unknown };
  const capabilities = data.capabilities;
  return Array.isArray(capabilities) && capabilities.includes('thinking') ? { think: false } : {};
}

/**
 * One edit-list request: a JSON answer, extracted.
 *
 * `numCtx` is the caller's, sized once with `estimateNumCtxForBudget`, because
 * Ollama reloads the runner on ANY num_ctx change and a per-passage estimate
 * would churn a 6-17 GB model in and out between paragraphs.
 */
async function askLegacyOllama(
  model: string,
  systemPrompt: string,
  input: string,
  options: { numCtx: number; numPredict: number; temperature: number; abortSignal?: AbortSignal },
): Promise<string> {
  const response = await fetch(`${LEGACY_OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      prompt: input,
      stream: false,
      ...(await thinkFieldsFor(model)),
      keep_alive: '5m',
      options: {
        temperature: options.temperature,
        num_ctx: options.numCtx,
        num_predict: options.numPredict,
      },
    }),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `The number-normalization model refused the request (${response.status} `
      + `${response.statusText}). ${model} is asked on ${LEGACY_OLLAMA_BASE_URL}, which is this `
      + 'machine\'s own Ollama.',
    );
  }
  const data = await response.json() as { response?: unknown };
  if (typeof data.response !== 'string') {
    throw new Error('The number-normalization model answered without a `response` field.');
  }
  return extractAnswer(data.response, model);
}

/**
 * num_predict for one passage.
 *
 * The answer is a handful of `{find, replace}` pairs and nothing else — no
 * in-band thinking, because the pass sends `think:false` to a thinking model —
 * so this is sized for the JSON alone with room for a paragraph that is one long
 * list of dates. `EDITLIST_NUM_PREDICT`'s 6144 is a budget for cogito's
 * chain-of-thought and would size every window three times larger than this pass
 * needs, at a cost paid on every request.
 */
const NUMBER_NUM_PREDICT = 2048;

/**
 * Temperature ZERO, and not the cleanup pass's 0.1.
 *
 * "June 12, 1933" has exactly one standard American reading. Sampling here would
 * buy nothing and would mean the same heading could come back read two ways in
 * one book — which is the divergence the heading/contents reconciliation exists
 * to prevent, reintroduced at the source.
 */
const NUMBER_TEMPERATURE = 0;

/**
 * The model tag this pass will use: the Settings value, or the declared default.
 *
 * The tag is read ONCE per job and carried, because it is part of the cache
 * path — a run that read it twice could name the copy after one model and make
 * it with another.
 */
export function numberNormalizerModel(): string {
  const stated = getConfig().ttsNumberNormalizerModel;
  if (typeof stated === 'string' && stated.trim() !== '') return stated.trim();
  return DEFAULT_NORMALIZER_MODEL;
}

/** The live runner: Ollama for the answers, the GPU arbiter for the VRAM. */
export function createOllamaNormalizerRunner(
  model: string,
  abortSignal?: AbortSignal,
): NumberNormalizerRunner {
  // Sized on the first (and only) `pinContextTo`, then pinned for the book. Left
  // at 0 until then so a request made before sizing is a loud failure rather
  // than a quiet window of the wrong size.
  let numCtx = 0;
  return {
    model,
    pinContextTo(systemPrompt: string, longestInput: string): void {
      numCtx = estimateNumCtxForBudget(systemPrompt, longestInput, NUMBER_NUM_PREDICT, model);
    },
    async generate(input: string, systemPrompt: string): Promise<string> {
      if (numCtx === 0) {
        throw new Error(
          'The number-normalization pass asked the model a question before sizing its context '
          + 'window. This is a bug in the pass, not something you did.'
        );
      }
      return askLegacyOllama(model, systemPrompt, input, {
        numCtx, numPredict: NUMBER_NUM_PREDICT, temperature: NUMBER_TEMPERATURE, abortSignal,
      });
    },
    async release(): Promise<void> {
      // Best-effort, `releaseCleanupModel`'s rule: a failed unload must never
      // fail a pass that finished. The VRAM preflight in gpu-arbiter is the
      // backstop, and e2a's own launch gate is the one after that.
      try {
        const { unloadOllamaModel } = await import('./gpu-arbiter.js');
        await unloadOllamaModel(model);
        console.log(`[TTS-NUMBERS] Released ${model} from VRAM — e2a takes the GPU next.`);
      } catch (err) {
        console.warn(`[TTS-NUMBERS] Could not release ${model} from VRAM: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * tts-number-normalizer-runner.ts — the LIVE model behind the number pass.
 *
 * Kept apart from `tts-number-normalizer.ts` on purpose. That file is the pass:
 * selection, validation, the cache, the record — pure enough that every one of
 * its dispositions is reachable from a test with a scripted answer and no GPU.
 * This file is the one place that dials a model, so the test never loads it and
 * never risks a request going out.
 *
 * It is a THIN binding, not a second implementation: the request goes through
 * `generateEditListWithOllama`, which goes through `callProviderExtracted` and
 * `cleanChunk` — the same `think:false` capability probe, the same streaming
 * inactivity timeout and the same `<answer>` extraction as every other edit-list
 * call in the app.
 */
import { estimateNumCtxForBudget, generateEditListWithOllama } from './ai-bridge.js';
import { getConfig } from './tool-paths.js';
import { DEFAULT_NORMALIZER_MODEL } from './tts-number-normalizer.js';
import type { NumberNormalizerRunner } from './tts-number-normalizer.js';

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
      return generateEditListWithOllama(model, systemPrompt, input, {
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

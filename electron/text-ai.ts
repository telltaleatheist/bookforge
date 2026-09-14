/**
 * TEXT-AI — call an AI provider.
 *
 * This file was `bilingual-processor.ts` (1,712 lines): chunked AI cleanup,
 * batched translation, sentence alignment and bilingual EPUB generation, all for
 * the language-learning pipeline. That whole feature was removed on 2026-09-05
 * (Owen: "it needs to be rebuilt anyway ... clean it all out"), and what is left
 * here is the two pieces of it that were never about bilingual books and that
 * live features still read:
 *
 *   - `callAI` + `AiCallConfig` — the four-provider text-completion call
 *     (Ollama / Claude / OpenAI / bundled local), used by the ledger's translate
 *     pass (`mono-translation-job.ts`).
 *   - `splitIntoSentences` / `splitForTts` LEFT for shared/listen-text/ in
 *     Phase 16 (the browser extension segments its own text now) — see the
 *     note at the foot of this file.
 *
 * `LANGUAGE_NAMES` comes with them because the translate pass names its languages
 * to the model out of it.
 *
 * NOT a general home for text utilities. If a third unrelated thing wants to live
 * here, that is the sign these two should be separate modules.
 */

import { crucibleChatOnce, type AIProviderConfig } from './ai-bridge';
import { crucibleActModel } from './crucible/text-venue';
import type { CrucibleTextAct } from './crucible/text-acts';


// Language name mapping for prompts
export const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English',
  'de': 'German',
  'es': 'Spanish',
  'fr': 'French',
  'hu': 'Hungarian',
  'it': 'Italian',
  'pt': 'Portuguese',
  'nl': 'Dutch',
  'pl': 'Polish',
  'ru': 'Russian',
  'ja': 'Japanese',
  'zh': 'Chinese',
  'ko': 'Korean',
};

// Default chunk size for cleanup (in characters)

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider Functions
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `callOllama`, `callClaude`, `callOpenAI` and the `fetchWithTimeout` they
 * shared ARE DELETED (2026-09-14, crucible `docs/PHASE15-HOST.md` §5.3).
 *
 * Owen: *"they dont have ollama fallbacks or cloud anything at all."* An
 * Ollama server, an Anthropic key and an OpenAI key are now UPSTREAMS on the
 * ENGINE, and a class reaches one by being ROUTED there — a choice the
 * operator makes once, on the server, for every app. So a translation against
 * Anthropic still happens; it happens through {@link callCrucible}, because
 * from this side there is one transport and one set of named refusals rather
 * than three hand-written HTTP doors with three vocabularies for "the model
 * returned nothing".
 */

/**
 * Call the bundled local llama.cpp model (serves the active model). Cogito is a
 * reasoning model, so strip any <think>…</think> block from the output.
 */
async function callLocal(prompt: string, systemPrompt?: string): Promise<string> {
  const { llamaBridge } = await import('./llama-bridge.js');
  const out = await llamaBridge.generate({ system: systemPrompt, prompt, temperature: 0.3 });
  return out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * One completion against a Crucible server.
 *
 * The transport is `ai-bridge`'s `crucibleChatOnce` and NOT a second client:
 * the timeout, the abort chain and — the load-bearing part — the translation of
 * the SDK's exceptions into the named codes every surface reads
 * (`crucible_model_not_resident`, `crucible_model_leased`, …) live there, and a
 * third copy of them is a third place for a refusal to stop naming itself
 * (crucible `docs/ARCHITECTURE.md` R1).
 *
 * The two numbers are THIS call's, matched to the Ollama arm above so a
 * translation does not change character with its venue: temperature 0.3, and an
 * input-proportional budget with the same ×3 and the same 4096 floor (a
 * translation can legitimately expand the text).
 *
 * No `[SKIP]` trapdoor and no truncation split: those belong to the cleanup
 * run's chunk machinery, not here. A `length` finish is a translated batch that
 * stopped mid-sentence, and it is REFUSED by name rather than returned — the
 * caller's numbered-paragraph parse would otherwise take a truncated answer for
 * a short one and write it into the book.
 */
async function callCrucible(
  prompt: string,
  where: { server: string; act: CrucibleTextAct; model?: string },
  systemPrompt?: string,
): Promise<string> {
  /*
   * THE MODEL IS THE SERVER'S ANSWER, ASKED ONCE PER RUN.
   *
   * PHASE15 §5.3: a text door sends `capability.selected` for its class and
   * nothing else. `crucibleActModel` is the one owner of that read and of the
   * stamp that memoises it onto this run's block, so a translation making
   * three hundred batch calls asks the server once — and every later report
   * names the model the run actually used.
   */
  const model = await crucibleActModel(where);
  const answer = await crucibleChatOnce({
    server: where.server,
    model,
    act: where.act,
    system: systemPrompt ?? '',
    user: prompt,
    temperature: 0.3,
    maxTokens: Math.max(4096, prompt.length * 3),
    sizeChars: prompt.length,
  });
  if (answer.finishReason === 'length') {
    throw new Error(
      `crucible_answer_truncated: crucible "${where.server}" stopped "${model}" at the token `
      + `budget for a ${prompt.length}-char batch, so the answer ends mid-text. It is refused `
      + 'rather than written into the book.',
    );
  }
  return answer.content.trim();
}

/**
 * Call the configured AI provider.
 *
 * It takes the SAME `AIProviderConfig` `providerConfigOf` composes and every
 * other bridge is handed (`electron/queue-steps/ai-provider.ts`). It used to
 * take five flat fields of its own (`AiCallConfig`), which made the mapping
 * from a job's config to a provider a thing each caller did by hand — and the
 * hand-built copy in `processing-passes.ts` is exactly how the pass steps ended
 * up with no `crucible` arm at all while every other AI door had one.
 */
export async function callAI(
  prompt: string,
  config: AIProviderConfig,
  systemPrompt?: string
): Promise<string> {
  console.log(`[TEXT-AI] Calling AI: provider=${config.provider}, model=${aiCallModel(config)}`);
  /*
   * A PROVIDER WITH NO BLOCK IS REFUSED BY NAME. `providerConfigOf` fills the
   * arm for the provider it names, so an absent one means the block was built
   * somewhere else and built wrong — and the alternative to saying so is a
   * `Cannot read properties of undefined` from inside a translation at chapter
   * nine.
   */
  const arm = <T>(named: T | undefined): T => {
    if (named === undefined) {
      throw new Error(
        `ai_provider_block_incomplete: this job names the "${config.provider}" provider and `
        + `carries no ${config.provider} block, so there is nothing to call.`,
      );
    }
    return named;
  };
  switch (config.provider) {
    case 'local':
      return await callLocal(prompt, systemPrompt);
    case 'crucible':
      return await callCrucible(prompt, arm(config.crucible), systemPrompt);
    default:
      /*
       * A JOB PERSISTED BEFORE PHASE 15 CAN STILL NAME `ollama`, `claude` or
       * `openai`, and it is told so by name. Re-pointing it at a survivor
       * would move somebody's book onto a different engine without asking.
       */
      throw new Error(
        `ai_provider_removed: this job names "${config.provider}", which BookForge no longer has. `
        + 'Ollama, Claude and OpenAI are UPSTREAMS on the GPU engine now: set the key or the '
        + 'address in Settings → AI, route the class to it there, and queue this against the '
        + 'engine.',
      );
  }
}

/**
 * The model name this provider block names, for a log line and for the record a
 * run files about itself.
 *
 * `null` is a real answer and not a gap: a block that names no model for its
 * own provider has none to report, and inventing one would put a name nobody
 * chose into a book's provenance record.
 */
export function aiCallModel(config: AIProviderConfig): string | null {
  switch (config.provider) {
    /*
     * `null` UNTIL THE RUN HAS ASKED. A crucible block carries no model until
     * `crucibleActModel` has read the server's capability record and stamped
     * one, so before the first call there is genuinely no name to report —
     * and writing a guessed id into a book's provenance record is the thing
     * this function's header forbids.
     */
    case 'crucible': return config.crucible?.model ?? null;
    /*
     * Informational only: `callLocal` reads it for nothing, because
     * llama-bridge resolves the active model itself.
     */
    case 'local': return config.local?.model ?? null;
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentence splitting — MOVED (Phase 16)
// ─────────────────────────────────────────────────────────────────────────────
//
// `splitIntoSentences`, `splitForTts` and the abbreviation safety net are now
// `shared/listen-text/segment.ts`. The browser extension talks to a Crucible
// directly since Phase 16 and has to split its own paragraphs; a second
// segmenter would splice one chunk's audio under another chunk's text, so
// there is exactly one copy, in the layer both programs compile.
//
// This file keeps the AI-provider half it was left with, and is deliberately
// NOT a re-export point: a caller wants `shared/listen-text`, and reaching it
// through here would drag `ai-bridge` and the Electron app object into a
// browser bundle.

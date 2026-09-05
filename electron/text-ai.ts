/**
 * TEXT-AI — call an AI provider, and split text into sentences.
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
 *   - `splitIntoSentences` / `splitForTts` — Intl.Segmenter sentence splitting,
 *     used by the streaming TTS path (tts-api-server, reader-stream-bridge) and
 *     by `book-render-service`.
 *
 * `LANGUAGE_NAMES` comes with them because the translate pass names its languages
 * to the model out of it.
 *
 * NOT a general home for text utilities. If a third unrelated thing wants to live
 * here, that is the sign these two should be separate modules.
 */

import { estimateNumCtx } from './ai-bridge';
import { getOllamaThinkFields } from './ollama-capabilities';


/**
 * Everything `callAI` needs to reach a provider.
 *
 * It was `BilingualProcessingConfig` until 2026-09-05, when it carried a dozen
 * more fields describing a bilingual RUN (source text, batch sizes, cleanup
 * prompts, a test mode). Those went with the feature; what is left is the four
 * providers' credentials, which is all the call ever read.
 */
export interface AiCallConfig {
  aiProvider: 'ollama' | 'claude' | 'openai' | 'local';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
}


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

/**
 * Call Ollama API
 */
async function callOllama(
  prompt: string,
  model: string,
  baseUrl: string = 'http://localhost:11434',
  systemPrompt?: string
): Promise<string> {
  // Capability-gated: thinking models (e.g. qwen3) get think:false so the
  // generation budget goes to the answer, not a discarded chain-of-thought.
  const thinkFields = await getOllamaThinkFields(baseUrl, model);
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    ...thinkFields,
    // Keep the model resident between chunks, matching the heavy engine
    // (ai-bridge cleanChunk) so back-to-back chunks never pay a reload.
    keep_alive: '5m',
    options: {
      temperature: 0.3,
      // Explicit output budget, input-proportional like the heavy engine. ×3
      // matches this call's estimateNumCtx output multiplier (a translation can
      // legitimately expand the text); floor of 4096 covers tiny prompts.
      num_predict: Math.max(4096, prompt.length * 3),
      num_ctx: estimateNumCtx(systemPrompt || '', prompt, 3, model),
    }
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response.trim();
}

// Hosted-API calls used by TRANSLATION get a hard timeout so a hung connection
// fails loudly instead of stalling the job forever. (Cleanup/simplify no longer
// call these — they route through ai-bridge's cleanChunkWithProvider, which has
// its own timeout and safeguards.)
const HOSTED_API_TIMEOUT_MS = 180000; // 3 minutes

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = HOSTED_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call Claude API (used by translation). Cleanup/simplify use the hardened
 * cleanChunkWithProvider instead.
 */
async function callClaude(
  prompt: string,
  model: string,
  apiKey: string,
  systemPrompt?: string
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: 'user', content: systemPrompt + '\n\n' + prompt });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude request failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  // Concatenate all text content blocks — robust to non-text blocks (e.g.
  // thinking) or an empty/refusal response (the old data.content[0].text threw).
  const text: string = Array.isArray(data.content)
    ? data.content
        .filter((b: { type?: string; text?: string }) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: { text?: string }) => b.text)
        .join('')
    : '';
  if (!text.trim()) {
    // Don't coerce an empty/refusal response to '' — that discards stop_reason
    // and lets callers silently treat a refusal as a result. Fail loudly so the
    // translation failure tracking can account for it.
    const why = data.stop_reason === 'refusal'
      ? 'the model refused (commonly copyright/content policy — use a local model for copyrighted books)'
      : `the model returned no text (stop_reason: ${data.stop_reason ?? 'unknown'})`;
    throw new Error(`Claude returned an empty response: ${why}`);
  }
  return text.trim();
}

/**
 * Call OpenAI API
 */
async function callOpenAI(
  prompt: string,
  model: string,
  apiKey: string,
  systemPrompt?: string
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    // Don't coerce an empty response to '' — that discards finish_reason and
    // lets callers silently treat a refusal/filter as a result. Fail loudly so
    // the translation failure tracking can account for it.
    throw new Error(`OpenAI returned an empty response (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'unknown'})`);
  }
  return text.trim();
}

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
 * Call the configured AI provider
 */
export async function callAI(
  prompt: string,
  config: AiCallConfig,
  systemPrompt?: string
): Promise<string> {
  console.log(`[TEXT-AI] Calling AI: provider=${config.aiProvider}, model=${config.aiModel}`);
  switch (config.aiProvider) {
    case 'ollama':
      return await callOllama(prompt, config.aiModel, config.ollamaBaseUrl, systemPrompt);
    case 'claude':
      return await callClaude(prompt, config.aiModel, config.claudeApiKey!, systemPrompt);
    case 'openai':
      return await callOpenAI(prompt, config.aiModel, config.openaiApiKey!, systemPrompt);
    case 'local':
      return await callLocal(prompt, systemPrompt);
    default:
      throw new Error(`Unsupported AI provider: ${config.aiProvider}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Sentence Splitting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize abbreviations that could be confused with sentence endings.
 * This is a safety net that runs AFTER AI cleanup, catching any abbreviations
 * the AI might have missed. Critical for accurate sentence boundary detection.
 */
function normalizeAbbreviations(text: string): string {
  // Abbreviations that commonly cause sentence boundary detection errors
  // Map from abbreviation to normalized form (without periods)
  const abbreviations: Record<string, string> = {
    // Countries/Organizations (most problematic for sentence splitting)
    'U.S.': 'US',
    'U.K.': 'UK',
    'U.N.': 'UN',
    'E.U.': 'EU',
    'U.S.A.': 'USA',
    'U.S.S.R.': 'USSR',
    // Titles
    'Dr.': 'Dr',
    'Mr.': 'Mr',
    'Mrs.': 'Mrs',
    'Ms.': 'Ms',
    'Prof.': 'Prof',
    'Jr.': 'Jr',
    'Sr.': 'Sr',
    'Rev.': 'Rev',
    'Gen.': 'Gen',
    'Col.': 'Col',
    'Lt.': 'Lt',
    'Sgt.': 'Sgt',
    'Capt.': 'Capt',
    'Gov.': 'Gov',
    'Sen.': 'Sen',
    'Rep.': 'Rep',
    // Business
    'Inc.': 'Inc',
    'Ltd.': 'Ltd',
    'Corp.': 'Corp',
    'Co.': 'Co',
    'Bros.': 'Bros',
    'LLC.': 'LLC',
    // Common abbreviations
    'vs.': 'vs',
    'etc.': 'etc',
    'e.g.': 'eg',
    'i.e.': 'ie',
    'a.m.': 'am',
    'p.m.': 'pm',
    'A.M.': 'AM',
    'P.M.': 'PM',
    'no.': 'no',
    'No.': 'No',
    'vol.': 'vol',
    'Vol.': 'Vol',
    'pp.': 'pp',
    'pg.': 'pg',
    'St.': 'St',
    'Ave.': 'Ave',
    'Blvd.': 'Blvd',
    'Rd.': 'Rd',
    'Mt.': 'Mt',
    'Ft.': 'Ft',
    'approx.': 'approx',
    'dept.': 'dept',
    'Dept.': 'Dept',
    'est.': 'est',
    'Est.': 'Est',
  };

  let result = text;
  for (const [abbr, replacement] of Object.entries(abbreviations)) {
    // Use word boundary awareness to avoid replacing parts of words
    // But be careful: "U.S." at end of sentence followed by space+capital should still be replaced
    result = result.split(abbr).join(replacement);
  }

  console.log(`[TEXT-AI] Normalized abbreviations in text`);
  return result;
}

/**
 * Split granularity levels:
 * - 'sentence': Default - splits at sentence boundaries (. ! ?)
 * - 'paragraph': Keeps entire paragraphs together (longer segments)
 */
export type SplitGranularity = 'sentence' | 'paragraph';

/**
 * Split text into segments based on granularity level
 * @param text - The text to split
 * @param locale - Language code for Intl.Segmenter (default: 'en')
 * @param granularity - 'sentence' (default, recommended) or 'paragraph' (longer segments)
 */
export function splitIntoSentences(
  text: string,
  locale: string = 'en',
  granularity: SplitGranularity = 'sentence'
): string[] {
  // Safety net: normalize abbreviations that could be confused with sentence endings
  // This catches anything AI cleanup might have missed (e.g., "U.S." → "US")
  const normalizedText = normalizeAbbreviations(text);

  // First, split by paragraphs (double newlines)
  const paragraphs = normalizedText.split(/\n\n+/);
  const allSegments: string[] = [];

  console.log(`[TEXT-AI] Splitting with granularity='${granularity}', locale='${locale}'`);

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (granularity === 'paragraph') {
      // Paragraph mode: keep entire paragraphs as single units
      allSegments.push(trimmed);
    } else {
      // Sentence mode (default): use Intl.Segmenter for proper sentence boundaries
      const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const segments = [...segmenter.segment(trimmed)];

      // Extract and clean sentences
      const sentences = segments
        .map(s => s.segment.trim())
        .filter(s => s.length > 0)
        // Filter out very short fragments that aren't real sentences
        .filter(s => s.length > 3 || /^[A-Z]/.test(s));

      allSegments.push(...sentences);
    }
  }

  console.log(`[TEXT-AI] Split into ${allSegments.length} segments from ${paragraphs.length} paragraphs (granularity=${granularity})`);
  return allSegments;
}

/**
 * A DEAD ENGINE'S NUMBER, AND STILL THE DEFAULT — flagged rather than fixed.
 *
 * 240 is XTTS's per-inference char limit for English. It was the default for
 * every streaming caller until 2026-08-19, which meant Orpheus — whose limit is a
 * token budget an order of magnitude larger — had its sentences broken at commas
 * for a ceiling that was never its own. The streaming callers were fixed then and
 * now ALWAYS pass `orpheusStreamMaxChars(voice)` (orpheus-models.ts), the same
 * voice-manifest channel the audiobook path reads.
 *
 * One caller still takes the default: `book-render-service`, which builds its
 * sentence plan before any voice is chosen and so has no per-voice cap to pass.
 * For it this is a conservative floor, not a correct one — every Orpheus voice
 * could take longer sentences. Fixing it means moving the split to render time,
 * which is a change to that service, not to this constant.
 */
const TTS_MAX_CHARS = 240;

/**
 * A piece shorter than this is not worth being its own TTS inference: the model
 * gets no context, and the reader hears an isolated fragment with a pause on each
 * side of it. Mirrors e2a's `SENTENCE_MIN_CHARS` floor (lib/core.py
 * `_sentence_min_chars`, same 25-char default), which the audiobook path has always
 * applied and this one never did — a 249-char sentence against a 240 cap produced
 * a 238-char piece and the orphan `"religion)."`, spoken alone.
 */
const MIN_SEGMENT_CHARS = 25;

/**
 * Sentence-split for the streaming TTS path, then break any sentence that exceeds
 * the engine's per-inference char limit at clause boundaries (then word boundaries
 * as a last resort), re-packing small pieces to keep the segment count low. This
 * is safe to sub-split because each segment is just one TTS inference.
 *
 * A caller that knows its voice MUST pass that voice's cap — see TTS_MAX_CHARS.
 */
export function splitForTts(text: string, locale: string = 'en', maxChars: number = TTS_MAX_CHARS): string[] {
  const out: string[] = [];
  for (const sentence of splitIntoSentences(text, locale)) {
    if (sentence.length <= maxChars) { out.push(sentence); continue; }
    out.push(...capSegment(sentence, maxChars));
  }
  return out;
}

function capSegment(sentence: string, maxChars: number): string[] {
  // Prefer clause boundaries (punctuation stays attached to the left piece); split
  // an over-long clause on whitespace; then re-pack adjacent pieces up to the cap.
  const pieces: string[] = [];
  for (const clause of sentence.split(/(?<=[,;:—–])\s+/)) {
    if (clause.length <= maxChars) { pieces.push(clause); continue; }
    let buf = '';
    for (const word of clause.split(/\s+/)) {
      if (buf && buf.length + 1 + word.length > maxChars) { pieces.push(buf); buf = word; }
      else buf = buf ? `${buf} ${word}` : word;
    }
    if (buf) pieces.push(buf);
  }
  const packed: string[] = [];
  for (const piece of pieces) {
    const last = packed[packed.length - 1];
    if (last && last.length + 1 + piece.length <= maxChars) packed[packed.length - 1] = `${last} ${piece}`;
    else packed.push(piece);
  }
  // Starvation floor, AFTER packing: the greedy packer fills to the cap and leaves
  // whatever is left over, so a sentence a few chars past the cap ends in a scrap.
  // Absorb it into its neighbour even though that exceeds maxChars — a cap is a
  // guard against truncation, and going a few percent over it costs far less than
  // speaking one word on its own. Nothing here can produce a piece longer than
  // maxChars + MIN_SEGMENT_CHARS.
  for (let i = packed.length - 1; i > 0; i--) {
    if (packed[i].length >= MIN_SEGMENT_CHARS) continue;
    packed[i - 1] = `${packed[i - 1]} ${packed[i]}`;
    packed.splice(i, 1);
  }
  return packed;
}

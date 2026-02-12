/**
 * Bilingual Processor - Chunk-based cleanup, batched translation, and alignment
 *
 * Pipeline:
 * 1. Chunk-based AI cleanup (like audiobook cleanup) - fixes OCR, formatting
 * 2. Sentence splitting on CLEANED text using Intl.Segmenter
 * 3. Batched translation with context (5-10 sentences per batch)
 * 4. Bilingual EPUB generation
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SentencePair {
  index: number;
  source: string;
  target: string;
  sourceTimestamp?: number;
  targetTimestamp?: number;
}

export interface BilingualChapter {
  id: string;
  title: string;
  sentences: SentencePair[];
}

export interface BilingualProcessingConfig {
  projectId: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  // Cleanup settings
  enableCleanup?: boolean;
  cleanupPrompt?: string;
  // Translation settings
  translationPrompt?: string;
  batchSize?: number;  // Number of sentences per batch (default: 8)
  // Test mode - limit chunks for faster testing
  testMode?: boolean;
  testModeChunks?: number;
}

export interface ProcessingProgress {
  phase: 'extracting' | 'cleanup' | 'splitting' | 'translating' | 'validating' | 'epub' | 'tts' | 'complete' | 'error';
  currentChunk?: number;
  totalChunks?: number;
  currentSentence: number;
  totalSentences: number;
  percentage: number;
  message: string;
}

export interface BilingualResult {
  success: boolean;
  sentences?: SentencePair[];
  epubPath?: string;
  error?: string;
}

// Language name mapping for prompts
const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English',
  'de': 'German',
  'es': 'Spanish',
  'fr': 'French',
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
const CLEANUP_CHUNK_SIZE = 2500;

// Default batch size for translation
const DEFAULT_TRANSLATION_BATCH_SIZE = 8;

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
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    options: {
      temperature: 0.3,
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

/**
 * Call Claude API
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
    throw new Error(`Claude request failed: ${error}`);
  }

  const data = await response.json();
  return data.content[0].text.trim();
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    throw new Error(`OpenAI request failed: ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Call the configured AI provider
 */
async function callAI(
  prompt: string,
  config: BilingualProcessingConfig,
  systemPrompt?: string
): Promise<string> {
  console.log(`[BILINGUAL] Calling AI: provider=${config.aiProvider}, model=${config.aiModel}`);
  switch (config.aiProvider) {
    case 'ollama':
      return await callOllama(prompt, config.aiModel, config.ollamaBaseUrl, systemPrompt);
    case 'claude':
      return await callClaude(prompt, config.aiModel, config.claudeApiKey!, systemPrompt);
    case 'openai':
      return await callOpenAI(prompt, config.aiModel, config.openaiApiKey!, systemPrompt);
    default:
      throw new Error(`Unsupported AI provider: ${config.aiProvider}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Chunk-based Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split text into chunks for cleanup processing
 */
function splitIntoCleanupChunks(text: string, chunkSize: number = CLEANUP_CHUNK_SIZE): string[] {
  const chunks: string[] = [];

  // Split by paragraphs first
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Build the cleanup system prompt
 */
function buildCleanupSystemPrompt(customPrompt?: string): string {
  if (customPrompt) {
    return customPrompt;
  }

  return `You are preparing text for text-to-speech (TTS) audiobook narration.

OUTPUT FORMAT: Respond with ONLY the processed text. Start immediately with the content.
FORBIDDEN: Never write "Here is", "I'll help", or ANY conversational language.

CRITICAL RULES:
- NEVER summarize. Output must be the same length as input (with minor variations from edits).
- NEVER paraphrase or rewrite sentences unless fixing an error.
- NEVER skip or omit any content.
- Process the text LINE BY LINE, making only the specific fixes below.

EDGE CASES:
- Empty/whitespace input → output: [SKIP]
- Garbage/unreadable characters → output: [SKIP]

NUMBERS → SPOKEN WORDS:
- Years: "1923" → "nineteen twenty-three", "2001" → "two thousand one"
- Decades: "the 1930s" → "the nineteen thirties"
- Ordinals: "1st" → "first", "21st" → "twenty-first"
- Cardinals: "3 men" → "three men"
- Currency: "$5.50" → "five dollars and fifty cents"
- Percentages: "25%" → "twenty-five percent"
- DATES: "Feb 7" → "February seventh", "Jan 21" → "January twenty-first", "Dec 9" → "December ninth"
  Days of month are ORDINALS (first, second, third), not cardinals (one, two, three)

EXPAND ABBREVIATIONS:
- Months: "Jan" → "January", "Feb" → "February", "Mar" → "March", "Apr" → "April", "Aug" → "August", "Sept" → "September", "Oct" → "October", "Nov" → "November", "Dec" → "December"
- Titles: "Mr." → "Mister", "Dr." → "Doctor", "Mrs." → "Missus", "Prof." → "Professor"
- Common: "e.g." → "for example", "i.e." → "that is", "etc." → "and so on", "vs." → "versus"

CRITICAL - REMOVE PERIODS FROM ABBREVIATIONS (prevents sentence boundary errors):
- Countries/orgs: "U.S." → "US", "U.K." → "UK", "U.N." → "UN", "E.U." → "EU"
- Business: "Inc." → "Inc", "Ltd." → "Ltd", "Corp." → "Corp", "Co." → "Co"
- Military/govt: "Gen." → "General", "Col." → "Colonel", "Sen." → "Senator", "Rep." → "Representative"
- Time: "a.m." → "am", "p.m." → "pm"
- Other: "Jr." → "Junior", "Sr." → "Senior", "St." → "Saint" (or "Street" in addresses)

FIX: broken words, OCR errors, stylistic spacing issues.
REMOVE: stray artifacts, leftover HTML entities.

Start your response with the first word of the text. No introduction.`;
}

/**
 * Clean up text using chunk-based processing
 */
export async function cleanupText(
  text: string,
  config: BilingualProcessingConfig,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<string> {
  if (!config.enableCleanup) {
    return text;
  }

  let chunks = splitIntoCleanupChunks(text);

  // Apply test mode limit if enabled
  if (config.testMode && config.testModeChunks && config.testModeChunks > 0) {
    const originalCount = chunks.length;
    chunks = chunks.slice(0, config.testModeChunks);
    console.log(`[BILINGUAL] Test mode: limiting to ${config.testModeChunks} chunks (was ${originalCount})`);
  }

  const totalChunks = chunks.length;
  const cleanedChunks: string[] = [];
  const systemPrompt = buildCleanupSystemPrompt(config.cleanupPrompt);

  console.log(`[BILINGUAL] Starting cleanup: ${totalChunks} chunks`);
  console.log(`[BILINGUAL] Using system prompt (${systemPrompt.length} chars): ${systemPrompt.substring(0, 150)}...`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (onProgress) {
      onProgress({
        phase: 'cleanup',
        currentChunk: i + 1,
        totalChunks,
        currentSentence: 0,
        totalSentences: 0,
        percentage: Math.round((i / totalChunks) * 100),
        message: `Cleaning chunk ${i + 1} of ${totalChunks}...`,
      });
    }

    try {
      const cleaned = await callAI(chunk, config, systemPrompt);
      cleanedChunks.push(cleaned);
      console.log(`[BILINGUAL] Cleaned chunk ${i + 1}/${totalChunks} (${chunk.length} -> ${cleaned.length} chars)`);
    } catch (error) {
      console.error(`[BILINGUAL] Cleanup failed for chunk ${i + 1}:`, error);
      // Fall back to original chunk on error
      cleanedChunks.push(chunk);
    }

    // Rate limiting for API providers
    if (config.aiProvider !== 'ollama') {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Send final 100% progress
  if (onProgress) {
    onProgress({
      phase: 'cleanup',
      currentChunk: totalChunks,
      totalChunks,
      currentSentence: 0,
      totalSentences: 0,
      percentage: 100,
      message: 'Cleanup complete',
    });
  }

  return cleanedChunks.join('\n\n');
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

  console.log(`[BILINGUAL] Normalized abbreviations in text`);
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

  console.log(`[BILINGUAL] Splitting with granularity='${granularity}', locale='${locale}'`);

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

  console.log(`[BILINGUAL] Split into ${allSegments.length} segments from ${paragraphs.length} paragraphs (granularity=${granularity})`);
  return allSegments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Batched Translation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the translation prompt for a batch of sentences
 */
function buildBatchTranslationPrompt(
  sentences: string[],
  sourceLang: string,
  targetLang: string,
  contextSentences: string[],
  customPrompt?: string
): string {
  const sourceLanguage = LANGUAGE_NAMES[sourceLang] || sourceLang;
  const targetLanguage = LANGUAGE_NAMES[targetLang] || targetLang;
  const count = sentences.length;

  // Number the sentences
  const numberedSentences = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');

  if (customPrompt) {
    // Custom prompt - replace placeholders
    return customPrompt
      .replace(/{sourceLang}/g, sourceLanguage)
      .replace(/{targetLang}/g, targetLanguage)
      .replace(/{count}/g, String(count))
      .replace(/{sentences}/g, numberedSentences)
      .replace(/{context}/g, contextSentences.join(' '));
  }

  // Default batch translation prompt
  let prompt = `Translate each sentence from ${sourceLanguage} to ${targetLanguage}.
Return exactly ${count} translations, one per line, in the same order.
Do NOT include numbers, explanations, or original text - only the translations.

`;

  // Add context if available
  if (contextSentences.length > 0) {
    prompt += `Context (previous sentences, for reference only - do NOT translate):
${contextSentences.join(' ')}

`;
  }

  prompt += `Sentences to translate:
${numberedSentences}

Translations (${count} lines):`;

  return prompt;
}

/**
 * Parse batch translation response into individual translations
 * Returns the parsed lines WITHOUT padding - caller handles count mismatches
 */
function parseBatchTranslationResponse(response: string, expectedCount: number): { lines: string[]; exact: boolean } {
  // Split by newlines and clean up
  const lines = response
    .split('\n')
    .map(line => line.trim())
    // Remove empty lines
    .filter(line => line.length > 0)
    // Remove lines that look like numbers only (e.g., "1.", "2.")
    .filter(line => !/^\d+\.?\s*$/.test(line))
    // Remove leading numbers if present (e.g., "1. Translation" -> "Translation")
    .map(line => line.replace(/^\d+\.\s*/, ''));

  // If we got the expected count, great!
  if (lines.length === expectedCount) {
    return { lines, exact: true };
  }

  // If we got more lines, take the first N
  if (lines.length > expectedCount) {
    console.warn(`[BILINGUAL] Got ${lines.length} translations, expected ${expectedCount}. Taking first ${expectedCount}.`);
    return { lines: lines.slice(0, expectedCount), exact: true };
  }

  // Got fewer - return what we have, caller will handle retry
  console.warn(`[BILINGUAL] Got ${lines.length} translations, expected ${expectedCount}. Will retry individually.`);
  return { lines, exact: false };
}

/**
 * Translate a single sentence (used for retry fallback)
 */
async function translateSingleSentence(
  sentence: string,
  contextSentences: string[],
  config: BilingualProcessingConfig
): Promise<string> {
  const sourceLanguage = LANGUAGE_NAMES[config.sourceLang] || config.sourceLang;
  const targetLanguage = LANGUAGE_NAMES[config.targetLang] || config.targetLang;

  const prompt = `Translate the following sentence from ${sourceLanguage} to ${targetLanguage}.
Return ONLY the translation, nothing else.

${contextSentences.length > 0 ? `Context: ${contextSentences.slice(-2).join(' ')}\n\n` : ''}Sentence: ${sentence}

Translation:`;

  const response = await callAI(prompt, config);
  // Clean up the response - take first non-empty line
  const lines = response.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return lines[0] || `[Translation failed for: ${sentence.substring(0, 50)}...]`;
}

/**
 * Translate a batch of sentences with context
 * If batch returns wrong count, retries each sentence individually
 */
async function translateBatch(
  sentences: string[],
  contextSentences: string[],
  config: BilingualProcessingConfig
): Promise<string[]> {
  // Try batch translation first
  const prompt = buildBatchTranslationPrompt(
    sentences,
    config.sourceLang,
    config.targetLang,
    contextSentences,
    config.translationPrompt
  );

  const response = await callAI(prompt, config);
  const { lines, exact } = parseBatchTranslationResponse(response, sentences.length);

  // If we got exact count, return immediately
  if (exact) {
    return lines;
  }

  // Count mismatch - retry each sentence individually
  console.log(`[BILINGUAL] Batch count mismatch (got ${lines.length}, expected ${sentences.length}). Retrying ${sentences.length} sentences individually...`);

  const results: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    // Use previous sentences as context for single translation
    const singleContext = i > 0 ? sentences.slice(Math.max(0, i - 2), i) : contextSentences.slice(-2);
    const translation = await translateSingleSentence(sentences[i], singleContext, config);
    results.push(translation);

    // Rate limiting for API providers during retry
    if (config.aiProvider !== 'ollama') {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`[BILINGUAL] Individual retry complete: ${results.length} translations`);
  return results;
}

/**
 * Translate all sentences in batches with progress updates
 */
export async function translateSentences(
  sentences: string[],
  config: BilingualProcessingConfig,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<SentencePair[]> {
  const pairs: SentencePair[] = [];
  const total = sentences.length;
  const batchSize = config.batchSize || DEFAULT_TRANSLATION_BATCH_SIZE;
  const contextSize = 3; // Number of previous sentences for context

  console.log(`[BILINGUAL] Starting translation: ${total} sentences in batches of ${batchSize}`);

  let sentencesProcessed = 0;

  for (let batchStart = 0; batchStart < sentences.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, sentences.length);
    const batchSentences = sentences.slice(batchStart, batchEnd);

    // Get context from previous sentences (already translated)
    const contextStart = Math.max(0, batchStart - contextSize);
    const contextSentences = sentences.slice(contextStart, batchStart);

    if (onProgress) {
      const progressPercent = 30 + Math.round((sentencesProcessed / total) * 60); // Translation is 30-90%
      onProgress({
        phase: 'translating',
        currentSentence: sentencesProcessed + 1,
        totalSentences: total,
        percentage: progressPercent,
        message: `Translating sentences ${batchStart + 1}-${batchEnd} of ${total}...`,
      });
    }

    try {
      const translations = await translateBatch(batchSentences, contextSentences, config);

      // Create sentence pairs
      for (let i = 0; i < batchSentences.length; i++) {
        pairs.push({
          index: batchStart + i,
          source: batchSentences[i],
          target: translations[i],
        });
      }

      console.log(`[BILINGUAL] Translated batch ${Math.floor(batchStart / batchSize) + 1}: sentences ${batchStart + 1}-${batchEnd}`);
    } catch (error) {
      console.error(`[BILINGUAL] Batch translation failed:`, error);

      // Add error markers for failed batch
      for (let i = 0; i < batchSentences.length; i++) {
        pairs.push({
          index: batchStart + i,
          source: batchSentences[i],
          target: `[Translation failed: ${(error as Error).message}]`,
        });
      }
    }

    sentencesProcessed = batchEnd;

    // Rate limiting for API providers
    if (config.aiProvider !== 'ollama') {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Bilingual EPUB Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a monolingual EPUB with sentences as paragraphs in a single chapter
 *
 * e2a will use --sentence_per_paragraph to preserve our paragraph boundaries
 * instead of re-splitting the text. This keeps the EPUB structure simple
 * while ensuring each paragraph becomes exactly one sentence.
 */
export async function generateMonolingualEpub(
  sentences: string[],
  title: string,
  lang: string,
  outputPath: string,
  options?: { includeBookforgeMarker?: boolean }
): Promise<string> {
  // Only add bookforge marker for TTS EPUBs, not for intermediate cleaned.epub
  // e2a uses first sentence as chapter title fallback, so we add a marker that
  // bilingual assembly will skip (starts from sentence 1)
  const includeMarker = options?.includeBookforgeMarker ?? true;
  const allSentences = includeMarker ? ['bookforge.', ...sentences] : sentences;

  // Generate HTML content - one paragraph per sentence
  const sentencesHtml = allSentences.map((sentence, index) =>
    `<p id="s${index}">${escapeHtml(sentence)}</p>`
  ).join('\n');

  const htmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; margin: 2em; }
    p { margin-bottom: 1em; }
  </style>
</head>
<body>
  ${sentencesHtml}
</body>
</html>`;

  // Create EPUB structure
  const epubDir = path.dirname(outputPath);
  const tempDir = path.join(epubDir, '.epub-temp-' + crypto.randomBytes(4).toString('hex'));

  try {
    await fs.mkdir(path.join(tempDir, 'META-INF'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'OEBPS'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'mimetype'), 'application/epub+zip');

    await fs.writeFile(
      path.join(tempDir, 'META-INF', 'container.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    );

    const uuid = crypto.randomUUID();
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'content.opf'),
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`
    );

    await fs.writeFile(path.join(tempDir, 'OEBPS', 'chapter1.xhtml'), htmlContent);

    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'toc.ncx'),
      generateTocNcx(title)
    );

    await createEpubZip(tempDir, outputPath);
    console.log(`[BILINGUAL] Created monolingual EPUB with ${sentences.length} sentences: ${outputPath}`);
    return outputPath;
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Chapter with sentences for EPUB generation
 */
export interface ChapterSentences {
  title: string;
  sentences: string[];
}

/**
 * Generate EPUB with multiple chapters, each containing sentences
 */
export async function generateChapteredEpub(
  chapters: ChapterSentences[],
  bookTitle: string,
  lang: string,
  outputPath: string,
  options?: { includeBookforgeMarker?: boolean }
): Promise<string> {
  const includeMarker = options?.includeBookforgeMarker ?? true;
  const epubDir = path.dirname(outputPath);
  const tempDir = path.join(epubDir, '.epub-temp-' + crypto.randomBytes(4).toString('hex'));

  try {
    await fs.mkdir(path.join(tempDir, 'META-INF'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'OEBPS'), { recursive: true });

    await fs.writeFile(path.join(tempDir, 'mimetype'), 'application/epub+zip');

    await fs.writeFile(
      path.join(tempDir, 'META-INF', 'container.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    );

    // Generate manifest items and spine entries for each chapter
    const manifestItems: string[] = [];
    const spineItems: string[] = [];
    const navPoints: string[] = [];
    let globalSentenceIndex = 0;

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const chapterId = `chapter${i + 1}`;
      const chapterFile = `${chapterId}.xhtml`;

      manifestItems.push(`    <item id="${chapterId}" href="${chapterFile}" media-type="application/xhtml+xml"/>`);
      spineItems.push(`    <itemref idref="${chapterId}"/>`);
      navPoints.push(`    <navPoint id="${chapterId}" playOrder="${i + 1}">
      <navLabel>
        <text>${escapeHtml(chapter.title)}</text>
      </navLabel>
      <content src="${chapterFile}"/>
    </navPoint>`);

      // Generate chapter HTML - one paragraph per sentence with global index
      const chapterSentences = includeMarker && i === 0
        ? ['bookforge.', ...chapter.sentences]
        : chapter.sentences;

      const sentencesHtml = chapterSentences.map((sentence) => {
        const html = `<p id="s${globalSentenceIndex}">${escapeHtml(sentence)}</p>`;
        globalSentenceIndex++;
        return html;
      }).join('\n');

      const chapterHtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeHtml(chapter.title)}</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; margin: 2em; }
    p { margin-bottom: 1em; }
    h1 { margin-bottom: 1.5em; }
  </style>
</head>
<body>
  <h1>${escapeHtml(ensureTitleEndsWithPunctuation(chapter.title))}</h1>
  ${sentencesHtml}
</body>
</html>`;

      await fs.writeFile(path.join(tempDir, 'OEBPS', chapterFile), chapterHtml);
    }

    const uuid = crypto.randomUUID();
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'content.opf'),
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeHtml(bookTitle)}</dc:title>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
${spineItems.join('\n')}
  </spine>
</package>`
    );

    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'toc.ncx'),
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle>
    <text>${escapeHtml(bookTitle)}</text>
  </docTitle>
  <navMap>
${navPoints.join('\n')}
  </navMap>
</ncx>`
    );

    await createEpubZip(tempDir, outputPath);
    const totalSentences = chapters.reduce((sum, ch) => sum + ch.sentences.length, 0);
    console.log(`[BILINGUAL] Created chaptered EPUB with ${chapters.length} chapters, ${totalSentences} sentences: ${outputPath}`);
    return outputPath;
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Generate separate source and target EPUBs for dual-voice TTS
 * Returns paths to both EPUBs
 */
export async function generateSeparateEpubs(
  pairs: SentencePair[],
  title: string,
  sourceLang: string,
  targetLang: string,
  projectDir: string,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<{ sourceEpubPath: string; targetEpubPath: string }> {
  if (onProgress) {
    onProgress({
      phase: 'epub',
      currentSentence: 0,
      totalSentences: pairs.length,
      percentage: 90,
      message: 'Generating source/target EPUBs...',
    });
  }

  const sourceSentences = pairs.map(p => p.source);
  const targetSentences = pairs.map(p => p.target);

  // Name EPUBs by language code (e.g., en.epub, de.epub)
  const sourceEpubPath = path.join(projectDir, `${sourceLang}.epub`);
  const targetEpubPath = path.join(projectDir, `${targetLang}.epub`);

  // Generate both EPUBs
  await generateMonolingualEpub(
    sourceSentences,
    `${title} (${LANGUAGE_NAMES[sourceLang] || sourceLang})`,
    sourceLang,
    sourceEpubPath
  );

  await generateMonolingualEpub(
    targetSentences,
    `${title} (${LANGUAGE_NAMES[targetLang] || targetLang})`,
    targetLang,
    targetEpubPath
  );

  if (onProgress) {
    onProgress({
      phase: 'epub',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 95,
      message: 'Source and target EPUBs created',
    });
  }

  console.log(`[BILINGUAL] Created separate EPUBs: source=${sourceEpubPath}, target=${targetEpubPath}`);
  return { sourceEpubPath, targetEpubPath };
}

/**
 * Generate bilingual EPUB from sentence pairs
 * @deprecated Use generateSeparateEpubs for dual-voice TTS
 */
export async function generateBilingualEpub(
  pairs: SentencePair[],
  title: string,
  sourceLang: string,
  targetLang: string,
  outputPath: string,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<string> {
  if (onProgress) {
    onProgress({
      phase: 'epub',
      currentSentence: 0,
      totalSentences: pairs.length,
      percentage: 90,
      message: 'Generating bilingual EPUB...',
    });
  }

  // Generate HTML content
  const htmlContent = generateBilingualHtml(pairs, sourceLang, targetLang);

  // Create EPUB structure
  const epubDir = path.dirname(outputPath);
  const tempDir = path.join(epubDir, '.epub-temp-' + crypto.randomBytes(4).toString('hex'));

  try {
    // Create directory structure
    await fs.mkdir(path.join(tempDir, 'META-INF'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'OEBPS'), { recursive: true });

    // Write mimetype (must be first, uncompressed)
    await fs.writeFile(path.join(tempDir, 'mimetype'), 'application/epub+zip');

    // Write container.xml
    await fs.writeFile(
      path.join(tempDir, 'META-INF', 'container.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    );

    // Write content.opf
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'content.opf'),
      generateContentOpf(title, sourceLang, targetLang)
    );

    // Write chapter
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'chapter1.xhtml'),
      htmlContent
    );

    // Write CSS
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'styles.css'),
      generateBilingualCss()
    );

    // Write TOC
    await fs.writeFile(
      path.join(tempDir, 'OEBPS', 'toc.ncx'),
      generateTocNcx(title)
    );

    // Create EPUB (ZIP file with proper structure)
    await createEpubZip(tempDir, outputPath);

    if (onProgress) {
      onProgress({
        phase: 'complete',
        currentSentence: pairs.length,
        totalSentences: pairs.length,
        percentage: 100,
        message: 'Bilingual EPUB created successfully',
      });
    }

    return outputPath;
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create EPUB ZIP file from directory
 */
const deflateRawAsync = promisify(zlib.deflateRaw);

function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function collectFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectFiles(path.join(dir, entry.name), relative));
    } else {
      results.push(relative);
    }
  }
  return results;
}

async function createEpubZip(sourceDir: string, outputPath: string): Promise<void> {
  try {
    await fs.unlink(outputPath);
  } catch {
    // File doesn't exist, that's fine
  }

  // Build file list: mimetype first (uncompressed), then META-INF and OEBPS (compressed)
  const zipEntries: Array<{ name: string; data: Buffer; compress: boolean }> = [];

  // mimetype must be first entry, stored uncompressed (EPUB spec)
  const mimetypeData = await fs.readFile(path.join(sourceDir, 'mimetype'));
  zipEntries.push({ name: 'mimetype', data: mimetypeData, compress: false });

  // Add META-INF and OEBPS recursively
  for (const subdir of ['META-INF', 'OEBPS']) {
    const subdirPath = path.join(sourceDir, subdir);
    try {
      const files = await collectFiles(subdirPath, subdir);
      for (const file of files) {
        const data = await fs.readFile(path.join(sourceDir, file));
        zipEntries.push({ name: file, data, compress: true });
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  // Write ZIP using the same format as epub-processor.ts ZipWriter
  const centralDirectory: Buffer[] = [];
  const fileData: Buffer[] = [];
  let offset = 0;

  for (const entry of zipEntries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    let compressedData: Buffer;
    let compressionMethod: number;

    if (entry.compress && entry.data.length > 0) {
      compressedData = await deflateRawAsync(entry.data) as Buffer;
      compressionMethod = 8; // Deflate
    } else {
      compressedData = entry.data;
      compressionMethod = 0; // Store
    }

    const crc = crc32(entry.data);

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);

    fileData.push(localHeader, compressedData);

    // Central directory entry
    const centralEntry = Buffer.alloc(46 + nameBuffer.length);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(compressionMethod, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compressedData.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBuffer.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    nameBuffer.copy(centralEntry, 46);

    centralDirectory.push(centralEntry);
    offset += localHeader.length + compressedData.length;
  }

  // End of central directory
  const centralDirSize = centralDirectory.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zipEntries.length, 8);
  eocd.writeUInt16LE(zipEntries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const output = Buffer.concat([...fileData, ...centralDirectory, eocd]);
  await fs.writeFile(outputPath, output);

  console.log(`[BILINGUAL] Created EPUB: ${outputPath}`);
}

/**
 * Generate bilingual HTML content
 */
function generateBilingualHtml(
  pairs: SentencePair[],
  sourceLang: string,
  targetLang: string
): string {
  const sentencePairsHtml = pairs.map(pair => `
    <div class="sentence-pair">
      <p class="source" lang="${sourceLang}">${escapeHtml(pair.source)}</p>
      <p class="target" lang="${targetLang}">${escapeHtml(pair.target)}</p>
    </div>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${sourceLang}">
<head>
  <meta charset="UTF-8"/>
  <title>Bilingual Content</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <section class="bilingual-content">
    ${sentencePairsHtml}
  </section>
</body>
</html>`;
}

/**
 * Generate content.opf for EPUB
 */
function generateContentOpf(title: string, sourceLang: string, targetLang: string): string {
  const uuid = crypto.randomUUID();

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:language>${sourceLang}</dc:language>
    <dc:language>${targetLang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`;
}

/**
 * Generate TOC NCX for EPUB
 * Uses "bookforge." as chapter label - e2a uses first sentence as chapter title fallback,
 * so we use a known marker that bilingual assembly can skip (sentence 0)
 */
function generateTocNcx(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle>
    <text>${escapeHtml(title)}</text>
  </docTitle>
  <navMap>
    <navPoint id="chapter1" playOrder="1">
      <navLabel>
        <text>bookforge.</text>
      </navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;
}

/**
 * Generate CSS for bilingual content
 */
function generateBilingualCss(): string {
  return `
body {
  font-family: Georgia, serif;
  line-height: 1.6;
  margin: 2em;
}

.bilingual-content {
  max-width: 800px;
  margin: 0 auto;
}

.sentence-pair {
  margin-bottom: 1.5em;
  padding-bottom: 1em;
  border-bottom: 1px solid #eee;
}

.source {
  font-size: 1em;
  color: #333;
  margin-bottom: 0.5em;
}

.target {
  font-size: 0.95em;
  color: #666;
  font-style: italic;
  margin: 0;
  padding-left: 1em;
  border-left: 3px solid #ddd;
}
`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Ensure a chapter title ends with a period for TTS readability.
 * TTS engines often run headings into the following text without punctuation.
 */
function ensureTitleEndsWithPunctuation(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;
  const lastChar = trimmed[trimmed.length - 1];
  if (['.', '!', '?', ':', ';'].includes(lastChar)) {
    return trimmed;
  }
  return trimmed + '.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Processing Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process text through the full bilingual pipeline:
 * 1. Cleanup (optional, chunk-based)
 * 2. Sentence splitting
 * 3. Batched translation
 * 4. EPUB generation
 */
export async function processBilingualText(
  config: BilingualProcessingConfig,
  outputPath: string,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<BilingualResult> {
  try {
    // Phase 1: Cleanup (if enabled)
    let processedText = config.sourceText;

    if (config.enableCleanup) {
      if (onProgress) {
        onProgress({
          phase: 'cleanup',
          currentSentence: 0,
          totalSentences: 0,
          percentage: 0,
          message: 'Starting text cleanup...',
        });
      }

      processedText = await cleanupText(config.sourceText, config, onProgress);
      console.log(`[BILINGUAL] Cleanup complete: ${config.sourceText.length} -> ${processedText.length} chars`);
    }

    // Phase 2: Split into sentences
    if (onProgress) {
      onProgress({
        phase: 'splitting',
        currentSentence: 0,
        totalSentences: 0,
        percentage: 30,
        message: 'Splitting text into sentences...',
      });
    }

    const sentences = splitIntoSentences(processedText, config.sourceLang);
    console.log(`[BILINGUAL] Split into ${sentences.length} sentences`);

    // Phase 3: Translate sentences in batches
    const pairs = await translateSentences(sentences, config, onProgress);
    console.log(`[BILINGUAL] Translated ${pairs.length} sentence pairs`);

    // Phase 4: Generate bilingual EPUB
    const epubPath = await generateBilingualEpub(
      pairs,
      `Bilingual Article`,
      config.sourceLang,
      config.targetLang,
      outputPath,
      onProgress
    );

    return {
      success: true,
      sentences: pairs,
      epubPath,
    };
  } catch (error) {
    console.error('[BILINGUAL] Processing failed:', error);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

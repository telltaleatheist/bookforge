/**
 * AI Bridge - Multi-provider AI wrapper for text cleanup
 *
 * Supports multiple AI providers:
 * - Ollama (local, free) at localhost:11434
 * - Claude (Anthropic API)
 * - OpenAI (ChatGPT API)
 */

import { BrowserWindow, powerSaveBlocker } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { getCleanupPromptForLanguage, hasLanguageSpecificPrompt } from './ai-cleanup-prompts';

// Power save blocker ID - prevents system sleep during AI cleanup
let aiPowerBlockerId: number | null = null;

/**
 * Start preventing system sleep (call when AI cleanup starts)
 */
function startAIPowerBlock(): void {
  if (aiPowerBlockerId === null) {
    aiPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[AI-BRIDGE] Power save blocker started (ID:', aiPowerBlockerId, ')');
  }
}

/**
 * Stop preventing system sleep (call when AI cleanup completes)
 */
function stopAIPowerBlock(): void {
  if (aiPowerBlockerId !== null) {
    powerSaveBlocker.stop(aiPowerBlockerId);
    console.log('[AI-BRIDGE] Power save blocker stopped');
    aiPowerBlockerId = null;
  }
}
import {
  extractChapterAsText,
  splitTextIntoParagraphs,
  rebuildChapterFromParagraphs
} from './epub-processor.js';
import {
  startDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';


// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AIProvider = 'ollama' | 'claude' | 'openai';

export interface AIProviderConfig {
  provider: AIProvider;
  ollama?: {
    baseUrl: string;
    model: string;
  };
  claude?: {
    apiKey: string;
    model: string;
  };
  openai?: {
    apiKey: string;
    model: string;
  };
}

export interface ProviderConnectionResult {
  available: boolean;
  error?: string;
  models?: string[];
}

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

export interface CleanupProgress {
  chapterId: string;
  chapterTitle: string;
  currentChunk: number;
  totalChunks: number;
  percentage: number;
}

export interface CleanupResult {
  success: boolean;
  cleanedText?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';
const CHUNK_SIZE = 8000; // characters per chunk

// Skipped chunk tracking (reset at start of each cleanup job)
export interface SkippedChunk {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number (e.g., "Chunk 5/121")
  totalChunks: number;         // Total chunks in the job
  reason: 'copyright' | 'content-skip' | 'ai-refusal' | 'truncated';
  text: string;           // The original text that was skipped
  aiResponse?: string;    // What the AI actually returned (for debugging)
}

let copyrightFallbackCount = 0;
let skipFallbackCount = 0;  // Chunks where AI returned [SKIP] for non-trivial content
let markerMismatchCount = 0;  // Chunks where AI dropped/added [[BLOCK]] markers
let truncatedFallbackCount = 0;  // Chunks where AI returned <70% of input (non-copyright)
let skippedChunks: SkippedChunk[] = [];  // Detailed tracking of all skipped chunks
const CHUNK_SEARCH_WINDOW = 1000; // characters to search for logical break point
const TIMEOUT_MS = 180000; // 3 minutes per chunk
const MAX_FALLBACK_COUNT = 10;  // Abort job if this many chunks fall back to original text

/**
 * Get total number of chunks that fell back to original text (all failure types)
 */
function getTotalFallbackCount(): number {
  return copyrightFallbackCount + skipFallbackCount + truncatedFallbackCount;
}

/**
 * Check if we've exceeded the max fallback threshold
 * Throws an error to abort the job if too many chunks have failed
 */
function checkFallbackThreshold(): void {
  const totalFallbacks = getTotalFallbackCount();
  if (totalFallbacks >= MAX_FALLBACK_COUNT) {
    throw new Error(`TOO_MANY_FALLBACKS: ${totalFallbacks} chunks fell back to original text (threshold: ${MAX_FALLBACK_COUNT}). Aborting cleanup to prevent poor quality output.`);
  }
}

// Markers that indicate the AI couldn't process the text
const SKIP_MARKERS = ['[SKIP]', '[NO READABLE TEXT]', '[NOTHING TO CLEAN]'];

// Patterns that indicate AI went into conversational mode instead of processing text
const AI_ASSISTANT_PATTERNS = [
  /^(here is|here's) (the|your)/i,
  /^(i'll|i will|i can|i'd be) (help|assist|happy|glad)/i,
  /^(could you|can you|please provide|please paste)/i,
  /^(it seems|it appears|it looks like) (there is no|like there's no|you haven't)/i,
  /^(i don't see|i cannot see|there is no|there's no) (any )?(text|content)/i,
  /^(let me|allow me) (help|assist|know)/i,
  /\bplease (provide|share|paste|send)\b/i,
  /\bi('d| would) be happy to\b/i,
  /\bno (text|content) (was |has been )?(provided|given|shared)\b/i,
];

/**
 * Check if AI output indicates a skip condition or conversational response.
 * Returns { skip: true, reason: string } if the output should be discarded,
 * or { skip: false } if the output is valid.
 */
function checkAIOutput(output: string, originalText: string): { skip: boolean; reason?: string } {
  const trimmed = output.trim();

  // Check for explicit skip markers
  for (const marker of SKIP_MARKERS) {
    if (trimmed === marker || trimmed.startsWith(marker)) {
      return { skip: true, reason: `AI returned skip marker: ${marker}` };
    }
  }

  // Check for AI assistant conversation patterns (check first 200 chars)
  const beginning = trimmed.substring(0, 200).toLowerCase();
  for (const pattern of AI_ASSISTANT_PATTERNS) {
    if (pattern.test(beginning)) {
      return { skip: true, reason: `AI went conversational: "${trimmed.substring(0, 50)}..."` };
    }
  }

  return { skip: false };
}

/**
 * Find the best break point for chunking text.
 * Priority: paragraph break > sentence end > word boundary
 * Returns the index where the chunk should end (exclusive).
 *
 * Handles cross-platform line endings (\r\n, \n, \r) and various paragraph markers.
 */
function findBestBreakPoint(text: string, targetEnd: number, minStart: number): number {
  if (targetEnd >= text.length) return text.length;

  const searchStart = Math.max(targetEnd - CHUNK_SEARCH_WINDOW, minStart);
  const searchText = text.substring(searchStart, targetEnd);

  // Priority 1: Paragraph break - look for blank lines (various formats)
  // Match: \n\n, \r\n\r\n, \n\r\n, or multiple newlines with optional whitespace
  const paragraphPatterns = [
    /\r?\n\s*\r?\n/g,  // Blank line (with optional whitespace between)
    /\r\n\r\n/g,       // Windows double line break
    /\n\n/g,           // Unix double line break
  ];

  let lastParagraphEnd = -1;
  for (const pattern of paragraphPatterns) {
    let match;
    pattern.lastIndex = 0; // Reset regex
    while ((match = pattern.exec(searchText)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (matchEnd > lastParagraphEnd) {
        lastParagraphEnd = matchEnd;
      }
    }
  }
  if (lastParagraphEnd > 0) {
    return searchStart + lastParagraphEnd;
  }

  // Priority 2: Sentence end (. ! ? followed by space, newline, or quote)
  // Search from end to find the last sentence boundary
  let lastSentenceEnd = -1;
  for (let i = searchText.length - 1; i > 0; i--) {
    const char = searchText[i - 1];
    const nextChar = searchText[i];
    if ((char === '.' || char === '!' || char === '?') &&
        (nextChar === ' ' || nextChar === '\n' || nextChar === '\r' ||
         nextChar === '"' || nextChar === "'" || nextChar === '\u201C' || nextChar === '\u201D' ||
         nextChar === '\u2018' || nextChar === '\u2019')) {
      lastSentenceEnd = i;
      break;
    }
  }
  if (lastSentenceEnd > 0) {
    return searchStart + lastSentenceEnd;
  }

  // Priority 3: Single line break (may indicate paragraph in some formats)
  const lastCRLF = searchText.lastIndexOf('\r\n');
  const lastLF = searchText.lastIndexOf('\n');
  const lastCR = searchText.lastIndexOf('\r');
  const lastLineBreak = Math.max(lastCRLF, lastLF, lastCR);
  if (lastLineBreak > 0) {
    // Move past the line break
    const breakLen = (lastCRLF === lastLineBreak) ? 2 : 1;
    return searchStart + lastLineBreak + breakLen;
  }

  // Priority 4: Word boundary (space)
  const lastSpace = searchText.lastIndexOf(' ');
  if (lastSpace > 0) {
    return searchStart + lastSpace + 1;
  }

  // Fallback: cut at target (shouldn't happen with reasonable text)
  return targetEnd;
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR Cleanup Prompt
// ─────────────────────────────────────────────────────────────────────────────

// Path to the editable prompt files
const PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'tts-cleanup.txt');
const PROMPT_FILE_PATH_FULL = path.join(__dirname, 'prompts', 'tts-cleanup-full.txt');

// Default prompt (used if file doesn't exist)
const DEFAULT_PROMPT = `You are preparing ebook text for text-to-speech (TTS) audiobook narration.

OUTPUT FORMAT: Respond with ONLY the processed book text. Start immediately with the book content.
FORBIDDEN: Never write "Here is", "I'll help", "Could you", "please provide", or ANY conversational language. You are not having a conversation.

CRITICAL RULES:
- NEVER summarize. Output must be the same length as input (with minor variations from edits).
- NEVER paraphrase or rewrite sentences unless fixing an error.
- NEVER skip or omit any content.
- NEVER respond as if you are an AI assistant.
- Process the text LINE BY LINE, making only the specific fixes below.

EDGE CASES:
- Empty/whitespace input → output: [SKIP]
- Garbage/unreadable characters → output: [SKIP]
- Just titles/metadata with no prose → output: [SKIP]
- Short but readable text → process normally

NUMBERS → SPOKEN WORDS:
- Years: "1923" → "nineteen twenty-three", "2001" → "two thousand one"
- Decades: "the 1930s" → "the nineteen thirties"
- Ordinals: "1st" → "first", "21st" → "twenty-first"
- Cardinals: "3 men" → "three men"
- Currency: "$5.50" → "five dollars and fifty cents"
- Roman numerals: "Chapter IV" → "Chapter Four", "Henry VIII" → "Henry the Eighth"

EXPAND ABBREVIATIONS:
- Titles: "Mr." → "Mister", "Dr." → "Doctor"
- Common: "e.g." → "for example", "i.e." → "that is", "etc." → "and so on"

FIX OCR ERRORS: broken words, character misreads (rn→m, cl→d).
FIX STYLISTIC SPACING: collapse decorative letter/word spacing into normal readable text.

REMOVE REFERENCE NUMBERS:
- Stray numbers at the end of sentences or paragraphs (footnote/endnote references)
- Numbers that appear after punctuation and don't fit the prose context
- Superscript-style reference markers that got flattened into text
- Pattern: sentence ending with punctuation followed by a bare number (e.g., "...the end." 5 or "...was true." 12)
- These are citation markers, not part of the narrative - remove them entirely

REMOVE: page numbers, running headers/footers, stray artifacts.

Start your response with the first word of the book text. No introduction.`;

// Default prompt for full mode (used if file doesn't exist)
const DEFAULT_PROMPT_FULL = `You are preparing ebook XHTML content for text-to-speech (TTS) audiobook narration.
The input contains HTML tags like <p>, <h1>, <em>, etc. PRESERVE ALL TAGS.
OUTPUT: Respond with ONLY the processed XHTML. No preamble.
NUMBERS → SPOKEN WORDS, EXPAND ABBREVIATIONS, FIX OCR ERRORS.
Start your response with the first character of the XHTML content.`;

/**
 * Load the TTS cleanup prompt from file
 */
export async function loadPrompt(mode: 'structure' | 'full' = 'structure'): Promise<string> {
  const filePath = mode === 'full' ? PROMPT_FILE_PATH_FULL : PROMPT_FILE_PATH;
  const defaultPrompt = mode === 'full' ? DEFAULT_PROMPT_FULL : DEFAULT_PROMPT;
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return content.trim();
  } catch {
    // File doesn't exist, return default
    return defaultPrompt;
  }
}

/**
 * Save the TTS cleanup prompt to file.
 * Also updates the cached prompt so changes take effect immediately.
 */
export async function savePrompt(prompt: string): Promise<void> {
  // Ensure directory exists
  const dir = path.dirname(PROMPT_FILE_PATH);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(PROMPT_FILE_PATH, prompt, 'utf-8');
  // Update the cache so changes take effect immediately without restart
  cachedPrompt = prompt;
}

/**
 * Get the prompt file path (for reference)
 */
export function getPromptFilePath(): string {
  return PROMPT_FILE_PATH;
}

/**
 * Force reload the prompt from file.
 * Useful if the file was modified externally.
 */
export async function reloadPrompt(): Promise<string> {
  cachedPrompt = await loadPrompt();
  console.log('[AI-BRIDGE] Prompt reloaded from file, length:', cachedPrompt.length);
  return cachedPrompt;
}

/**
 * Build the TTS optimization prompt.
 * Loads from file if available, otherwise uses default.
 */
async function buildCleanupPromptAsync(): Promise<string> {
  return await loadPrompt();
}

/**
 * Synchronous version for backwards compatibility
 * Uses cached prompt or default
 */
let cachedPrompt: string | null = null;
let cachedPromptFull: string | null = null;

function buildCleanupPrompt(_options: AICleanupOptions, mode: 'structure' | 'full' = 'structure'): string {
  if (mode === 'full') {
    return cachedPromptFull || DEFAULT_PROMPT_FULL;
  }
  return cachedPrompt || DEFAULT_PROMPT;
}

// Load prompts on module init
loadPrompt('structure').then(prompt => {
  cachedPrompt = prompt;
}).catch(() => {
  cachedPrompt = DEFAULT_PROMPT;
});

loadPrompt('full').then(prompt => {
  cachedPromptFull = prompt;
}).catch(() => {
  cachedPromptFull = DEFAULT_PROMPT_FULL;
});

/**
 * Build a simple OCR cleanup prompt for queue processing (entire EPUB).
 * Same as buildCleanupPrompt but exposed for queue use.
 * Now supports language-specific prompts to avoid unwanted translation behavior.
 */
export function getOcrCleanupSystemPrompt(mode: 'structure' | 'full' = 'structure', languageCode?: string): string {
  // If a language code is provided and we have a specific prompt for it, use that
  if (languageCode && hasLanguageSpecificPrompt(languageCode)) {
    const prompt = getCleanupPromptForLanguage(languageCode, mode);
    console.log(`[AI-BRIDGE] Using ${languageCode.toUpperCase()} language-specific prompt (mode: ${mode})`);
    return prompt;
  }

  // Otherwise fall back to the default English prompt
  const prompt = buildCleanupPrompt({ fixHyphenation: true, fixOcrArtifacts: true, expandAbbreviations: true }, mode);
  // Debug: log first 200 chars of prompt to verify it's the correct version
  console.log(`[AI-BRIDGE] Using system prompt (mode: ${mode}, first 200 chars):`, prompt.substring(0, 200).replace(/\n/g, ' '));
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detailed Cleanup - User-Marked Deletions as Few-Shot Examples
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletedBlockExample {
  text: string;
  category: 'header' | 'footer' | 'page_number' | 'custom' | 'block';
  page?: number;
}

/**
 * Build the examples section for detailed cleanup mode.
 * Groups examples by category and formats them for the AI prompt.
 */
function buildExamplesSection(examples: DeletedBlockExample[]): string {
  if (!examples || examples.length === 0) return '';

  // Group examples by category
  const groups: Record<string, string[]> = {
    header: [],
    footer: [],
    page_number: [],
    custom: [],
    block: []
  };

  for (const example of examples) {
    const category = example.category || 'block';
    if (groups[category]) {
      groups[category].push(example.text);
    }
  }

  // Build the formatted section - CONSERVATIVE approach
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    'USER-MARKED DELETIONS (REFERENCE EXAMPLES)',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    'The user has marked specific text for removal. Use these as REFERENCE EXAMPLES.',
    '',
    'BE VERY CONSERVATIVE. Only remove text that is:',
    '1. An EXACT or near-exact match to the examples below',
    '2. CLEARLY the same type of structural element (e.g., standalone page numbers)',
    '3. Obviously NOT part of narrative content',
    '',
    'EXAMPLES OF SAFE REMOVALS:',
    '- Standalone page numbers: "127" on its own line → also remove "128", "129"',
    '- Running headers that are IDENTICAL FORMAT: "CHAPTER ONE" → "CHAPTER TWO"',
    '- Clear structural markers that exactly match the pattern shown',
    ''
  ];

  if (groups.header.length > 0) {
    lines.push('Header examples (remove ONLY exact format matches):');
    for (const text of groups.header.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.footer.length > 0) {
    lines.push('Footer examples (remove ONLY exact format matches):');
    for (const text of groups.footer.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.page_number.length > 0) {
    lines.push('Page number examples (remove standalone numbers matching this format):');
    for (const text of groups.page_number.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.custom.length > 0) {
    lines.push('Custom patterns (remove ONLY close matches):');
    for (const text of groups.custom.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.block.length > 0) {
    lines.push('Other examples (be very conservative):');
    for (const text of groups.block.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  lines.push('───────────────────────────────────────────────────────────────────────────────');
  lines.push('REMOVAL RULES (CONSERVATIVE):');
  lines.push('');
  lines.push('ONLY REMOVE text that meets ALL of these criteria:');
  lines.push('1. Matches an example above in format/structure (not just content type)');
  lines.push('2. Is clearly NOT part of a sentence or paragraph');
  lines.push('3. Appears to be a standalone structural element');
  lines.push('');
  lines.push('DO NOT REMOVE:');
  lines.push('- Any text that is part of a sentence');
  lines.push('- Any text that discusses the subject matter');
  lines.push('- Footnotes or citations (unless EXACT pattern match to examples)');
  lines.push('- Anything you are uncertain about');
  lines.push('');
  lines.push('WHEN IN DOUBT, KEEP THE TEXT.');
  lines.push('It is much better to leave unwanted text than to delete wanted content.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build the "Simplify for Language Learners" prompt section.
 * This instructs the AI to rewrite archaic or complex language
 * into simple, modern English suitable for A1-B1 level language learners.
 */
function buildSimplifyForChildrenSection(): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    'SIMPLIFY FOR LANGUAGE LEARNING',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    'IMPORTANT: This text will be used for language learning audiobooks. Rewrite it for:',
    '- A1-B1 level English learners (beginner to lower-intermediate)',
    '- Clear pronunciation when read by text-to-speech',
    '- Modern, everyday American English that learners will actually encounter',
    '',
    'SIMPLIFICATION RULES:',
    '',
    '1. VOCABULARY - Use high-frequency words that A1-B1 learners know:',
    '   - "perpetually quarreling" → "always fighting"',
    '   - "wrathful" → "very angry"',
    '   - "tyrannical" → "cruel and controlling"',
    '   - "proclamation" → "official announcement"',
    '   - "amity" → "friendship"',
    '   - "impunity" → "without punishment"',
    '   - "hitherto" → "until now"',
    '   - "whence" → "from where"',
    '   - "thereof" → "of it"',
    '   - "whilst" → "while"',
    '   - "amongst" → "among"',
    '',
    '2. SENTENCE STRUCTURE for A1-B1 comprehension:',
    '   - Keep sentences under 15 words when possible',
    '   - Use simple Subject-Verb-Object structure',
    '   - One main idea per sentence',
    '   - Use common linking words: and, but, because, so, when, if',
    '   - Avoid complex subordinate clauses',
    '',
    '3. GRAMMAR appropriate for A1-B1 learners:',
    '   - Use common tenses: present, past, present perfect, future with "will"',
    '   - Clear pronouns - avoid ambiguous "he/she/it/they" references',
    '   - Prefer active voice over passive voice',
    '   - Use natural contractions: "don\'t", "isn\'t", "I\'ll", "we\'re"',
    '   - Avoid rare grammatical structures and inversions',
    '',
    '4. CULTURAL ACCESSIBILITY:',
    '   - Replace idioms with clear meanings: "piece of cake" → "very easy"',
    '   - Explain or simplify cultural references when necessary',
    '   - Use internationally understood contexts when possible',
    '',
    '5. PRESERVE CONTENT:',
    '   - Keep ALL plot points, characters, and important details',
    '   - Maintain the story\'s message and tone',
    '   - Don\'t remove content - just make it more accessible',
    '',
    '6. LISTENING COMPREHENSION:',
    '   - Structure sentences for clear audio understanding',
    '   - Avoid garden path sentences or ambiguous phrasing',
    '   - Use natural speech patterns and rhythm',
    '',
    'Target level: A1-B1 CEFR (Common European Framework of Reference)',
    'The text should challenge learners appropriately while remaining comprehensible.',
    'Every sentence must be clear for language learners to understand when listening.',
    ''
  ];

  return lines.join('\n');
}

/**
 * Build a standalone "Simplify Only" system prompt.
 * Used when enableAiCleanup is false but simplifyForChildren is true.
 * This is a simpler prompt that focuses solely on language simplification.
 */
function getSimplifyOnlySystemPrompt(): string {
  const lines: string[] = [
    'You are an expert at simplifying text for language learning audiobooks.',
    '',
    'Your task is to rewrite text for:',
    '- A1-B1 level English learners (beginner to lower-intermediate CEFR)',
    '- Clear comprehension when listening to text-to-speech',
    '- Modern, everyday American English that learners need to know',
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    'SIMPLIFICATION RULES',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    '1. VOCABULARY - Use high-frequency words that A1-B1 learners know:',
    '   - "perpetually quarreling" → "always fighting"',
    '   - "wrathful" → "very angry"',
    '   - "tyrannical" → "cruel and controlling"',
    '   - "proclamation" → "official announcement"',
    '   - "amity" → "friendship"',
    '   - "impunity" → "without punishment"',
    '   - "hitherto" → "until now"',
    '   - "whence" → "from where"',
    '   - "thereof" → "of it"',
    '   - "whilst" → "while"',
    '   - "amongst" → "among"',
    '',
    '2. SENTENCE STRUCTURE for A1-B1 comprehension:',
    '   - Keep sentences under 15 words when possible',
    '   - Use simple Subject-Verb-Object structure',
    '   - One main idea per sentence',
    '   - Use common linking words: and, but, because, so, when, if',
    '   - Natural contractions: "don\'t", "isn\'t", "I\'ll", "we\'re"',
    '',
    '3. GRAMMAR appropriate for A1-B1 learners:',
    '   - Use common tenses: present, past, present perfect, future with "will"',
    '   - Clear pronouns - avoid ambiguous "he/she/it/they" references',
    '   - Prefer active voice: "The wolf caught him" NOT "He was caught by the wolf"',
    '   - Avoid rare grammatical structures and inversions',
    '   - Use standard word order - avoid poetic or unusual arrangements',
    '',
    '4. CULTURAL ACCESSIBILITY:',
    '   - Replace idioms with clear meanings: "piece of cake" → "very easy"',
    '   - Simplify cultural references for international learners',
    '   - Use globally understood contexts when possible',
    '',
    '5. PRESERVE CONTENT:',
    '   - Keep ALL plot points, characters, dialogue, and details',
    '   - Maintain the story\'s message, tone, and style',
    '   - Don\'t remove content - just make it more accessible',
    '',
    '6. PRESERVE FORMATTING: Keep paragraph breaks, chapters, and structure intact.',
    '   Only change the words themselves, not the layout.',
    '',
    'Target: A1-B1 CEFR level (beginner to lower-intermediate)',
    'The goal is comprehensible input that helps learners improve their English.',
    'Every sentence must be clear when heard, not just when read.',
    '',
    'Return ONLY the simplified text, no explanations or commentary.'
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if Ollama is running and accessible
 */
export async function checkConnection(): Promise<{ connected: boolean; models?: OllamaModel[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { connected: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const models: OllamaModel[] = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at
    }));

    return { connected: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { connected: false, error: message };
  }
}

/**
 * Get list of available models
 */
export async function getModels(): Promise<OllamaModel[]> {
  const result = await checkConnection();
  return result.models || [];
}

/**
 * Check if a specific model is available
 */
export async function hasModel(modelName: string): Promise<boolean> {
  const models = await getModels();
  return models.some(m => m.name === modelName || m.name.startsWith(modelName + ':'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Connection Checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check connection for any AI provider
 */
export async function checkProviderConnection(provider: AIProvider): Promise<ProviderConnectionResult> {
  switch (provider) {
    case 'ollama':
      return checkOllamaConnection();
    case 'claude':
      return checkClaudeConnection();
    case 'openai':
      return checkOpenAIConnection();
    default:
      return { available: false, error: `Unknown provider: ${provider}` };
  }
}

/**
 * Check Ollama connection
 */
async function checkOllamaConnection(): Promise<ProviderConnectionResult> {
  const result = await checkConnection();
  return {
    available: result.connected,
    error: result.error,
    models: result.models?.map(m => m.name)
  };
}

/**
 * Check Claude (Anthropic) API connection
 * Note: We can't validate the API key without making a billable request,
 * so we just check if the key format looks valid
 */
async function checkClaudeConnection(): Promise<ProviderConnectionResult> {
  // Claude API keys start with "sk-ant-"
  // We'll need to get the API key from settings in the actual implementation
  // For now, return a placeholder that indicates we need the key
  return {
    available: false,
    error: 'API key validation requires settings configuration'
  };
}

/**
 * Get available Claude models by querying the Anthropic API
 * Uses the /v1/models endpoint to fetch the actual list of available models
 */
export async function getClaudeModels(apiKey: string): Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }> {
  if (!apiKey) {
    return { success: false, error: 'No API key provided' };
  }

  // Verify the key format
  if (!apiKey.startsWith('sk-ant-')) {
    return { success: false, error: 'Invalid API key format (should start with sk-ant-)' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || response.statusText;

      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      }
      if (response.status === 403) {
        return { success: false, error: 'API key does not have access' };
      }

      return { success: false, error: `API error: ${errorMessage}` };
    }

    const data = await response.json();

    // Filter to only include chat models (claude-*) and format them nicely
    const models: { value: string; label: string }[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        const id = model.id;
        // Skip non-Claude models and embedding models
        if (!id.startsWith('claude-') || id.includes('embedding')) {
          continue;
        }

        // Create a friendly label
        // Check for 4.5 versions first (they contain 'opus-4-5' or 'sonnet-4-5')
        let label = id;
        if (id.includes('opus-4-5')) {
          label = 'Claude Opus 4.5';
        } else if (id.includes('sonnet-4-5')) {
          label = 'Claude Sonnet 4.5';
        } else if (id.includes('opus-4')) {
          label = 'Claude Opus 4';
        } else if (id.includes('sonnet-4')) {
          label = 'Claude Sonnet 4';
        } else if (id.includes('3-5-sonnet')) {
          label = 'Claude 3.5 Sonnet';
        } else if (id.includes('3-5-haiku')) {
          label = 'Claude 3.5 Haiku';
        } else if (id.includes('3-opus')) {
          label = 'Claude 3 Opus';
        } else if (id.includes('3-sonnet')) {
          label = 'Claude 3 Sonnet';
        } else if (id.includes('3-haiku')) {
          label = 'Claude 3 Haiku';
        }

        models.push({ value: id, label });
      }
    }

    // Sort models: Sonnet 4.5 first (recommended), then Opus 4.5, then older models
    models.sort((a, b) => {
      // Put sonnet-4-5 first as recommended (best balance of speed/quality)
      if (a.value.includes('sonnet-4-5') && !b.value.includes('sonnet-4-5')) return -1;
      if (!a.value.includes('sonnet-4-5') && b.value.includes('sonnet-4-5')) return 1;
      // Then opus-4-5
      if (a.value.includes('opus-4-5') && !b.value.includes('opus-4-5')) return -1;
      if (!a.value.includes('opus-4-5') && b.value.includes('opus-4-5')) return 1;
      // Then sonnet-4 (non-4.5)
      if (a.value.includes('sonnet-4') && !b.value.includes('sonnet-4')) return -1;
      if (!a.value.includes('sonnet-4') && b.value.includes('sonnet-4')) return 1;
      // Then opus-4 (non-4.5)
      if (a.value.includes('opus-4') && !b.value.includes('opus-4')) return -1;
      if (!a.value.includes('opus-4') && b.value.includes('opus-4')) return 1;
      // Then 3.5 models
      if (a.value.includes('3-5') && !b.value.includes('3-5')) return -1;
      if (!a.value.includes('3-5') && b.value.includes('3-5')) return 1;
      return a.label.localeCompare(b.label);
    });

    // Mark the first one as recommended
    if (models.length > 0 && !models[0].label.includes('Recommended')) {
      models[0].label += ' (Recommended)';
    }

    return { success: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('abort')) {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: message };
  }
}

/**
 * Check OpenAI API connection
 * Note: We can't validate the API key without making a billable request,
 * so we just check if the key format looks valid
 */
async function checkOpenAIConnection(): Promise<ProviderConnectionResult> {
  // OpenAI API keys start with "sk-"
  // We'll need to get the API key from settings in the actual implementation
  return {
    available: false,
    error: 'API key validation requires settings configuration'
  };
}

/**
 * Get available OpenAI models by querying the OpenAI API
 * Uses the /v1/models endpoint to fetch the actual list of available models
 */
export async function getOpenAIModels(apiKey: string): Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }> {
  if (!apiKey) {
    return { success: false, error: 'No API key provided' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || response.statusText;

      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      }
      if (response.status === 403) {
        return { success: false, error: 'API key does not have access' };
      }

      return { success: false, error: `API error: ${errorMessage}` };
    }

    const data = await response.json();

    // Filter to only include chat models (gpt-*) and format them nicely
    const models: { value: string; label: string }[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        const id = model.id;
        // Only include GPT chat models, skip embedding, whisper, tts, dall-e, etc.
        if (!id.startsWith('gpt-')) {
          continue;
        }
        // Skip instruct and embedding variants
        if (id.includes('instruct') || id.includes('embedding')) {
          continue;
        }

        // Create a friendly label
        let label = id;
        if (id === 'gpt-4o') {
          label = 'GPT-4o';
        } else if (id === 'gpt-4o-mini') {
          label = 'GPT-4o Mini';
        } else if (id.startsWith('gpt-4o-')) {
          // Dated versions like gpt-4o-2024-11-20
          const dateMatch = id.match(/gpt-4o-(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            label = `GPT-4o (${dateMatch[1]})`;
          }
        } else if (id === 'gpt-4-turbo') {
          label = 'GPT-4 Turbo';
        } else if (id.startsWith('gpt-4-turbo-')) {
          const dateMatch = id.match(/gpt-4-turbo-(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            label = `GPT-4 Turbo (${dateMatch[1]})`;
          }
        } else if (id === 'gpt-4') {
          label = 'GPT-4';
        } else if (id.startsWith('gpt-4-')) {
          // Other GPT-4 variants
          label = id.replace('gpt-4-', 'GPT-4 ').replace(/-/g, ' ');
        } else if (id === 'gpt-3.5-turbo') {
          label = 'GPT-3.5 Turbo';
        } else if (id.startsWith('gpt-3.5-turbo-')) {
          label = `GPT-3.5 Turbo (${id.replace('gpt-3.5-turbo-', '')})`;
        }

        models.push({ value: id, label });
      }
    }

    // Sort models: GPT-4o first (recommended), then GPT-4 Turbo, then GPT-4, then GPT-3.5
    models.sort((a, b) => {
      // gpt-4o (non-mini, non-dated) first
      if (a.value === 'gpt-4o' && b.value !== 'gpt-4o') return -1;
      if (a.value !== 'gpt-4o' && b.value === 'gpt-4o') return 1;
      // gpt-4o-mini second
      if (a.value === 'gpt-4o-mini' && b.value !== 'gpt-4o-mini') return -1;
      if (a.value !== 'gpt-4o-mini' && b.value === 'gpt-4o-mini') return 1;
      // Other gpt-4o variants
      if (a.value.startsWith('gpt-4o') && !b.value.startsWith('gpt-4o')) return -1;
      if (!a.value.startsWith('gpt-4o') && b.value.startsWith('gpt-4o')) return 1;
      // gpt-4-turbo
      if (a.value.includes('turbo') && !b.value.includes('turbo')) return -1;
      if (!a.value.includes('turbo') && b.value.includes('turbo')) return 1;
      // gpt-4 before gpt-3.5
      if (a.value.startsWith('gpt-4') && b.value.startsWith('gpt-3')) return -1;
      if (a.value.startsWith('gpt-3') && b.value.startsWith('gpt-4')) return 1;
      return a.label.localeCompare(b.label);
    });

    // Mark the first one as recommended
    if (models.length > 0 && !models[0].label.includes('Recommended')) {
      models[0].label += ' (Recommended)';
    }

    return { success: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('abort')) {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Cancellation Support
// ─────────────────────────────────────────────────────────────────────────────

// Track active cleanup jobs for cancellation
const activeCleanupJobs = new Map<string, AbortController>();

/**
 * Cancel an active cleanup job immediately.
 * Aborts any in-flight HTTP requests and stops chunk processing.
 */
export function cancelCleanupJob(jobId: string): boolean {
  const controller = activeCleanupJobs.get(jobId);
  if (controller) {
    console.log(`[AI-BRIDGE] Cancelling job ${jobId} - aborting all requests`);
    controller.abort();
    activeCleanupJobs.delete(jobId);
    return true;
  }
  return false;
}

/**
 * Check if a job has been cancelled
 */
function isJobCancelled(jobId: string): boolean {
  const controller = activeCleanupJobs.get(jobId);
  return !controller || controller.signal.aborted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Text Cleanup
// ─────────────────────────────────────────────────────────────────────────────

// Metadata for tracking skipped chunks
interface ChunkMeta {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number across all chapters
  totalChunks: number;         // Total chunks in the job
}

/**
 * Clean up a chunk of text using Claude API
 */
async function cleanChunkWithClaude(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string = 'claude-3-5-sonnet-20241022',
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta
): Promise<string> {
  // Detect simplification mode from prompt - expect shorter output
  const isSimplifying = systemPrompt.includes('SIMPLIFY FOR LANGUAGE LEARNING');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        // Claude 3.5 models have 8192 max output tokens, Claude 4+ models have higher limits
        // Cap based on model version to avoid API errors while allowing full capacity
        max_tokens: model.includes('claude-3')
          ? Math.min(8192, Math.max(4096, text.length * 2))
          : Math.max(4096, text.length * 2),  // Claude 4+ can handle more
        system: systemPrompt,
        messages: [
          { role: 'user', content: text }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Claude API error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const cleaned = data.content?.[0]?.text || text;

    // Safeguard 1: Check for skip markers or AI assistant responses
    const outputCheck = checkAIOutput(cleaned, text);
    if (outputCheck.skip) {
      console.warn(`[Claude] ${outputCheck.reason} - using original text`);
      // Track if AI returned [SKIP] for non-trivial content (likely content refusal)
      if (text.length > 1000) {
        skipFallbackCount++;
        console.warn(`[Claude] Suspicious skip: ${text.length} chars is too large for legitimate skip`);
        // Track the skipped chunk with details
        // Strip [[BLOCK]] markers so text can be found in EPUB for editing
        if (chunkMeta) {
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'content-skip',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        }
      }
      return text;
    }

    // Safeguard 2: if AI returns significantly less text, check if it's a copyright refusal.
    // When simplifying, we expect shorter output (use 30% threshold instead of 70%).
    const lengthThreshold = isSimplifying ? 0.3 : 0.7;
    if (cleaned.length < text.length * lengthThreshold) {
      const lowerCleaned = cleaned.toLowerCase();
      const isCopyrightRefusal =
        lowerCleaned.includes('copyright') ||
        lowerCleaned.includes('copyrighted') ||
        lowerCleaned.includes('cannot reproduce') ||
        lowerCleaned.includes('cannot process') ||
        lowerCleaned.includes('lengthy passage') ||
        lowerCleaned.includes('substantial excerpt');

      if (isCopyrightRefusal && text.length >= 2000) {
        // Split chunk in half and process each part separately (8k → 4k → 2k → 1k, then stop)
        console.warn(`[Claude] Copyright refusal detected for ${text.length} char chunk - splitting in half and retrying`);
        const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
        const firstHalf = text.substring(0, midpoint);
        const secondHalf = text.substring(midpoint);

        const cleanedFirst = await cleanChunkWithClaude(firstHalf, systemPrompt, apiKey, model, abortSignal, chunkMeta);
        const cleanedSecond = await cleanChunkWithClaude(secondHalf, systemPrompt, apiKey, model, abortSignal, chunkMeta);

        return cleanedFirst + cleanedSecond;
      }

      console.warn(`Claude returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
      console.warn(`[CLAUDE RESPONSE START]\n${cleaned.substring(0, 500)}...\n[CLAUDE RESPONSE END]`);
      // Track fallbacks - both copyright and general truncation
      if (chunkMeta) {
        if (isCopyrightRefusal) {
          copyrightFallbackCount++;
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'copyright',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        } else {
          // Truncated output (not copyright-related)
          truncatedFallbackCount++;
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'truncated',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        }
      }
      return text;
    }

    return cleaned;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Clean up a chunk of text using OpenAI API
 */
async function cleanChunkWithOpenAI(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string = 'gpt-4o',
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta
): Promise<string> {
  // Detect simplification mode from prompt - expect shorter output
  const isSimplifying = systemPrompt.includes('SIMPLIFY FOR LANGUAGE LEARNING');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(4096, text.length * 2),
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const cleaned = data.choices?.[0]?.message?.content || text;

    // Safeguard 1: Check for skip markers or AI assistant responses
    const outputCheck = checkAIOutput(cleaned, text);
    if (outputCheck.skip) {
      console.warn(`[OpenAI] ${outputCheck.reason} - using original text`);
      // Track if AI returned [SKIP] for non-trivial content (likely content refusal)
      if (text.length > 1000) {
        skipFallbackCount++;
        console.warn(`[OpenAI] Suspicious skip: ${text.length} chars is too large for legitimate skip`);
        // Track the skipped chunk with details
        // Strip [[BLOCK]] markers so text can be found in EPUB for editing
        if (chunkMeta) {
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'content-skip',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        }
      }
      return text;
    }

    // Safeguard 2: if AI returns significantly less text, check if it's a copyright refusal.
    // When simplifying, we expect shorter output (use 30% threshold instead of 70%).
    const lengthThreshold = isSimplifying ? 0.3 : 0.7;
    if (cleaned.length < text.length * lengthThreshold) {
      const lowerCleaned = cleaned.toLowerCase();
      const isCopyrightRefusal =
        lowerCleaned.includes('copyright') ||
        lowerCleaned.includes('copyrighted') ||
        lowerCleaned.includes('cannot reproduce') ||
        lowerCleaned.includes('cannot process') ||
        lowerCleaned.includes('lengthy passage') ||
        lowerCleaned.includes('substantial excerpt');

      if (isCopyrightRefusal && text.length >= 2000) {
        // Split chunk in half and process each part separately (8k → 4k → 2k → 1k, then stop)
        console.warn(`[OpenAI] Copyright refusal detected for ${text.length} char chunk - splitting in half and retrying`);
        const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
        const firstHalf = text.substring(0, midpoint);
        const secondHalf = text.substring(midpoint);

        const cleanedFirst = await cleanChunkWithOpenAI(firstHalf, systemPrompt, apiKey, model, abortSignal, chunkMeta);
        const cleanedSecond = await cleanChunkWithOpenAI(secondHalf, systemPrompt, apiKey, model, abortSignal, chunkMeta);

        return cleanedFirst + cleanedSecond;
      }

      console.warn(`OpenAI returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
      // Track fallbacks - both copyright and general truncation
      if (chunkMeta) {
        if (isCopyrightRefusal) {
          copyrightFallbackCount++;
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'copyright',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        } else {
          // Truncated output (not copyright-related)
          truncatedFallbackCount++;
          skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'truncated',
            text: text,
            aiResponse: cleaned.substring(0, 500)
          });
        }
      }
      return text;
    }

    return cleaned;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Clean up a chunk of text using the configured provider with retry logic
 */
async function cleanChunkWithProvider(
  text: string,
  systemPrompt: string,
  config: AIProviderConfig,
  maxRetries: number = 3,
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check for cancellation before each attempt
    if (abortSignal?.aborted) {
      throw new Error('Job cancelled');
    }

    try {
      let cleanedText: string;
      switch (config.provider) {
        case 'ollama':
          if (!config.ollama?.model) {
            throw new Error('Ollama model not configured');
          }
          cleanedText = await cleanChunk(text, systemPrompt, config.ollama.model, abortSignal, chunkMeta);
          break;
        case 'claude':
          if (!config.claude?.apiKey) {
            throw new Error('Claude API key not configured');
          }
          if (!config.claude?.model) {
            throw new Error('Claude model not configured');
          }
          cleanedText = await cleanChunkWithClaude(text, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal, chunkMeta);
          break;
        case 'openai':
          if (!config.openai?.apiKey) {
            throw new Error('OpenAI API key not configured');
          }
          if (!config.openai?.model) {
            throw new Error('OpenAI model not configured');
          }
          cleanedText = await cleanChunkWithOpenAI(text, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal, chunkMeta);
          break;
        default:
          throw new Error(`Unknown provider: ${config.provider}`);
      }

      return cleanedText;
    } catch (error) {
      // If aborted/cancelled, don't retry - throw immediately
      if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error('Job cancelled');
      }

      lastError = error as Error;
      const isRetryableError = error instanceof Error && (
        error.message.includes('fetch') ||
        error.message.includes('network') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket') ||
        error.message.includes('timeout')
      );

      // Retry on network/connection errors, but not on other errors
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Chunk attempt ${attempt} failed (${error}), retrying in ${attempt * 2}s...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Failed to clean chunk after retries');
}

/**
 * Clean up a single chunk of text using Ollama
 */
async function cleanChunk(
  text: string,
  systemPrompt: string,
  model: string = DEFAULT_MODEL,
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta
): Promise<string> {
  console.log('[AI-BRIDGE] cleanChunk using model:', model);

  // Detect simplification mode from prompt - expect shorter output
  const isSimplifying = systemPrompt.includes('SIMPLIFY FOR LANGUAGE LEARNING');

  // Use AbortController for cancellation support
  const controller = new AbortController();

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    signal: controller.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: 0.1, // Low temperature for consistent output
        num_predict: text.length * 2 // Allow enough tokens
      },
      keep_alive: '5m' // Keep model loaded for 5 minutes
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const cleaned = data.response || text;

  // Safeguard 1: Check for skip markers or AI assistant responses
  const outputCheck = checkAIOutput(cleaned, text);
  if (outputCheck.skip) {
    console.warn(`[Ollama] ${outputCheck.reason} - using original text`);
    // Track if AI returned [SKIP] for non-trivial content
    if (text.length > 1000 && chunkMeta) {
      skipFallbackCount++;
      console.warn(`[Ollama] Suspicious skip: ${text.length} chars is too large for legitimate skip`);
      skippedChunks.push({
        chapterTitle: chunkMeta.chapterTitle,
        chunkIndex: chunkMeta.chunkIndex,
        overallChunkNumber: chunkMeta.overallChunkNumber,
        totalChunks: chunkMeta.totalChunks,
        reason: 'content-skip',
        text: text,
        aiResponse: cleaned.substring(0, 500)
      });
    }
    return text;
  }

  // Safeguard 2: if AI returns significantly less text, it's likely truncating/removing content.
  // When simplifying, we expect shorter output (use 30% threshold instead of 70%).
  const lengthThreshold = isSimplifying ? 0.3 : 0.7;
  if (cleaned.length < text.length * lengthThreshold) {
    console.warn(`Ollama returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
    console.warn(`[OLLAMA RESPONSE START]\n${cleaned.substring(0, 500)}...\n[OLLAMA RESPONSE END]`);
    // Track truncation fallback
    if (chunkMeta) {
      truncatedFallbackCount++;
      skippedChunks.push({
        chapterTitle: chunkMeta.chapterTitle,
        chunkIndex: chunkMeta.chunkIndex,
        overallChunkNumber: chunkMeta.overallChunkNumber,
        totalChunks: chunkMeta.totalChunks,
        reason: 'truncated',
        text: text,
        aiResponse: cleaned.substring(0, 500)
      });
    }
    return text;
  }

  return cleaned;
}

/**
 * Clean up text with streaming progress updates
 */
export async function cleanupText(
  text: string,
  options: AICleanupOptions,
  chapterId: string,
  chapterTitle: string,
  model: string = DEFAULT_MODEL,
  mainWindow?: BrowserWindow | null
): Promise<CleanupResult> {
  // Check connection first
  const connection = await checkConnection();
  if (!connection.connected) {
    return { success: false, error: `Ollama not available: ${connection.error}` };
  }

  // Check if model is available
  if (!(await hasModel(model))) {
    return { success: false, error: `Model '${model}' not found. Run: ollama pull ${model}` };
  }

  // Reload prompt from disk so external changes (e.g., Syncthing pull) take effect
  // without restarting the app
  cachedPrompt = await loadPrompt('structure');
  const systemPrompt = buildCleanupPrompt(options);

  // Split text into chunks at logical break points
  const chunks: string[] = [];

  // If text fits in one chunk, don't split
  if (text.length <= CHUNK_SIZE) {
    chunks.push(text);
  } else {
    let pos = 0;
    while (pos < text.length) {
      const targetEnd = Math.min(pos + CHUNK_SIZE, text.length);
      const end = findBestBreakPoint(text, targetEnd, pos);
      chunks.push(text.substring(pos, end));
      pos = end;
    }
  }

  const uniqueChunks = chunks;

  // Process each chunk
  const cleanedChunks: string[] = [];
  for (let i = 0; i < uniqueChunks.length; i++) {
    // Send progress update
    if (mainWindow) {
      const progress: CleanupProgress = {
        chapterId,
        chapterTitle,
        currentChunk: i + 1,
        totalChunks: uniqueChunks.length,
        percentage: Math.round(((i + 1) / uniqueChunks.length) * 100)
      };
      mainWindow.webContents.send('ai:cleanup-progress', progress);
    }

    // Build chunk metadata for skipped chunk tracking
    const chunkMeta: ChunkMeta = {
      chapterTitle,
      chunkIndex: i,
      overallChunkNumber: i + 1,
      totalChunks: uniqueChunks.length
    };

    try {
      const cleaned = await cleanChunk(uniqueChunks[i], systemPrompt, model, undefined, chunkMeta);
      cleanedChunks.push(cleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed on chunk ${i + 1}: ${message}` };
    }
  }

  return { success: true, cleanedText: cleanedChunks.join('') };
}

/**
 * Clean up a chapter with streaming response for real-time progress
 */
export async function cleanupChapterStreaming(
  text: string,
  options: AICleanupOptions,
  model: string = DEFAULT_MODEL,
  onToken?: (token: string) => void
): Promise<CleanupResult> {
  const connection = await checkConnection();
  if (!connection.connected) {
    return { success: false, error: `Ollama not available: ${connection.error}` };
  }

  // Reload prompt from disk so external changes take effect without restart
  cachedPrompt = await loadPrompt('structure');
  const systemPrompt = buildCleanupPrompt(options);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: text,
        system: systemPrompt,
        stream: true,
        options: {
          temperature: 0.1,
          num_predict: text.length * 2
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.response) {
            fullResponse += data.response;
            if (onToken) {
              onToken(data.response);
            }
          }
        } catch {
          // Ignore JSON parse errors for incomplete chunks
        }
      }
    }

    return { success: true, cleanedText: fullResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB OCR Cleanup (for queue processing)
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubCleanupProgress {
  jobId: string;
  phase: 'loading' | 'processing' | 'saving' | 'complete' | 'error';
  currentChapter: number;
  totalChapters: number;
  currentChunk: number;      // Current chunk number (1-indexed, job-wide)
  totalChunks: number;       // Total chunks in entire job
  percentage: number;
  message?: string;
  error?: string;            // Error message when phase is 'error'
  outputPath?: string;  // Path to cleaned/simplified EPUB (available during processing for diff view)
  // Timing data for dynamic ETA calculation
  chunksCompletedInJob?: number;  // Cumulative chunks completed across all chapters
  totalChunksInJob?: number;      // Total chunks in entire job (same as totalChunks)
  chunkCompletedAt?: number;      // Timestamp when last chunk completed
}

export interface CleanupJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalChapters: number;
  totalChunks: number;
  totalCharacters: number;
  chunksPerMinute: number;
  charactersPerMinute: number;
  model: string;
  success: boolean;
  chaptersProcessed: number;
  copyrightChunksAffected: number;
  contentSkipsAffected: number;
  markerMismatchAffected: number;
  truncatedChunksAffected: number;
  skippedChunksPath?: string;
  error?: string;
}

export interface EpubCleanupResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  chaptersProcessed?: number;
  copyrightIssuesDetected?: boolean;  // True if any chunks triggered copyright refusal
  copyrightChunksAffected?: number;   // Number of chunks that fell back to original due to copyright
  contentSkipsDetected?: boolean;     // True if AI returned [SKIP] for non-trivial content
  contentSkipsAffected?: number;      // Number of chunks where AI refused via [SKIP]
  markerMismatchDetected?: boolean;   // True if AI dropped/added [[BLOCK]] markers
  markerMismatchAffected?: number;    // Number of chunks that fell back due to marker mismatch
  truncatedDetected?: boolean;        // True if AI returned <70% output for some chunks
  truncatedAffected?: number;         // Number of chunks that fell back due to truncation
  skippedChunksPath?: string;         // Path to JSON file containing skipped chunk details
  analytics?: CleanupJobAnalytics;    // Analytics data for the job
}

/**
 * Process an entire EPUB through OCR cleanup.
 * Cleans all chapters and saves a modified EPUB.
 * Requires explicit AI provider configuration - no fallbacks.
 *
 * @param options Optional detailed cleanup settings
 * @param options.deletedBlockExamples User-marked deletions to use as few-shot examples
 * @param options.useDetailedCleanup Whether to enable detailed cleanup mode
 */
export async function cleanupEpub(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: EpubCleanupProgress) => void) | undefined,
  providerConfig: AIProviderConfig,
  options?: {
    deletedBlockExamples?: DeletedBlockExample[];
    useDetailedCleanup?: boolean;
    useParallel?: boolean;
    parallelWorkers?: number;
    cleanupMode?: 'structure' | 'full';
    testMode?: boolean;
    testModeChunks?: number;  // Number of chunks to process in test mode
    enableAiCleanup?: boolean;  // Standard OCR/formatting cleanup (default: true)
    simplifyForChildren?: boolean;  // Simplify for language learners
    cleanupPrompt?: string;  // Custom cleanup prompt (overrides default)
    outputDir?: string;  // Override output directory (default: same dir as input EPUB)
  }
): Promise<EpubCleanupResult> {
  // Debug logging to trace provider selection
  const cleanupMode = options?.cleanupMode || 'structure';
  const testMode = options?.testMode || false;
  const TEST_MODE_CHUNK_LIMIT = options?.testModeChunks || 5;
  console.log('[AI-BRIDGE] cleanupEpub called with:', {
    provider: providerConfig.provider,
    ollamaModel: providerConfig.ollama?.model,
    claudeModel: providerConfig.claude?.model,
    openaiModel: providerConfig.openai?.model,
    useDetailedCleanup: options?.useDetailedCleanup,
    exampleCount: options?.deletedBlockExamples?.length || 0,
    useParallel: options?.useParallel,
    parallelWorkers: options?.parallelWorkers,
    cleanupMode,
    testMode
  });

  // Prevent system sleep during cleanup
  startAIPowerBlock();

  // Reset fallback counters and skipped chunks tracking for this job
  copyrightFallbackCount = 0;
  skipFallbackCount = 0;
  markerMismatchCount = 0;
  truncatedFallbackCount = 0;
  skippedChunks = [];

  // providerConfig is required - no fallbacks
  const config = providerConfig;

  // Validate provider configuration
  if (config.provider === 'ollama') {
    if (!config.ollama?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'Ollama model not specified in config' };
    }
    const connection = await checkConnection();
    if (!connection.connected) {
      stopAIPowerBlock();
      return { success: false, error: `Ollama not available: ${connection.error}` };
    }
    if (!(await hasModel(config.ollama.model))) {
      stopAIPowerBlock();
      return { success: false, error: `Model '${config.ollama.model}' not found. Run: ollama pull ${config.ollama.model}` };
    }
  } else if (config.provider === 'claude') {
    if (!config.claude?.apiKey) {
      stopAIPowerBlock();
      return { success: false, error: 'Claude API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.claude?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'Claude model not specified in config' };
    }
  } else if (config.provider === 'openai') {
    if (!config.openai?.apiKey) {
      stopAIPowerBlock();
      return { success: false, error: 'OpenAI API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.openai?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'OpenAI model not specified in config' };
    }
  } else {
    stopAIPowerBlock();
    return { success: false, error: `Unknown AI provider: ${config.provider}` };
  }

  // Create AbortController for this job - allows immediate cancellation
  const abortController = new AbortController();
  // Increase max listeners to avoid warnings with parallel processing
  // Each fetch call adds an abort listener, so with 5 workers * many chunks we need more
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setMaxListeners } = require('events') as { setMaxListeners?: (n: number, target: EventTarget) => void };
    if (setMaxListeners) {
      setMaxListeners(200, abortController.signal);
    }
  } catch {
    // Older Node versions may not support this - warning is harmless
  }
  activeCleanupJobs.set(jobId, abortController);
  console.log(`[AI-BRIDGE] Job ${jobId} registered for cancellation support`);

  const sendProgress = (progress: EpubCleanupProgress) => {
    // Console log for visibility in terminal
    const chunkInfo = progress.chunkCompletedAt ? ` [completed @ ${new Date(progress.chunkCompletedAt).toLocaleTimeString()}]` : '';
    console.log(`[AI-CLEANUP] [${jobId.substring(0, 8)}] ${progress.phase.toUpperCase()} - Chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.percentage}%) - ${progress.message || ''}${chunkInfo}`);

    if (onProgress) onProgress(progress);
    if (mainWindow) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'ocr-cleanup',
        phase: progress.phase,
        progress: progress.percentage,
        message: progress.message,
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks,
        currentChapter: progress.currentChapter,
        totalChapters: progress.totalChapters,
        outputPath: progress.outputPath,
        // Timing data for dynamic ETA
        chunksCompletedInJob: progress.chunksCompletedInJob,
        totalChunksInJob: progress.totalChunksInJob,
        chunkCompletedAt: progress.chunkCompletedAt
      });
    }
  };

  // Use a dedicated EpubProcessor instance for cleanup
  // This avoids conflicts with the global processor used by the UI
  let processor: InstanceType<typeof import('./epub-processor.js').EpubProcessor> | null = null;
  const modifiedChapters: Map<string, string> = new Map();

  try {
    // Import epub processor class directly (not the global functions)
    const { EpubProcessor } = await import('./epub-processor.js');

    // Load the EPUB with our own processor instance
    sendProgress({
      jobId,
      phase: 'loading',
      currentChapter: 0,
      totalChapters: 0,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 0,
      message: 'Loading EPUB...'
    });

    processor = new EpubProcessor();
    await processor.open(epubPath);
    const structure = processor.getStructure();
    const chapters = structure?.chapters || [];
    const totalChapters = chapters.length;

    if (totalChapters === 0 || !structure) {
      processor.close();
      stopAIPowerBlock();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    // Extract the book's language from metadata for language-specific prompts
    const bookLanguage = structure?.metadata?.language || 'en';
    console.log(`[AI-BRIDGE] Book language detected: ${bookLanguage}`);

    // Build system prompt based on processing options
    // Default: enableAiCleanup is true for backwards compatibility
    const enableAiCleanup = options?.enableAiCleanup !== false;
    const simplifyForChildren = options?.simplifyForChildren === true;

    let systemPrompt: string;

    // Use custom prompt if provided
    if (options?.cleanupPrompt) {
      systemPrompt = options.cleanupPrompt;
      console.log('[AI-BRIDGE] Using custom cleanup prompt');
    } else if (enableAiCleanup && simplifyForChildren) {
      // BOTH: Standard cleanup + simplification
      // Use language-specific prompt to prevent unwanted translation
      systemPrompt = getOcrCleanupSystemPrompt(cleanupMode, bookLanguage);
      if (options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0) {
        const examplesSection = buildExamplesSection(options.deletedBlockExamples);
        systemPrompt = systemPrompt + examplesSection;
        console.log(`[AI-BRIDGE] Added ${options.deletedBlockExamples.length} deletion examples to system prompt`);
      }
      const simplifySection = buildSimplifyForChildrenSection();
      systemPrompt = systemPrompt + simplifySection;
      console.log('[AI-BRIDGE] Mode: AI Cleanup + Simplify for A1-B1 language learners');
    } else if (simplifyForChildren && !enableAiCleanup) {
      // SIMPLIFY ONLY: Use dedicated simplify-only prompt (no OCR/formatting instructions)
      systemPrompt = getSimplifyOnlySystemPrompt();
      console.log('[AI-BRIDGE] Mode: Simplify for A1-B1 learners ONLY (no AI cleanup)');
    } else {
      // CLEANUP ONLY: Standard cleanup without simplification
      // Use language-specific prompt to prevent unwanted translation
      systemPrompt = getOcrCleanupSystemPrompt(cleanupMode, bookLanguage);
      if (options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0) {
        const examplesSection = buildExamplesSection(options.deletedBlockExamples);
        systemPrompt = systemPrompt + examplesSection;
        console.log(`[AI-BRIDGE] Added ${options.deletedBlockExamples.length} deletion examples to system prompt`);
      }
      console.log('[AI-BRIDGE] Mode: AI Cleanup ONLY (no simplification)');
    }

    let chaptersProcessed = 0;
    let chunksCompletedInJob = 0;  // Cumulative chunk counter across all chapters
    let totalCharactersProcessed = 0;  // Track total characters for analytics
    const cleanupStartTime = Date.now();  // Track start time for analytics
    let firstChunkCompletedAt: number | null = null;  // Track first chunk time for rate calculation

    // Helper to calculate rate display string
    const getRateDisplay = (): string => {
      if (!firstChunkCompletedAt || chunksCompletedInJob < 2) return '';
      const workSeconds = (Date.now() - firstChunkCompletedAt) / 1000;
      if (workSeconds < 10) return '';  // Need at least 10 seconds of data
      const chunksPerMinute = ((chunksCompletedInJob - 1) / workSeconds) * 60;
      return ` (${chunksPerMinute.toFixed(1)}/min)`;
    };

    // Generate output path - save as cleaned.epub or simplified.epub
    // If outputDir is specified, write there; otherwise write alongside the source EPUB
    const epubDir = options?.outputDir || path.dirname(epubPath);
    if (options?.outputDir) {
      await fsPromises.mkdir(options.outputDir, { recursive: true });
    }
    const outputFilename = options?.simplifyForChildren ? 'simplified.epub' : 'cleaned.epub';
    const outputPath = path.join(epubDir, outputFilename);

    // Delete any existing output EPUB to start fresh
    try {
      await fsPromises.unlink(outputPath);
    } catch {
      // File doesn't exist, that's fine
    }

    // Delete any existing skipped-chunks.json from previous runs
    const oldSkippedChunksPath = path.join(epubDir, 'skipped-chunks.json');
    try {
      await fsPromises.unlink(oldSkippedChunksPath);
      console.log('[AI-CLEANUP] Removed old skipped-chunks.json from previous run');
    } catch {
      // File doesn't exist, that's fine
    }

    // Clear any existing diff cache and start new session
    await clearDiffCache(outputPath);
    await startDiffCache(outputPath);

    // Track which chapters have been added to diff cache (for parallel processing)
    const chaptersAddedToDiffCache = new Set<string>();

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Pre-scan all chapters to calculate total chunks in job
    // Mode 'structure': Uses cheerio to extract block elements (preserves HTML)
    // Mode 'full': Sends entire XHTML body to AI (can fix structural issues)
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[AI-CLEANUP] Pre-scanning chapters (mode: ${cleanupMode})...`);

    // Store original XHTML for each chapter (needed for head/styles preservation)
    const chapterXhtmlMap: Map<string, string> = new Map();

    // Simple chunk structure - just text chunks
    interface ChunkInfo {
      text: string;  // Plain text with paragraphs separated by blank lines
    }
    const chapterChunks: { chapter: typeof chapters[0]; chunks: ChunkInfo[] }[] = [];
    let totalChunksInJob = 0;

    for (const chapter of chapters) {
      // Read the raw XHTML
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      let xhtml: string;
      try {
        xhtml = await processor.readFile(href);
      } catch {
        continue; // Skip chapters that can't be read
      }

      // Store original XHTML for later (to preserve head/styles)
      chapterXhtmlMap.set(chapter.id, xhtml);

      // Extract text as flowing prose (paragraphs separated by blank lines)
      const chapterText = extractChapterAsText(xhtml);
      if (!chapterText.trim()) {
        continue; // Skip empty chapters
      }

      const uniqueChunks: ChunkInfo[] = [];

      // If chapter fits in one chunk, send it all
      if (chapterText.length <= CHUNK_SIZE) {
        uniqueChunks.push({ text: chapterText });
      } else {
        // Split at paragraph boundaries (blank lines)
        const paragraphs = chapterText.split(/\n\s*\n/);
        let currentChunk = '';

        for (const para of paragraphs) {
          const wouldBe = currentChunk ? currentChunk + '\n\n' + para : para;

          if (wouldBe.length > CHUNK_SIZE && currentChunk) {
            // Save current chunk and start new one
            uniqueChunks.push({ text: currentChunk });
            currentChunk = para;
          } else {
            currentChunk = wouldBe;
          }
        }

        // Don't forget the last chunk
        if (currentChunk) {
          uniqueChunks.push({ text: currentChunk });
        }
      }

      if (uniqueChunks.length > 0) {
        chapterChunks.push({ chapter, chunks: uniqueChunks });
        totalChunksInJob += uniqueChunks.length;
      }
    }

    console.log(`[AI-CLEANUP] Total chunks in job: ${totalChunksInJob} across ${chapterChunks.length} non-empty chapters (mode: ${cleanupMode})`);

    if (totalChunksInJob === 0) {
      processor.close();
      stopAIPowerBlock();
      return { success: false, error: 'No text content found in EPUB' };
    }

    // TEST MODE: Limit to first N chunks
    console.log('[AI-CLEANUP] Test mode check:', { testMode, optionsTestMode: options?.testMode, options: JSON.stringify(options) });
    if (testMode) {
      console.log(`[AI-CLEANUP] TEST MODE: Limiting to first ${TEST_MODE_CHUNK_LIMIT} chunks`);
      let chunksRemaining = TEST_MODE_CHUNK_LIMIT;
      const limitedChapterChunks: typeof chapterChunks = [];

      for (const { chapter, chunks } of chapterChunks) {
        if (chunksRemaining <= 0) break;

        if (chunks.length <= chunksRemaining) {
          // Take all chunks from this chapter
          limitedChapterChunks.push({ chapter, chunks });
          chunksRemaining -= chunks.length;
        } else {
          // Take only the remaining chunks we need
          limitedChapterChunks.push({ chapter, chunks: chunks.slice(0, chunksRemaining) });
          chunksRemaining = 0;
        }
      }

      // Replace the arrays with limited versions
      chapterChunks.length = 0;
      chapterChunks.push(...limitedChapterChunks);
      totalChunksInJob = Math.min(totalChunksInJob, TEST_MODE_CHUNK_LIMIT);
      console.log(`[AI-CLEANUP] TEST MODE: Processing ${totalChunksInJob} chunks across ${chapterChunks.length} chapters`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Process all chunks (parallel or sequential)
    // ─────────────────────────────────────────────────────────────────────────
    const useParallel = options?.useParallel && config.provider !== 'ollama';
    const workerCount = Math.min(options?.parallelWorkers || 3, totalChunksInJob);

    if (useParallel && workerCount > 1) {
      // ─────────────────────────────────────────────────────────────────────────
      // PARALLEL PROCESSING: Chunk-level parallelism for optimal load balancing
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`[AI-CLEANUP] Using PARALLEL chunk-level processing with ${workerCount} workers`);

      // Flatten all chunks into a single queue with metadata
      interface ChunkWork {
        chapterId: string;
        chapterTitle: string;
        chapterIndex: number;
        chunkIndex: number;
        overallChunkNumber: number;  // 1-based overall position
        text: string;
      }

      const chunkQueue: ChunkWork[] = [];
      let overallNumber = 0;
      for (let chapterIdx = 0; chapterIdx < chapterChunks.length; chapterIdx++) {
        const { chapter, chunks } = chapterChunks[chapterIdx];
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          overallNumber++;
          chunkQueue.push({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            chapterIndex: chapterIdx,
            chunkIndex: chunkIdx,
            overallChunkNumber: overallNumber,
            text: chunks[chunkIdx].text
          });
        }
      }

      console.log(`[AI-CLEANUP] Created chunk queue with ${chunkQueue.length} items`);

      // Results storage
      interface ChunkResult {
        chapterId: string;
        chunkIndex: number;
        cleanedText: string;
      }
      const results: ChunkResult[] = [];
      let totalChunksCompleted = 0;

      // Track chunks needed per chapter for incremental saving
      const chunksPerChapter = new Map<string, number>();
      const completedChunksPerChapter = new Map<string, number>();
      const savedChapters = new Set<string>();
      for (const { chapter, chunks } of chapterChunks) {
        chunksPerChapter.set(chapter.id, chunks.length);
        completedChunksPerChapter.set(chapter.id, 0);
      }

      // Helper to try saving a completed chapter
      const trySaveChapter = async (chapterId: string) => {
        if (savedChapters.has(chapterId)) return;

        const needed = chunksPerChapter.get(chapterId) || 0;
        const completed = completedChunksPerChapter.get(chapterId) || 0;

        if (completed >= needed) {
          // All chunks for this chapter are done - collect and save
          const chapterResults = results
            .filter(r => r.chapterId === chapterId)
            .sort((a, b) => a.chunkIndex - b.chunkIndex);

          const originalXhtml = chapterXhtmlMap.get(chapterId);
          if (originalXhtml && chapterResults.length > 0) {
            const cleanedText = chapterResults.map(c => c.cleanedText).join('\n\n');
            const paragraphs = splitTextIntoParagraphs(cleanedText);
            const rebuiltXhtml = rebuildChapterFromParagraphs(originalXhtml, paragraphs);
            modifiedChapters.set(chapterId, rebuiltXhtml);

            // Save to disk immediately
            try {
              await saveModifiedEpubLocal(processor!, modifiedChapters, outputPath);
              savedChapters.add(chapterId);
              console.log(`[AI-CLEANUP] Saved chapter ${chapterId} (${chapterResults.length} chunks)`);

              // Add to diff cache if not already added
              if (!chaptersAddedToDiffCache.has(chapterId)) {
                const chapterInfo = chapterChunks.find(cc => cc.chapter.id === chapterId);
                const chapterTitle = chapterInfo?.chapter.title || chapterId;
                const originalText = extractChapterAsText(originalXhtml);
                // IMPORTANT: Extract cleaned text from the rebuilt XHTML, not raw AI text.
                // This ensures diff positions match what hydration will extract from the EPUB.
                const rebuiltXhtml = modifiedChapters.get(chapterId);
                const cleanedTextForDiff = rebuiltXhtml ? extractChapterAsText(rebuiltXhtml) : cleanedText;
                await addChapterDiff(chapterId, chapterTitle, originalText, cleanedTextForDiff);
                chaptersAddedToDiffCache.add(chapterId);
              }
            } catch (saveError) {
              console.error(`[AI-CLEANUP] Failed to save chapter ${chapterId}:`, saveError);
            }
          }
        }
      };

      // Helper to update progress
      const updateProgress = async (chapterId: string, chapterTitle: string) => {
        totalChunksCompleted++;
        completedChunksPerChapter.set(chapterId, (completedChunksPerChapter.get(chapterId) || 0) + 1);

        // Check if too many chunks have fallen back to original text
        checkFallbackThreshold();

        const percentage = Math.round((totalChunksCompleted / totalChunksInJob) * 90);
        sendProgress({
          jobId,
          phase: 'processing',
          currentChapter: 0, // Not meaningful for chunk-level
          totalChapters: chapterChunks.length,
          currentChunk: totalChunksCompleted,
          totalChunks: totalChunksInJob,
          percentage,
          message: `[${workerCount} workers] Chunk ${totalChunksCompleted}/${totalChunksInJob}: ${chapterTitle}`,
          outputPath,
          chunksCompletedInJob: totalChunksCompleted,
          totalChunksInJob,
          chunkCompletedAt: Date.now()
        });

        // Try to save this chapter if all its chunks are complete
        await trySaveChapter(chapterId);
      };

      // Worker function - pulls chunks from shared queue
      const runWorker = async (workerId: number): Promise<void> => {
        while (true) {
          // Get next chunk from queue (atomic via shift)
          const work = chunkQueue.shift();
          if (!work) break; // Queue empty
          if (abortController.signal.aborted) break;

          try {
            const chunkMeta = {
              chapterTitle: work.chapterTitle,
              chunkIndex: work.chunkIndex,
              overallChunkNumber: work.overallChunkNumber,
              totalChunks: totalChunksInJob
            };
            const cleaned = await cleanChunkWithProvider(work.text, systemPrompt, config, 3, abortController.signal, chunkMeta);
            results.push({
              chapterId: work.chapterId,
              chunkIndex: work.chunkIndex,
              cleanedText: cleaned
            });
            await updateProgress(work.chapterId, work.chapterTitle);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Check for unrecoverable errors
            if (errorMessage.includes('credit balance') || errorMessage.includes('rate_limit') ||
                errorMessage.includes('invalid_api_key') || errorMessage.includes('401') ||
                errorMessage.includes('403') || errorMessage.includes('quota')) {
              throw error; // Re-throw to stop all workers
            }
            // For recoverable errors, keep original text
            results.push({
              chapterId: work.chapterId,
              chunkIndex: work.chunkIndex,
              cleanedText: work.text
            });
            await updateProgress(work.chapterId, work.chapterTitle);
          }
        }
      };

      // Start workers
      const workers = Array(workerCount).fill(null).map((_, i) => runWorker(i));
      await Promise.all(workers);

      // Check if cancelled
      if (abortController.signal.aborted) {
        throw new Error('Job cancelled');
      }

      // Reassemble: group by chapter, sort by chunk index (only for chapters not already saved)
      const chapterResultsMap = new Map<string, ChunkResult[]>();
      for (const result of results) {
        // Skip chapters that were already saved incrementally
        if (savedChapters.has(result.chapterId)) continue;

        if (!chapterResultsMap.has(result.chapterId)) {
          chapterResultsMap.set(result.chapterId, []);
        }
        chapterResultsMap.get(result.chapterId)!.push(result);
      }

      // Process any remaining unsaved chapters (partial chapters from stuck workers)
      for (const [chapterId, chunks] of chapterResultsMap) {
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

        const originalXhtml = chapterXhtmlMap.get(chapterId);
        if (!originalXhtml) {
          console.warn(`[AI-CLEANUP] No original XHTML for chapter ${chapterId}`);
          continue;
        }

        // Join all chunk results into one cleaned text
        const cleanedText = chunks.map(c => c.cleanedText).join('\n\n');

        // Split into paragraphs and rebuild XHTML
        const paragraphs = splitTextIntoParagraphs(cleanedText);
        const rebuiltXhtml = rebuildChapterFromParagraphs(originalXhtml, paragraphs);

        modifiedChapters.set(chapterId, rebuiltXhtml);

        // Add to diff cache (these chapters weren't saved incrementally)
        if (!chaptersAddedToDiffCache.has(chapterId)) {
          const chapterInfo = chapterChunks.find(cc => cc.chapter.id === chapterId);
          const chapterTitle = chapterInfo?.chapter.title || chapterId;
          const originalText = extractChapterAsText(originalXhtml);
          const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
          await addChapterDiff(chapterId, chapterTitle, originalText, cleanedTextForDiff);
          chaptersAddedToDiffCache.add(chapterId);
        }
      }
      chaptersProcessed = savedChapters.size + chapterResultsMap.size;

      console.log(`[AI-CLEANUP] Saved ${savedChapters.size} chapters incrementally, ${chapterResultsMap.size} in final pass (${results.length} total chunks)`);

    } else {
      // ─────────────────────────────────────────────────────────────────────────
      // SEQUENTIAL PROCESSING: Original single-threaded approach
      // ─────────────────────────────────────────────────────────────────────────
      console.log('[AI-CLEANUP] Using SEQUENTIAL processing');

      for (let i = 0; i < chapterChunks.length; i++) {
        // Check for cancellation before each chapter
        if (abortController.signal.aborted) {
          console.log(`[AI-CLEANUP] Job ${jobId} cancelled before chapter ${i + 1}`);
          throw new Error('Job cancelled');
        }

        const { chapter, chunks: uniqueChunks } = chapterChunks[i];

        // Collect cleaned text from all chunks in this chapter
        const cleanedChunkTexts: string[] = [];

        for (let c = 0; c < uniqueChunks.length; c++) {
          // Check for cancellation before each chunk
          if (abortController.signal.aborted) {
            console.log(`[AI-CLEANUP] Job ${jobId} cancelled before chunk ${c + 1} of chapter ${i + 1}`);
            throw new Error('Job cancelled');
          }

          const chunkStartTime = Date.now();
          const currentChunkInJob = chunksCompletedInJob + 1;
          const chunkInfo = uniqueChunks[c];

          // Send progress before starting chunk
          sendProgress({
            jobId,
            phase: 'processing',
            currentChapter: i + 1,
            totalChapters: chapterChunks.length,
            currentChunk: currentChunkInJob,
            totalChunks: totalChunksInJob,
            percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
            message: `Processing chunk ${currentChunkInJob}/${totalChunksInJob}: ${chapter.title}`,
            outputPath,
            chunksCompletedInJob,
            totalChunksInJob
          });

          try {
            const chunkCharCount = chunkInfo.text.length;
            totalCharactersProcessed += chunkCharCount;
            console.log(`[AI-CLEANUP] Starting chunk ${currentChunkInJob}/${totalChunksInJob} - "${chapter.title}" (${chunkCharCount} chars)`);

            const chunkMeta = {
              chapterTitle: chapter.title,
              chunkIndex: c,
              overallChunkNumber: currentChunkInJob,
              totalChunks: totalChunksInJob
            };
            const cleaned = await cleanChunkWithProvider(chunkInfo.text, systemPrompt, config, 3, abortController.signal, chunkMeta);
            const chunkDuration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            console.log(`[AI-CLEANUP] Completed chunk ${currentChunkInJob}/${totalChunksInJob} in ${chunkDuration}s (${cleaned.length} chars output)`);

            // Collect cleaned text
            cleanedChunkTexts.push(cleaned);

            // Increment counter
            chunksCompletedInJob++;

            // Check if too many chunks have fallen back to original text
            checkFallbackThreshold();

            // Save incrementally every 5 chunks (or on last chunk of chapter)
            const isLastChunkOfChapter = c === uniqueChunks.length - 1;
            const shouldSave = isLastChunkOfChapter || chunksCompletedInJob % 5 === 0;

            if (shouldSave) {
              const originalXhtml = chapterXhtmlMap.get(chapter.id);
              if (originalXhtml) {
                // Join cleaned chunks and rebuild chapter
                const cleanedText = cleanedChunkTexts.join('\n\n');
                const paragraphs = splitTextIntoParagraphs(cleanedText);
                const rebuiltXhtml = rebuildChapterFromParagraphs(originalXhtml, paragraphs);
                modifiedChapters.set(chapter.id, rebuiltXhtml);
              }

              try {
                await saveModifiedEpubLocal(processor, modifiedChapters, outputPath);
                if (global.gc) global.gc();
              } catch (saveError) {
                console.error(`Failed to save after chunk ${currentChunkInJob}:`, saveError);
              }
            }

            // Track first chunk completion for rate calculation
            if (firstChunkCompletedAt === null) {
              firstChunkCompletedAt = Date.now();
            }

            sendProgress({
              jobId,
              phase: 'processing',
              currentChapter: i + 1,
              totalChapters: chapterChunks.length,
              currentChunk: chunksCompletedInJob,
              totalChunks: totalChunksInJob,
              percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
              message: `Chunk ${chunksCompletedInJob}/${totalChunksInJob}${getRateDisplay()}`,
              outputPath,
              chunksCompletedInJob,
              totalChunksInJob,
              chunkCompletedAt: Date.now()
            });
          } catch (error) {
            const chunkDuration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[AI-CLEANUP] Chunk ${currentChunkInJob} failed after ${chunkDuration}s:`, error);

            // Check for unrecoverable errors
            const isUnrecoverableError =
              errorMessage.includes('credit balance') ||
              errorMessage.includes('insufficient_quota') ||
              errorMessage.includes('rate_limit') ||
              errorMessage.includes('invalid_api_key') ||
              errorMessage.includes('authentication') ||
              errorMessage.includes('unauthorized') ||
              errorMessage.includes('403') ||
              errorMessage.includes('401') ||
              errorMessage.includes('billing') ||
              errorMessage.includes('quota exceeded') ||
              errorMessage.includes('model not found') ||
              errorMessage.includes('does not exist');

            if (isUnrecoverableError) {
              sendProgress({
                jobId,
                phase: 'error',
                currentChapter: i + 1,
                totalChapters: chapterChunks.length,
                currentChunk: currentChunkInJob,
                totalChunks: totalChunksInJob,
                percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
                message: `AI cleanup stopped: ${errorMessage}`,
                error: errorMessage,
                outputPath
              });
              throw new Error(`AI cleanup stopped: ${errorMessage}`);
            }

            // For recoverable errors, use original chunk text
            console.warn(`[AI-CLEANUP] Chunk ${currentChunkInJob} failed - using original text`);
            cleanedChunkTexts.push(chunkInfo.text);
            chunksCompletedInJob++;
          }
        }

        // Final rebuild for this chapter
        const originalXhtml = chapterXhtmlMap.get(chapter.id);
        if (originalXhtml && cleanedChunkTexts.length > 0) {
          const cleanedText = cleanedChunkTexts.join('\n\n');
          const paragraphs = splitTextIntoParagraphs(cleanedText);
          const rebuiltXhtml = rebuildChapterFromParagraphs(originalXhtml, paragraphs);
          modifiedChapters.set(chapter.id, rebuiltXhtml);

          // Add to diff cache
          // IMPORTANT: Extract cleaned text from the rebuilt XHTML, not raw AI text.
          // This ensures diff positions match what hydration will extract from the EPUB.
          const originalText = extractChapterAsText(originalXhtml);
          const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
          await addChapterDiff(chapter.id, chapter.title, originalText, cleanedTextForDiff);
        }
        chaptersProcessed++;

        // Save after each chapter
        try {
          await saveModifiedEpubLocal(processor, modifiedChapters, outputPath);
        } catch (saveError) {
          console.error(`Failed to save after chapter ${i + 1}:`, saveError);
        }
      }
    } // End of else (sequential processing)

    // Final save
    sendProgress({
      jobId,
      phase: 'saving',
      currentChapter: totalChapters,
      totalChapters,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 95,
      message: 'Finalizing EPUB...',
      outputPath
    });

    await saveModifiedEpubLocal(processor, modifiedChapters, outputPath);
    processor.close();
    processor = null;

    // Finalize diff cache (mark as complete)
    await finalizeDiffCache();

    // Clean up abort controller
    activeCleanupJobs.delete(jobId);
    console.log(`[AI-BRIDGE] Job ${jobId} completed successfully, cleaned up`);

    sendProgress({
      jobId,
      phase: 'complete',
      currentChapter: totalChapters,
      totalChapters,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 100,
      message: 'OCR cleanup complete'
    });

    // Log issues if any
    if (copyrightFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Copyright issues detected: ${copyrightFallbackCount} chunks fell back to original text`);
    }
    if (skipFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Content skips detected: ${skipFallbackCount} chunks returned [SKIP] for non-trivial content`);
    }
    if (markerMismatchCount > 0) {
      console.warn(`[AI-CLEANUP] Marker mismatches detected: ${markerMismatchCount} chunks had [[BLOCK]] marker count mismatch and fell back to original text`);
    }
    if (truncatedFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Truncation issues detected: ${truncatedFallbackCount} chunks returned <70% of input length and fell back to original text`);
    }

    // Save skipped chunks to JSON file if any exist
    let skippedChunksPath: string | undefined;
    if (skippedChunks.length > 0) {
      skippedChunksPath = path.join(epubDir, 'skipped-chunks.json');
      await fsPromises.writeFile(skippedChunksPath, JSON.stringify(skippedChunks, null, 2), 'utf-8');
      console.log(`[AI-CLEANUP] Saved ${skippedChunks.length} skipped chunks to ${skippedChunksPath}`);
    }

    stopAIPowerBlock();

    // Calculate analytics
    const cleanupEndTime = Date.now();
    const durationSeconds = Math.round((cleanupEndTime - cleanupStartTime) / 1000);
    const durationMinutes = durationSeconds / 60;
    const chunksPerMinute = durationMinutes > 0
      ? Math.round((totalChunksInJob / durationMinutes) * 10) / 10
      : 0;
    const charactersPerMinute = durationMinutes > 0
      ? Math.round(totalCharactersProcessed / durationMinutes)
      : 0;

    // Determine model name for analytics
    let modelName = 'unknown';
    if (config.provider === 'ollama' && config.ollama?.model) {
      modelName = `ollama/${config.ollama.model}`;
    } else if (config.provider === 'claude' && config.claude?.model) {
      modelName = `claude/${config.claude.model}`;
    } else if (config.provider === 'openai' && config.openai?.model) {
      modelName = `openai/${config.openai.model}`;
    }

    const analytics = {
      jobId,
      startedAt: new Date(cleanupStartTime).toISOString(),
      completedAt: new Date(cleanupEndTime).toISOString(),
      durationSeconds,
      totalChapters: chapters.length,
      totalChunks: totalChunksInJob,
      totalCharacters: totalCharactersProcessed,
      chunksPerMinute,
      charactersPerMinute,
      model: modelName,
      success: true,
      chaptersProcessed,
      copyrightChunksAffected: copyrightFallbackCount,
      contentSkipsAffected: skipFallbackCount,
      markerMismatchAffected: markerMismatchCount,
      truncatedChunksAffected: truncatedFallbackCount,
      skippedChunksPath
    };

    return {
      success: true,
      outputPath,
      chaptersProcessed,
      copyrightIssuesDetected: copyrightFallbackCount > 0,
      copyrightChunksAffected: copyrightFallbackCount,
      contentSkipsDetected: skipFallbackCount > 0,
      contentSkipsAffected: skipFallbackCount,
      markerMismatchDetected: markerMismatchCount > 0,
      markerMismatchAffected: markerMismatchCount,
      truncatedDetected: truncatedFallbackCount > 0,
      truncatedAffected: truncatedFallbackCount,
      skippedChunksPath,
      analytics
    };
  } catch (error) {
    // Clean up abort controller
    activeCleanupJobs.delete(jobId);

    // Clean up processor on error
    if (processor) {
      try {
        processor.close();
      } catch { /* ignore */ }
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isCancelled = message === 'Job cancelled' || abortController.signal.aborted;

    console.log(`[AI-BRIDGE] Job ${jobId} ${isCancelled ? 'cancelled' : 'failed'}: ${message}`);

    sendProgress({
      jobId,
      phase: 'error',
      currentChapter: 0,
      totalChapters: 0,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 0,
      message: isCancelled ? 'Cancelled' : `Error: ${message}`,
      error: isCancelled ? 'Cancelled by user' : message
    });
    stopAIPowerBlock();
    return { success: false, error: isCancelled ? 'Cancelled by user' : message };
  }
}

/**
 * Save modified EPUB using a dedicated processor instance.
 * This is used by cleanupEpub to avoid conflicts with the global processor.
 */
async function saveModifiedEpubLocal(
  processor: InstanceType<typeof import('./epub-processor.js').EpubProcessor>,
  modifiedChapters: Map<string, string>,
  outputPath: string
): Promise<void> {
  const { ZipWriter } = await import('./epub-processor.js');

  const structure = processor.getStructure();
  if (!structure) {
    throw new Error('No EPUB structure');
  }

  const zipWriter = new ZipWriter();

  // Get all entries from the original EPUB
  const entries = (processor as any).zipReader?.getEntries() || [];

  for (const entryName of entries) {
    // Check if this is a chapter file that was modified
    let isModified = false;
    let modifiedContent: string | null = null;

    for (const chapter of structure.chapters) {
      // Match using rootPath like the original implementation
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      if (entryName === href && modifiedChapters.has(chapter.id)) {
        isModified = true;
        modifiedContent = modifiedChapters.get(chapter.id) || null;
        break;
      }
    }

    if (isModified && modifiedContent !== null) {
      // modifiedContent is now the fully rebuilt XHTML from cheerio's replaceBlockTexts
      zipWriter.addFile(entryName, Buffer.from(modifiedContent, 'utf8'));
    } else {
      // Copy file as-is
      const data = await processor.readBinaryFile(entryName);
      // Don't compress mimetype file (EPUB spec requirement)
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }
  }

  // Write the output file
  await zipWriter.write(outputPath);
}

/**
 * Replace the body content in an XHTML document while preserving the HTML structure.
 * Maps cleaned text blocks back to original block-level elements.
 * Local version for use with dedicated processor.
 */
function replaceXhtmlBodyLocal(xhtml: string, cleanedText: string): string {
  // Find the body tag
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    return xhtml;
  }

  const bodyContent = bodyMatch[1];

  // Split cleaned text into blocks (separated by double newlines)
  const cleanedBlocks = cleanedText.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 0);

  if (cleanedBlocks.length === 0) {
    return xhtml;
  }

  // Find all block-level elements with text content
  // Use a non-greedy match to get individual elements
  const blockPattern = /<(p|h[1-6]|li|blockquote|figcaption)([^>]*)>([\s\S]*?)<\/\1>/gi;

  // Collect all matches with their positions
  interface BlockMatch {
    full: string;
    tag: string;
    attrs: string;
    content: string;
    startIndex: number;
    hasText: boolean;
  }

  const matches: BlockMatch[] = [];
  let match;

  while ((match = blockPattern.exec(bodyContent)) !== null) {
    // Check if this element has actual text content (not just whitespace/nested tags)
    const textContent = match[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&[^;]+;/g, ' ')
      .trim();

    matches.push({
      full: match[0],
      tag: match[1],
      attrs: match[2],
      content: match[3],
      startIndex: match.index,
      hasText: textContent.length > 0
    });
  }

  // Filter to only elements with text
  const textMatches = matches.filter(m => m.hasText);

  // If counts don't match, fall back to simple paragraph replacement
  if (textMatches.length !== cleanedBlocks.length) {
    console.warn(`[AI-BRIDGE] Block count mismatch: ${textMatches.length} HTML blocks vs ${cleanedBlocks.length} cleaned blocks. Using paragraph fallback.`);

    // Preserve chapter heading from original XHTML so TTS can detect it
    const firstHeading = textMatches.find(m => /^h[1-6]$/i.test(m.tag));
    let headingHtml = '';

    if (firstHeading) {
      const origTitle = firstHeading.content.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
      const normalizedTitle = origTitle.replace(/[.!?:;\s]+$/g, '').toLowerCase().trim();

      if (normalizedTitle) {
        // Ensure heading ends with period for TTS pause
        let headingText = origTitle.replace(/[.!?:;\s]+$/g, '').trim();
        if (!/[.!?]$/.test(headingText)) headingText += '.';
        headingHtml = `<${firstHeading.tag}${firstHeading.attrs}>${escapeXmlLocal(headingText)}</${firstHeading.tag}>`;

        // Check if AI included the title at the start of the first block — strip to avoid duplication
        const firstBlockNorm = (cleanedBlocks[0] || '').toLowerCase().trim();
        if (firstBlockNorm.startsWith(normalizedTitle)) {
          const remainder = cleanedBlocks[0].substring(normalizedTitle.length).replace(/^[.!?:;\s]+/, '').trim();
          if (remainder) {
            cleanedBlocks[0] = remainder;
          } else {
            cleanedBlocks.shift();
          }
        }
      }
    }

    const paragraphs = cleanedBlocks.map(p => `<p>${escapeXmlLocal(p)}</p>`).join('\n');
    const bodyHtml = headingHtml ? `${headingHtml}\n${paragraphs}` : paragraphs;
    return xhtml.replace(
      /<body([^>]*)>[\s\S]*<\/body>/i,
      `<body$1>\n${bodyHtml}\n</body>`
    );
  }

  // Replace each block element's content with cleaned text (work backwards to preserve indices)
  let newBodyContent = bodyContent;

  for (let i = textMatches.length - 1; i >= 0; i--) {
    const m = textMatches[i];
    let cleanedBlock = cleanedBlocks[i];

    // Ensure heading content ends with punctuation for TTS pause
    if (/^h[1-6]$/i.test(m.tag) && cleanedBlock) {
      const trimmed = cleanedBlock.trim();
      if (trimmed && !/[.!?]$/.test(trimmed)) {
        cleanedBlock = trimmed + '.';
      }
    }

    // Build new element preserving original tag and attributes
    const newElement = `<${m.tag}${m.attrs}>${escapeXmlLocal(cleanedBlock)}</${m.tag}>`;

    // Replace in the body content
    newBodyContent =
      newBodyContent.substring(0, m.startIndex) +
      newElement +
      newBodyContent.substring(m.startIndex + m.full.length);
  }

  // Replace body content in the original XHTML
  return xhtml.replace(
    /<body([^>]*)>[\s\S]*<\/body>/i,
    `<body$1>${newBodyContent}</body>`
  );
}

/**
 * Escape text for XML. Local version.
 */
function escapeXmlLocal(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export singleton-style interface
// ─────────────────────────────────────────────────────────────────────────────

export const aiBridge = {
  checkConnection,
  checkProviderConnection,
  getModels,
  hasModel,
  cleanupText,
  cleanupChapterStreaming,
  cleanupEpub,
  cancelCleanupJob,
  getOcrCleanupSystemPrompt,
  loadPrompt,
  savePrompt,
  reloadPrompt,
  getPromptFilePath
};

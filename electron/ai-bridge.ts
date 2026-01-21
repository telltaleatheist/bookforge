/**
 * AI Bridge - Multi-provider AI wrapper for text cleanup
 *
 * Supports multiple AI providers:
 * - Ollama (local, free) at localhost:11434
 * - Claude (Anthropic API)
 * - OpenAI (ChatGPT API)
 */

import { BrowserWindow } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';

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
const TIMEOUT_MS = 180000; // 3 minutes per chunk (Ollama can be slow)

// ─────────────────────────────────────────────────────────────────────────────
// OCR Cleanup Prompt
// ─────────────────────────────────────────────────────────────────────────────

// Path to the editable prompt file
const PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'tts-cleanup.txt');

// Default prompt (used if file doesn't exist)
const DEFAULT_PROMPT = `You are preparing ebook text for text-to-speech (TTS) audiobook narration. Transform the text so it sounds natural when read aloud.

NUMBERS → SPOKEN WORDS:
- Years: "1923" → "nineteen twenty-three", "2001" → "two thousand one"
- Decades: "the 1930s" → "the nineteen thirties"
- Dates: "January 5, 1923" → "January fifth, nineteen twenty-three"
- Ordinals: "1st" → "first", "21st" → "twenty-first"
- Cardinals: "3 men" → "three men"
- Currency: "$5.50" → "five dollars and fifty cents"
- Roman numerals: "Chapter IV" → "Chapter Four", "Henry VIII" → "Henry the Eighth"

EXPAND ABBREVIATIONS:
- Titles: "Mr." → "Mister", "Dr." → "Doctor"
- Common: "e.g." → "for example", "i.e." → "that is", "etc." → "and so on"

PUNCTUATION FOR NATURAL PACING:
- Add commas after introductory phrases
- Add commas around parenthetical phrases
- Replace em dashes (—) with commas when they mark asides

FIX OCR ERRORS (broken words, character misreads: rn→m, cl→d).
REMOVE: footnote numbers in sentences, page numbers, stray artifacts.
PRESERVE: author's meaning, proper nouns, dialogue.

Output ONLY the processed text. No commentary.`;

/**
 * Load the TTS cleanup prompt from file
 */
export async function loadPrompt(): Promise<string> {
  try {
    const content = await fsPromises.readFile(PROMPT_FILE_PATH, 'utf-8');
    return content.trim();
  } catch {
    // File doesn't exist, return default
    return DEFAULT_PROMPT;
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

function buildCleanupPrompt(_options: AICleanupOptions): string {
  // Return cached prompt if available, otherwise default
  return cachedPrompt || DEFAULT_PROMPT;
}

// Load prompt on module init
loadPrompt().then(prompt => {
  cachedPrompt = prompt;
}).catch(() => {
  cachedPrompt = DEFAULT_PROMPT;
});

/**
 * Build a simple OCR cleanup prompt for queue processing (entire EPUB).
 * Same as buildCleanupPrompt but exposed for queue use.
 */
export function getOcrCleanupSystemPrompt(): string {
  const prompt = buildCleanupPrompt({ fixHyphenation: true, fixOcrArtifacts: true, expandAbbreviations: true });
  // Debug: log first 200 chars of prompt to verify it's the correct version
  console.log('[AI-BRIDGE] Using system prompt (first 200 chars):', prompt.substring(0, 200).replace(/\n/g, ' '));
  return prompt;
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

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Text Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up a chunk of text using Claude API
 */
async function cleanChunkWithClaude(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string = 'claude-3-5-sonnet-20241022'
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        max_tokens: Math.max(4096, text.length * 2),
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

    // Safeguard: if AI returns significantly less text (less than 70%),
    // it's likely truncating/removing content incorrectly - use original
    if (cleaned.length < text.length * 0.7) {
      console.warn(`Claude returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
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
  model: string = 'gpt-4o'
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

    // Safeguard: if AI returns significantly less text (less than 70%),
    // it's likely truncating/removing content incorrectly - use original
    if (cleaned.length < text.length * 0.7) {
      console.warn(`OpenAI returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
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
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      switch (config.provider) {
        case 'ollama':
          if (!config.ollama?.model) {
            throw new Error('Ollama model not configured');
          }
          return await cleanChunk(text, systemPrompt, config.ollama.model);
        case 'claude':
          if (!config.claude?.apiKey) {
            throw new Error('Claude API key not configured');
          }
          if (!config.claude?.model) {
            throw new Error('Claude model not configured');
          }
          return await cleanChunkWithClaude(text, systemPrompt, config.claude.apiKey, config.claude.model);
        case 'openai':
          if (!config.openai?.apiKey) {
            throw new Error('OpenAI API key not configured');
          }
          if (!config.openai?.model) {
            throw new Error('OpenAI model not configured');
          }
          return await cleanChunkWithOpenAI(text, systemPrompt, config.openai.apiKey, config.openai.model);
        default:
          throw new Error(`Unknown provider: ${config.provider}`);
      }
    } catch (error) {
      lastError = error as Error;
      const isRetryableError = error instanceof Error && (
        error.name === 'AbortError' ||
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
  model: string = DEFAULT_MODEL
): Promise<string> {
  console.log('[AI-BRIDGE] cleanChunk using model:', model);

  // Don't use AbortController - it gets triggered by dev server reloads
  // Let Ollama handle its own timeouts via keep_alive
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
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

  // Safeguard: if AI returns significantly less text (less than 70%),
  // it's likely truncating/removing content incorrectly - use original
  if (cleaned.length < text.length * 0.7) {
    console.warn(`AI returned ${cleaned.length} chars vs ${text.length} input - using original to prevent content loss`);
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

  const systemPrompt = buildCleanupPrompt(options);

  // Split text into chunks
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    // Try to break at sentence boundary
    let end = Math.min(i + CHUNK_SIZE, text.length);
    if (end < text.length) {
      // Look for sentence end within last 500 chars
      const searchStart = Math.max(end - 500, i);
      const searchText = text.substring(searchStart, end);
      const lastPeriod = searchText.lastIndexOf('. ');
      if (lastPeriod > 0) {
        end = searchStart + lastPeriod + 2;
      }
    }
    chunks.push(text.substring(i, end));
    i = end - CHUNK_SIZE; // Adjust loop counter
  }

  // Deduplicate chunks (the loop adjustment can cause issues)
  const uniqueChunks = chunks.filter((chunk, index) =>
    index === 0 || chunk !== chunks[index - 1]
  );

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

    try {
      const cleaned = await cleanChunk(uniqueChunks[i], systemPrompt, model);
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
  currentChunk: number;
  totalChunks: number;
  percentage: number;
  message?: string;
  outputPath?: string;  // Path to _cleaned.epub (available during processing for diff view)
}

export interface EpubCleanupResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  chaptersProcessed?: number;
}

/**
 * Process an entire EPUB through OCR cleanup.
 * Cleans all chapters and saves a modified EPUB.
 * Requires explicit AI provider configuration - no fallbacks.
 */
export async function cleanupEpub(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: EpubCleanupProgress) => void) | undefined,
  providerConfig: AIProviderConfig
): Promise<EpubCleanupResult> {
  // Debug logging to trace provider selection
  console.log('[AI-BRIDGE] cleanupEpub called with:', {
    provider: providerConfig.provider,
    ollamaModel: providerConfig.ollama?.model,
    claudeModel: providerConfig.claude?.model,
    openaiModel: providerConfig.openai?.model
  });

  // providerConfig is required - no fallbacks
  const config = providerConfig;

  // Validate provider configuration
  if (config.provider === 'ollama') {
    if (!config.ollama?.model) {
      return { success: false, error: 'Ollama model not specified in config' };
    }
    const connection = await checkConnection();
    if (!connection.connected) {
      return { success: false, error: `Ollama not available: ${connection.error}` };
    }
    if (!(await hasModel(config.ollama.model))) {
      return { success: false, error: `Model '${config.ollama.model}' not found. Run: ollama pull ${config.ollama.model}` };
    }
  } else if (config.provider === 'claude') {
    if (!config.claude?.apiKey) {
      return { success: false, error: 'Claude API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.claude?.model) {
      return { success: false, error: 'Claude model not specified in config' };
    }
  } else if (config.provider === 'openai') {
    if (!config.openai?.apiKey) {
      return { success: false, error: 'OpenAI API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.openai?.model) {
      return { success: false, error: 'OpenAI model not specified in config' };
    }
  } else {
    return { success: false, error: `Unknown AI provider: ${config.provider}` };
  }

  const sendProgress = (progress: EpubCleanupProgress) => {
    if (onProgress) onProgress(progress);
    if (mainWindow) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'ocr-cleanup',
        phase: progress.phase,
        progress: progress.percentage,
        message: progress.message,
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks
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

    if (totalChapters === 0) {
      processor.close();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    const systemPrompt = getOcrCleanupSystemPrompt();
    let chaptersProcessed = 0;

    // Generate output path - save as cleaned.epub in the same folder as the original
    // This supports the project-based structure where original.epub and cleaned.epub live together
    const epubDir = path.dirname(epubPath);
    const outputPath = path.join(epubDir, 'cleaned.epub');

    // Delete any existing cleaned.epub to start fresh
    try {
      await fsPromises.unlink(outputPath);
    } catch {
      // File doesn't exist, that's fine
    }

    // Process each chapter
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];

      sendProgress({
        jobId,
        phase: 'processing',
        currentChapter: i + 1,
        totalChapters,
        currentChunk: 0,
        totalChunks: 1,
        percentage: Math.round((i / totalChapters) * 90), // 90% for processing
        message: `Processing: ${chapter.title}`,
        outputPath  // Include output path so UI can show diff during processing
      });

      // Get chapter text using our dedicated processor
      const text = await processor.getChapterText(chapter.id);
      if (!text || text.trim().length === 0) {
        continue; // Skip empty chapters
      }

      // Split into chunks
      const chunks: string[] = [];
      for (let j = 0; j < text.length; j += CHUNK_SIZE) {
        let end = Math.min(j + CHUNK_SIZE, text.length);
        if (end < text.length) {
          const searchStart = Math.max(end - 500, j);
          const searchText = text.substring(searchStart, end);
          const lastPeriod = searchText.lastIndexOf('. ');
          if (lastPeriod > 0) {
            end = searchStart + lastPeriod + 2;
          }
        }
        chunks.push(text.substring(j, end));
        j = end - CHUNK_SIZE;
      }

      // Deduplicate chunks
      const uniqueChunks = chunks.filter((chunk, index) =>
        index === 0 || chunk !== chunks[index - 1]
      );

      // Process chunks
      const cleanedChunks: string[] = [];
      for (let c = 0; c < uniqueChunks.length; c++) {
        sendProgress({
          jobId,
          phase: 'processing',
          currentChapter: i + 1,
          totalChapters,
          currentChunk: c + 1,
          totalChunks: uniqueChunks.length,
          percentage: Math.round(((i + (c / uniqueChunks.length)) / totalChapters) * 90),
          message: `Processing: ${chapter.title} (chunk ${c + 1}/${uniqueChunks.length})`,
          outputPath
        });

        try {
          const cleaned = await cleanChunkWithProvider(uniqueChunks[c], systemPrompt, config);
          cleanedChunks.push(cleaned);
        } catch (error) {
          // If chunk fails, keep original text
          console.error(`Chunk ${c + 1} failed:`, error);
          cleanedChunks.push(uniqueChunks[c]);
        }
      }

      // Update chapter with cleaned text (stored in our local map)
      const cleanedText = cleanedChunks.join('');
      modifiedChapters.set(chapter.id, cleanedText);
      chaptersProcessed++;

      // Save incrementally after each chapter so diff view can work during processing
      try {
        await saveModifiedEpubLocal(processor, modifiedChapters, outputPath);
      } catch (saveError) {
        console.error(`Failed to save after chapter ${i + 1}:`, saveError);
        // Continue processing even if incremental save fails
      }
    }

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

    return {
      success: true,
      outputPath,
      chaptersProcessed
    };
  } catch (error) {
    // Clean up processor on error
    if (processor) {
      try {
        processor.close();
      } catch { /* ignore */ }
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendProgress({
      jobId,
      phase: 'error',
      currentChapter: 0,
      totalChapters: 0,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 0,
      message: `Error: ${message}`
    });
    return { success: false, error: message };
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
      // Read original XHTML
      const originalXhtml = await processor.readFile(entryName);
      // Replace body content with cleaned text
      const newXhtml = replaceXhtmlBodyLocal(originalXhtml, modifiedContent);
      zipWriter.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
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
 * Replace the body content in an XHTML document while preserving the structure.
 * Local version for use with dedicated processor.
 */
function replaceXhtmlBodyLocal(xhtml: string, newText: string): string {
  // Find the body tag
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    // No body tag, return as-is
    return xhtml;
  }

  // Convert plain text to paragraphs
  const paragraphs = newText.split(/\n\n+/).filter(p => p.trim());
  const htmlContent = paragraphs.map(p => `<p>${escapeXmlLocal(p.trim())}</p>`).join('\n');

  // Replace body content
  return xhtml.replace(
    /<body([^>]*)>[\s\S]*<\/body>/i,
    `<body$1>\n${htmlContent}\n</body>`
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
  getOcrCleanupSystemPrompt,
  loadPrompt,
  savePrompt,
  reloadPrompt,
  getPromptFilePath
};

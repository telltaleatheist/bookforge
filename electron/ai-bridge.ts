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
const TIMEOUT_MS = 120000; // 2 minutes per chunk

// ─────────────────────────────────────────────────────────────────────────────
// OCR Cleanup Prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the OCR cleanup prompt for text correction.
 * This prompt focuses on fixing OCR errors while preserving content.
 */
function buildCleanupPrompt(_options: AICleanupOptions): string {
  // The options parameter is kept for API compatibility but the prompt is now unified
  return `You are an OCR error correction specialist. Fix ONLY optical character recognition errors in this scanned book text.

FIX THESE OCR ERRORS:
- Broken words with hyphen-space: "traditi- onal" → "traditional"
- Character substitutions: rn→m, cl→d, li→h, vv→w, 0→O, l→I where appropriate
- Number/letter confusion: 0/O, 1/l/I, 5/S based on context
- Extra whitespace between words or letters
- Misrecognized punctuation

EXPAND FOR SPEECH:
- Era abbreviations: "500 BCE" → "500 B C E", "1200 AD" → "1200 A D"
- Do NOT write out "before common era" - just spell the letters

CRITICAL RULES:
- Use vocabulary knowledge to determine the correct word
- Preserve ALL content - do not remove, summarize, or skip anything
- Do not add commentary, explanations, or notes
- Return ONLY the corrected text, nothing else
- If unsure about a correction, leave the original text`;
}

/**
 * Build a simple OCR cleanup prompt for queue processing (entire EPUB).
 * Same as buildCleanupPrompt but exposed for queue use.
 */
export function getOcrCleanupSystemPrompt(): string {
  return buildCleanupPrompt({ fixHyphenation: true, fixOcrArtifacts: true, expandAbbreviations: true });
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
    return data.content?.[0]?.text || text;
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
    return data.choices?.[0]?.message?.content || text;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Clean up a chunk of text using the configured provider
 */
async function cleanChunkWithProvider(
  text: string,
  systemPrompt: string,
  config: AIProviderConfig
): Promise<string> {
  switch (config.provider) {
    case 'ollama':
      return cleanChunk(text, systemPrompt, config.ollama?.model || DEFAULT_MODEL);
    case 'claude':
      if (!config.claude?.apiKey) {
        throw new Error('Claude API key not configured');
      }
      return cleanChunkWithClaude(text, systemPrompt, config.claude.apiKey, config.claude.model);
    case 'openai':
      if (!config.openai?.apiKey) {
        throw new Error('OpenAI API key not configured');
      }
      return cleanChunkWithOpenAI(text, systemPrompt, config.openai.apiKey, config.openai.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Clean up a single chunk of text using Ollama
 */
async function cleanChunk(
  text: string,
  systemPrompt: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
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
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.response || text;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
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
 * Supports multiple AI providers via optional config.
 */
export async function cleanupEpub(
  epubPath: string,
  jobId: string,
  model: string = DEFAULT_MODEL,
  mainWindow?: BrowserWindow | null,
  onProgress?: (progress: EpubCleanupProgress) => void,
  providerConfig?: AIProviderConfig
): Promise<EpubCleanupResult> {
  // Use provided config or default to Ollama
  const config: AIProviderConfig = providerConfig || {
    provider: 'ollama',
    ollama: { baseUrl: OLLAMA_BASE_URL, model }
  };

  // Validate provider configuration
  if (config.provider === 'ollama') {
    const connection = await checkConnection();
    if (!connection.connected) {
      return { success: false, error: `Ollama not available: ${connection.error}` };
    }
    const modelToUse = config.ollama?.model || model;
    if (!(await hasModel(modelToUse))) {
      return { success: false, error: `Model '${modelToUse}' not found. Run: ollama pull ${modelToUse}` };
    }
  } else if (config.provider === 'claude') {
    if (!config.claude?.apiKey) {
      return { success: false, error: 'Claude API key not configured. Go to Settings > AI to configure.' };
    }
  } else if (config.provider === 'openai') {
    if (!config.openai?.apiKey) {
      return { success: false, error: 'OpenAI API key not configured. Go to Settings > AI to configure.' };
    }
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

  try {
    // Import epub processor dynamically
    const { parseEpub, getChapters, getChapterText, updateChapterText, saveModifiedEpub, closeEpub } = await import('./epub-processor.js');

    // Load the EPUB
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

    await parseEpub(epubPath);
    const chapters = getChapters();
    const totalChapters = chapters.length;

    if (totalChapters === 0) {
      closeEpub();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    const systemPrompt = getOcrCleanupSystemPrompt();
    let chaptersProcessed = 0;

    // Generate output path - save as cleaned.epub in the same folder as the original
    // This supports the project-based structure where original.epub and cleaned.epub live together
    const epubDir = path.dirname(epubPath);
    const outputPath = path.join(epubDir, 'cleaned.epub');

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

      // Get chapter text
      const text = await getChapterText(chapter.id);
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

      // Update chapter with cleaned text
      const cleanedText = cleanedChunks.join('');
      await updateChapterText(chapter.id, cleanedText);
      chaptersProcessed++;

      // Save incrementally after each chapter so diff view can work during processing
      try {
        await saveModifiedEpub(outputPath);
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

    await saveModifiedEpub(outputPath);
    closeEpub();

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
  getOcrCleanupSystemPrompt
};

/**
 * Translation Bridge - Multi-provider AI translation for EPUBs
 *
 * Translates EPUBs from German, French, or Spanish to English using
 * Ollama, Claude, or OpenAI.
 *
 * Recommended workflow: Translate -> AI Cleanup -> TTS
 */

import { BrowserWindow } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';

// Import types and helpers from ai-bridge
import type { AIProviderConfig } from './ai-bridge';
import {
  startDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';
import { extractChapterAsText } from './epub-processor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslationConfig {
  chunkSize?: number;  // Default 2500 characters
}

export interface TranslationProgress {
  jobId: string;
  phase: 'loading' | 'translating' | 'saving' | 'complete' | 'error';
  currentChapter: number;
  totalChapters: number;
  currentChunk: number;
  totalChunks: number;
  percentage: number;
  message?: string;
  error?: string;
  outputPath?: string;
  // Timing data for ETA
  chunksCompletedInJob?: number;
  totalChunksInJob?: number;
  chunkCompletedAt?: number;
}

export interface TranslationResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  chaptersProcessed?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 2500;
const TIMEOUT_MS = 180000; // 3 minutes per chunk
const OLLAMA_BASE_URL = 'http://localhost:11434';

// Universal translation prompt - model auto-detects source language
const TRANSLATION_PROMPT = `You are translating a book to English.

CRITICAL RULES:
- Translate ALL text faithfully - never summarize or skip content
- Preserve the original tone, style, and literary register
- Keep proper names, place names, and titles in their original form unless there's a well-known English equivalent
- Maintain paragraph structure and formatting
- Preserve any emphasis (italics would be conveyed by surrounding text context)
- Keep the same narrative voice (first person, third person, etc.)
- Translate idioms to equivalent English expressions that preserve meaning

Output ONLY the English translation. No commentary, no notes, no explanations.`;

// ─────────────────────────────────────────────────────────────────────────────
// Job Cancellation Support
// ─────────────────────────────────────────────────────────────────────────────

const activeTranslationJobs = new Map<string, AbortController>();

/**
 * Cancel an active translation job
 */
export function cancelTranslationJob(jobId: string): boolean {
  const controller = activeTranslationJobs.get(jobId);
  if (controller) {
    console.log(`[TRANSLATION] Cancelling job ${jobId}`);
    controller.abort();
    activeTranslationJobs.delete(jobId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart Chunking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the best boundary for a chunk.
 * Priority: chapter markers > paragraph breaks > sentence ends > word boundaries
 */
function findChunkBoundary(text: string, targetEnd: number): number {
  if (targetEnd >= text.length) {
    return text.length;
  }

  // Search window: look back up to 500 characters from target end
  const searchStart = Math.max(0, targetEnd - 500);
  const searchText = text.substring(searchStart, targetEnd);

  // Priority 1: Chapter markers
  const chapterPatterns = [
    /\n\n\n\n/g,                          // Four newlines
    /\nChapter\s+\d+/gi,                  // "Chapter 1"
    /\nKapitel\s+\d+/gi,                  // German "Kapitel"
    /\nChapitre\s+\d+/gi,                 // French "Chapitre"
    /\nCapítulo\s+\d+/gi,                 // Spanish "Capítulo"
  ];

  for (const pattern of chapterPatterns) {
    const match = [...searchText.matchAll(pattern)].pop();
    if (match && match.index !== undefined) {
      return searchStart + match.index;
    }
  }

  // Priority 2: Paragraph breaks (double newline)
  const paragraphBreak = searchText.lastIndexOf('\n\n');
  if (paragraphBreak > 0) {
    return searchStart + paragraphBreak + 2;
  }

  // Priority 3: Sentence endings
  const sentencePatterns = ['. ', '! ', '? ', '." ', '!" ', '?" '];
  let bestSentenceEnd = -1;
  for (const pattern of sentencePatterns) {
    const idx = searchText.lastIndexOf(pattern);
    if (idx > bestSentenceEnd) {
      bestSentenceEnd = idx;
    }
  }
  if (bestSentenceEnd > 0) {
    return searchStart + bestSentenceEnd + 2;
  }

  // Priority 4: Word boundaries (space)
  const lastSpace = searchText.lastIndexOf(' ');
  if (lastSpace > 0) {
    return searchStart + lastSpace + 1;
  }

  // Fallback: use target end
  return targetEnd;
}

/**
 * Split text into chunks respecting natural boundaries
 */
function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let position = 0;

  while (position < text.length) {
    const targetEnd = position + chunkSize;
    const actualEnd = findChunkBoundary(text, targetEnd);
    const chunk = text.substring(position, actualEnd);
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    position = actualEnd;
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Translation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a chunk using Ollama
 */
async function translateWithOllama(
  text: string,
  systemPrompt: string,
  model: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort());
  }

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
          temperature: 0.3, // Slightly higher than cleanup for natural translation
          num_predict: Math.max(4096, text.length * 3) // Allow expansion for translation
        },
        keep_alive: '10m'
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
 * Translate a chunk using Claude API
 */
async function translateWithClaude(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        max_tokens: Math.max(4096, text.length * 3),
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
 * Translate a chunk using OpenAI API
 */
async function translateWithOpenAI(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        max_tokens: Math.max(4096, text.length * 3),
        temperature: 0.3,
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
 * Translate a chunk using the configured provider with retry logic
 */
async function translateChunkWithProvider(
  text: string,
  systemPrompt: string,
  config: AIProviderConfig,
  maxRetries: number = 3,
  abortSignal?: AbortSignal
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Job cancelled');
    }

    try {
      switch (config.provider) {
        case 'ollama':
          if (!config.ollama?.model) {
            throw new Error('Ollama model not configured');
          }
          return await translateWithOllama(text, systemPrompt, config.ollama.model, abortSignal);
        case 'claude':
          if (!config.claude?.apiKey || !config.claude?.model) {
            throw new Error('Claude not configured');
          }
          return await translateWithClaude(text, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal);
        case 'openai':
          if (!config.openai?.apiKey || !config.openai?.model) {
            throw new Error('OpenAI not configured');
          }
          return await translateWithOpenAI(text, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal);
        default:
          throw new Error(`Unknown provider: ${config.provider}`);
      }
    } catch (error) {
      if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error('Job cancelled');
      }

      lastError = error as Error;
      const isRetryableError = error instanceof Error && (
        error.message.includes('fetch') ||
        error.message.includes('network') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('timeout')
      );

      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Translation attempt ${attempt} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Translation failed after retries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Translation Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate an entire EPUB from source language to English
 */
export async function translateEpub(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: TranslationProgress) => void) | undefined,
  providerConfig: AIProviderConfig,
  translationConfig: TranslationConfig
): Promise<TranslationResult> {
  console.log('[TRANSLATION] Starting translation:', {
    epubPath,
    jobId,
    provider: providerConfig.provider,
    model: providerConfig.ollama?.model || providerConfig.claude?.model || providerConfig.openai?.model
  });

  // Create AbortController for cancellation
  const abortController = new AbortController();
  activeTranslationJobs.set(jobId, abortController);

  const sendProgress = (progress: TranslationProgress) => {
    console.log(`[TRANSLATION] [${jobId.substring(0, 8)}] ${progress.phase.toUpperCase()} - Chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.percentage}%)`);
    if (onProgress) onProgress(progress);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'translation',
        phase: progress.phase,
        progress: progress.percentage,
        message: progress.message,
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks,
        currentChapter: progress.currentChapter,
        totalChapters: progress.totalChapters,
        outputPath: progress.outputPath,
        chunksCompletedInJob: progress.chunksCompletedInJob,
        totalChunksInJob: progress.totalChunksInJob,
        chunkCompletedAt: progress.chunkCompletedAt
      });
    }
  };

  let processor: InstanceType<typeof import('./epub-processor.js').EpubProcessor> | null = null;
  const modifiedChapters: Map<string, string> = new Map();

  try {
    const { EpubProcessor } = await import('./epub-processor.js');

    // Load EPUB
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

    if (chapters.length === 0) {
      processor.close();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    // Get translation prompt
    const systemPrompt = TRANSLATION_PROMPT;
    const chunkSize = translationConfig.chunkSize || DEFAULT_CHUNK_SIZE;

    // Pre-scan to calculate total chunks
    const chapterData: { chapter: typeof chapters[0]; chunks: string[] }[] = [];
    let totalChunksInJob = 0;

    for (const chapter of chapters) {
      const text = await processor.getChapterText(chapter.id);
      if (!text || text.trim().length === 0) continue;

      const chunks = splitIntoChunks(text, chunkSize);
      if (chunks.length > 0) {
        chapterData.push({ chapter, chunks });
        totalChunksInJob += chunks.length;
      }
    }

    if (totalChunksInJob === 0) {
      processor.close();
      return { success: false, error: 'No text content found in EPUB' };
    }

    console.log(`[TRANSLATION] Total chunks: ${totalChunksInJob} across ${chapterData.length} chapters`);

    // Generate output path
    const epubDir = path.dirname(epubPath);
    const epubName = path.basename(epubPath, '.epub');
    const outputPath = path.join(epubDir, `${epubName}_translated.epub`);

    // Delete any existing translated file
    try {
      await fsPromises.unlink(outputPath);
    } catch {
      // File doesn't exist
    }

    // Initialize diff cache for change tracking
    await clearDiffCache(outputPath);
    await startDiffCache(outputPath, epubPath);

    // Process chapters
    let chunksCompletedInJob = 0;
    let chaptersProcessed = 0;

    for (let i = 0; i < chapterData.length; i++) {
      if (abortController.signal.aborted) {
        throw new Error('Job cancelled');
      }

      const { chapter, chunks } = chapterData[i];
      const translatedChunks: string[] = [];

      for (let c = 0; c < chunks.length; c++) {
        if (abortController.signal.aborted) {
          throw new Error('Job cancelled');
        }

        const currentChunkInJob = chunksCompletedInJob + 1;

        sendProgress({
          jobId,
          phase: 'translating',
          currentChapter: i + 1,
          totalChapters: chapterData.length,
          currentChunk: currentChunkInJob,
          totalChunks: totalChunksInJob,
          percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
          message: `Translating: ${chapter.title}`,
          outputPath,
          chunksCompletedInJob,
          totalChunksInJob
        });

        try {
          const translated = await translateChunkWithProvider(
            chunks[c],
            systemPrompt,
            providerConfig,
            3,
            abortController.signal
          );
          translatedChunks.push(translated);
          chunksCompletedInJob++;

          sendProgress({
            jobId,
            phase: 'translating',
            currentChapter: i + 1,
            totalChapters: chapterData.length,
            currentChunk: chunksCompletedInJob,
            totalChunks: totalChunksInJob,
            percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
            message: `Translated chunk ${chunksCompletedInJob}/${totalChunksInJob}`,
            outputPath,
            chunksCompletedInJob,
            totalChunksInJob,
            chunkCompletedAt: Date.now()
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Check for unrecoverable errors
          const isUnrecoverable = errorMessage.includes('credit') ||
            errorMessage.includes('quota') ||
            errorMessage.includes('unauthorized') ||
            errorMessage.includes('invalid_api_key') ||
            errorMessage.includes('cancelled');

          if (isUnrecoverable) {
            throw error;
          }

          // For recoverable errors, use original text
          console.warn(`Translation failed for chunk, keeping original: ${errorMessage}`);
          translatedChunks.push(chunks[c]);
          chunksCompletedInJob++;
        }
      }

      // Store translated chapter
      const translatedText = translatedChunks.join('');
      modifiedChapters.set(chapter.id, translatedText);
      chaptersProcessed++;

      // Add to diff cache - track what changed in this chapter
      try {
        const chapterHref = processor.resolvePath(chapter.href);
        const originalXhtml = await processor.readFile(chapterHref);
        const translatedXhtml = replaceXhtmlBody(originalXhtml, translatedText);
        const originalTextForDiff = extractChapterAsText(originalXhtml);
        const translatedTextForDiff = extractChapterAsText(translatedXhtml);
        await addChapterDiff(chapter.id, chapter.title, originalTextForDiff, translatedTextForDiff);
      } catch (diffErr) {
        // Diff cache is optional - don't fail the translation
        console.warn(`[TRANSLATION] Failed to add chapter diff for "${chapter.title}":`, diffErr);
      }

      // Incremental save
      await saveTranslatedEpub(processor, modifiedChapters, outputPath);
    }

    // Final save
    sendProgress({
      jobId,
      phase: 'saving',
      currentChapter: chapterData.length,
      totalChapters: chapterData.length,
      currentChunk: totalChunksInJob,
      totalChunks: totalChunksInJob,
      percentage: 95,
      message: 'Saving translated EPUB...',
      outputPath
    });

    await saveTranslatedEpub(processor, modifiedChapters, outputPath);
    processor.close();
    processor = null;

    // Finalize diff cache
    await finalizeDiffCache();

    // Cleanup
    activeTranslationJobs.delete(jobId);

    sendProgress({
      jobId,
      phase: 'complete',
      currentChapter: chapterData.length,
      totalChapters: chapterData.length,
      currentChunk: totalChunksInJob,
      totalChunks: totalChunksInJob,
      percentage: 100,
      message: 'Translation complete',
      outputPath
    });

    return {
      success: true,
      outputPath,
      chaptersProcessed
    };
  } catch (error) {
    activeTranslationJobs.delete(jobId);

    if (processor) {
      try {
        processor.close();
      } catch { /* ignore */ }
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isCancelled = message === 'Job cancelled' || abortController.signal.aborted;

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

    return { success: false, error: isCancelled ? 'Cancelled by user' : message };
  }
}

/**
 * Save translated EPUB
 */
async function saveTranslatedEpub(
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
  const entries = (processor as any).zipReader?.getEntries() || [];

  for (const entryName of entries) {
    let isModified = false;
    let modifiedContent: string | null = null;

    for (const chapter of structure.chapters) {
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      if (entryName === href && modifiedChapters.has(chapter.id)) {
        isModified = true;
        modifiedContent = modifiedChapters.get(chapter.id) || null;
        break;
      }
    }

    if (isModified && modifiedContent !== null) {
      const originalXhtml = await processor.readFile(entryName);
      const newXhtml = replaceXhtmlBody(originalXhtml, modifiedContent);
      zipWriter.addFile(entryName, Buffer.from(newXhtml, 'utf8'));
    } else {
      const data = await processor.readBinaryFile(entryName);
      const compress = entryName !== 'mimetype';
      zipWriter.addFile(entryName, data, compress);
    }
  }

  await zipWriter.write(outputPath);
}

/**
 * Replace body content in XHTML while preserving heading structure.
 * First block from AI goes into the original heading tag (h1-h6).
 * Heading text always ends with a period for TTS pause.
 */
function replaceXhtmlBody(xhtml: string, newText: string): string {
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return xhtml;

  const bodyContent = bodyMatch[1];
  const blocks = newText.split(/\n\n+/).filter(p => p.trim());
  if (blocks.length === 0) return xhtml;

  // Detect heading in original XHTML
  const headingMatch = bodyContent.match(/<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/i);

  if (!headingMatch) {
    const htmlContent = blocks.map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n');
    return xhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>\n${htmlContent}\n</body>`);
  }

  const tag = headingMatch[1].toLowerCase();
  const attrs = headingMatch[2];

  // First block is the (translated) chapter title
  let titleText = blocks[0].replace(/\s+/g, ' ').trim();
  if (titleText && !/[.!?]$/.test(titleText)) titleText += '.';
  const headingHtml = `<${tag}${attrs}>${escapeXml(titleText)}</${tag}>`;
  const bodyBlocks = blocks.slice(1);

  const bodyHtml = bodyBlocks.map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n');
  const htmlContent = bodyHtml ? `${headingHtml}\n${bodyHtml}` : headingHtml;

  return xhtml.replace(/<body([^>]*)>[\s\S]*<\/body>/i, `<body$1>\n${htmlContent}\n</body>`);
}

/**
 * Escape text for XML
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const translationBridge = {
  translateEpub,
  cancelTranslationJob
};

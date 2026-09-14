/**
 * Translation Bridge - Multi-provider AI translation for EPUBs
 *
 * Translates EPUBs from German, French, or Spanish to English on a Crucible
 * server, or on the bundled local model.
 *
 * Recommended workflow: Translate -> AI Cleanup -> TTS
 */

import { BrowserWindow } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';

// Import types and helpers from ai-bridge
import type { AIProviderConfig, SkippedChunk } from './ai-bridge';
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
  // Failed-chunk accounting (ports AI cleanup's skipped-chunk discipline).
  // failedChunkCount > 0 means that many chunks kept their ORIGINAL (untranslated)
  // text in the output; per-chunk details are in skippedChunksPath.
  failedChunkCount?: number;
  skippedChunksPath?: string;
  // job-analytics.json record (persisted by the renderer as a 'translation' entry).
  // Counts chunks (~2500-char blocks) as the throughput unit for this path.
  analytics?: {
    jobId: string;
    startedAt: string;
    completedAt: string;
    durationSeconds: number;
    totalSentences: number;
    sentencesPerMinute: number;
    provider: string;
    model: string;
    targetLang: string;
    mode: 'mono' | 'bilingual';
    success: boolean;
    outputPath?: string;
    // Chunks that failed translation and kept original text (0 = fully translated)
    failedChunkCount?: number;
    skippedChunksPath?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_SIZE = 2500;
// Mirrors ai-bridge's MAX_FALLBACK_COUNT: abort the job once this many chunks
// have failed translation and kept their original (untranslated) text. Without
// this, a provider that refuses/errors on many chunks (a model that keeps
// declining the passage, a server that keeps timing out) produced a partially
// untranslated book that reported full success.
const MAX_FAILED_CHUNK_COUNT = 10;
// Failed-chunk artifact written next to the translated output. Same shape as
// cleanup's skipped-chunks.json (SkippedChunk[]), but a DISTINCT name: the
// translation input/output dir often coincides with a cleanup stage dir, and
// cleanup both deletes and rewrites 'skipped-chunks.json' as its own artifact —
// sharing the literal name would clobber one job's record with the other's.
const TRANSLATION_SKIPPED_CHUNKS_FILENAME = 'translation-skipped-chunks.json';

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
 * Translate a chunk using the bundled local llama.cpp model (active model).
 * Cogito is a reasoning model — strip any <think>…</think> block.
 */
async function translateWithLocal(
  text: string,
  systemPrompt: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const { llamaBridge } = await import('./llama-bridge.js');
  const out = await llamaBridge.generate({
    system: systemPrompt,
    prompt: text,
    temperature: 0.3,
    signal: abortSignal,
  });
  // Never `|| text` — that silently returns the original UNTRANSLATED text as
  // if translation succeeded (and short-circuits the retry loop). Fail loudly
  // on empty, the same way the Crucible arm below refuses an empty answer.
  const cleaned = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!cleaned) {
    throw new Error('Local model returned an empty translation (no text produced)');
  }
  return cleaned;
}

/**
 * The one sentence a provider that cannot translate here gets told.
 *
 * Two places ask and must not drift: the dispatch below, and the check
 * translateEpub runs before it touches the output file. A job config persisted
 * last week can still name a provider this build no longer has, so both are
 * reached in normal operation and both owe the operator a sentence.
 *
 * Ollama, Claude and OpenAI left BookForge entirely in Crucible phase 15.
 * Cloud keys now live inside the Crucible engine, which forwards to the
 * upstream on the operator's account, so "translate with Claude" has not
 * become impossible — it has become a Crucible server that happens to reach
 * Anthropic, which is a server name in this row rather than a provider name.
 */
function translationProviderRefusal(provider: string): Error {
  return new Error(
    `translation_provider_unsupported: "${provider}" cannot run a translation. Ollama, Claude `
    + 'and OpenAI were removed from BookForge in Crucible phase 15 — cloud keys now live inside '
    + 'the Crucible engine, which forwards to the upstream on the operator\'s account. Re-point '
    + 'this row at a Crucible server (provider "crucible") or at the bundled local model '
    + '(provider "local") and run it again.',
  );
}

/**
 * Refuse an impossible run BEFORE the first chunk.
 *
 * The per-chunk catch below treats an unrecognised failure as recoverable: it
 * keeps the chunk's original text and carries on, aborting only at
 * MAX_FAILED_CHUNK_COUNT. That is right for a model that declined one passage
 * and wrong for a provider this build does not have, which will decline every
 * passage — without this check a stale row would write ten untranslated
 * chunks into a half-built `_translated.epub` before failing with a
 * threshold message instead of the reason.
 */
function assertTranslationProviderSupported(config: AIProviderConfig): void {
  if (config.provider !== 'crucible' && config.provider !== 'local') {
    throw translationProviderRefusal(config.provider);
  }
}

/**
 * The model this run is LABELLED with, in the start log and in the analytics
 * record. Nothing decides anything from it.
 *
 * Deliberately not a chain across every provider's slot: each provider names
 * its model in exactly one place, and reading the others is how a run gets
 * filed under a model that never saw the text. There is no default arm, so if
 * `AIProvider` ever grows a third member the missing return is a compile
 * error here rather than a mislabelled row.
 */
function translationModelName(config: AIProviderConfig): string {
  switch (config.provider) {
    case 'crucible':
      // 'unknown' is unreachable for a run that produces an analytics record:
      // the dispatch refuses an unstamped `crucible.model` by name at the very
      // first chunk. It is here because this is a label, not a guard.
      return config.crucible?.model ?? 'unknown';
    case 'local':
      // The bundled llama.cpp layer runs whatever its ACTIVE model is and
      // takes no model argument, so there is usually nothing here to name —
      // 'unknown' is this record's existing idiom for exactly that.
      return config.local?.model ?? 'unknown';
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
        case 'local':
          return await translateWithLocal(text, systemPrompt, abortSignal);
        case 'crucible': {
          /*
           * THE TRANSLATE ACT ON A CRUCIBLE SERVER (crucible
           * `docs/PHASE7-LANES.md`; `translate` is one of the four capability
           * classes, `electron/crucible/text-acts.ts`).
           *
           * Both halves refused by name rather than defaulted: the server is
           * the row's assigned venue (`queue-steps/ai-provider.ts`), and the
           * model must already be RESIDENT — a translation never loads one,
           * because a load evicts whatever is on that card.
           *
           * The budget is `max(4096, len*2)` — the cleanup pass's, and for the
           * cleanup pass's reason: a translation ECHOES THE WHOLE CHUNK BACK,
           * in another language, so the answer really is the size of the
           * input. That is the one act where the input's length is the right
           * estimate.
           */
          if (!config.crucible?.server) {
            throw new Error('crucible_server_not_named: this translation names no Crucible server');
          }
          if (!config.crucible?.model) {
            throw new Error('crucible_model_not_named: this translation names no Crucible model');
          }
          const { crucibleChatOnce } = await import('./ai-bridge.js');
          const answer = await crucibleChatOnce({
            server: config.crucible.server,
            model: config.crucible.model,
            // The class this run IS, off the provider block the queue composed.
            act: config.crucible.act,
            system: systemPrompt,
            user: text,
            temperature: 0.1,
            maxTokens: Math.max(4096, text.length * 2),
            sizeChars: text.length,
            ...(abortSignal === undefined ? {} : { signal: abortSignal }),
          });
          if (answer.finishReason === 'length') {
            // Never the truncated translation: half a chunk in the target
            // language reads as a finished paragraph that simply stops.
            throw new Error(
              `crucible_translation_truncated: crucible "${config.crucible.server}" hit the token `
              + `budget on a ${text.length}-char chunk, so its translation is cut off.`,
            );
          }
          if (!answer.content.trim()) {
            throw new Error(
              `crucible_translation_empty: crucible "${config.crucible.server}" returned nothing `
              + `for a ${text.length}-char chunk (finish reason: ${answer.finishReason}).`,
            );
          }
          return answer.content;
        }
        default:
          // Reached from a persisted row naming a provider this build removed.
          // translateEpub refuses the same config earlier and for the same
          // reason; this arm is what keeps the dispatch itself honest for any
          // other caller. See translationProviderRefusal.
          throw translationProviderRefusal(config.provider);
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
    model: translationModelName(providerConfig)
  });

  const tStartMs = Date.now();  // wall-clock start for the translation analytics record

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

  // Failed-chunk accounting (declared outside the try so the error path can
  // still persist whatever was recorded before an abort — mirrors ai-bridge).
  const skippedChunks: SkippedChunk[] = [];
  let failedChunkCount = 0;

  try {
    // Before the EPUB is opened and long before the output file exists, so a
    // row naming a removed provider fails with the reason instead of a
    // half-written `_translated.epub`.
    assertTranslationProviderSupported(providerConfig);

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

    // Delete any stale failed-chunk artifact from a previous run (mirrors AI
    // cleanup's start-of-job delete of skipped-chunks.json) so a clean rerun
    // can't be misread as having failures.
    try {
      await fsPromises.unlink(path.join(epubDir, TRANSLATION_SKIPPED_CHUNKS_FILENAME));
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

          // For recoverable errors, keep the original text — but RECORD the
          // failure and count it toward the abort threshold, so a model that
          // refuses/errors on many chunks (a passage it keeps declining, a
          // server that keeps dropping the request) fails the job loudly
          // instead of silently shipping an untranslated book.
          console.warn(`[TRANSLATION] Chunk ${currentChunkInJob}/${totalChunksInJob} failed - keeping original (untranslated) text: ${errorMessage}`);
          failedChunkCount++;
          skippedChunks.push({
            chapterTitle: chapter.title,
            chunkIndex: c,
            overallChunkNumber: currentChunkInJob,
            totalChunks: totalChunksInJob,
            reason: 'error',
            text: chunks[c],
            aiResponse: errorMessage.substring(0, 500)
          });
          translatedChunks.push(chunks[c]);
          chunksCompletedInJob++;

          // Mirror ai-bridge's checkFallbackThreshold semantics: abort at the
          // threshold, not after it. The error path below persists the
          // failed-chunk artifact so the reason for the abort isn't lost.
          if (failedChunkCount >= MAX_FAILED_CHUNK_COUNT) {
            throw new Error(`TOO_MANY_FALLBACKS: ${failedChunkCount} chunks failed translation and kept original text (threshold: ${MAX_FAILED_CHUNK_COUNT}). Aborting translation to prevent shipping a partially untranslated book. Last error: ${errorMessage}`);
          }
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

    // Persist failed-chunk details next to the output (same shape as cleanup's
    // skipped-chunks.json) so the skipped-chunks tooling can display them.
    let skippedChunksPath: string | undefined;
    if (skippedChunks.length > 0) {
      skippedChunksPath = path.join(epubDir, TRANSLATION_SKIPPED_CHUNKS_FILENAME);
      await fsPromises.writeFile(skippedChunksPath, JSON.stringify(skippedChunks, null, 2), 'utf-8');
      console.warn(`[TRANSLATION] ${failedChunkCount} chunks failed translation and kept original text - details saved to ${skippedChunksPath}`);
    }

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

    const tDuration = Math.round((Date.now() - tStartMs) / 1000);
    const tMinutes = tDuration / 60;
    return {
      success: true,
      outputPath,
      chaptersProcessed,
      failedChunkCount,
      skippedChunksPath,
      analytics: {
        jobId,
        startedAt: new Date(tStartMs).toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: tDuration,
        totalSentences: totalChunksInJob,
        sentencesPerMinute: tMinutes > 0 ? Math.round((totalChunksInJob / tMinutes) * 10) / 10 : 0,
        provider: providerConfig.provider,
        model: translationModelName(providerConfig),
        targetLang: 'en',
        mode: 'mono',
        success: true,
        outputPath,
        failedChunkCount,
        skippedChunksPath,
      }
    };
  } catch (error) {
    activeTranslationJobs.delete(jobId);

    if (processor) {
      try {
        processor.close();
      } catch { /* ignore */ }
    }

    // Persist whatever failed chunks were recorded before the abort. On the
    // TOO_MANY_FALLBACKS path the success-path writer never runs, so without
    // this the one artifact that explains WHY the job failed (per-chunk reason
    // + text) would be thrown away. (Mirrors ai-bridge's error-path writer.)
    let errorSkippedChunksPath: string | undefined;
    if (skippedChunks.length > 0) {
      try {
        // epubDir is local to the try block; recompute it from in-scope params.
        const errorEpubDir = path.dirname(epubPath);
        errorSkippedChunksPath = path.join(errorEpubDir, TRANSLATION_SKIPPED_CHUNKS_FILENAME);
        await fsPromises.writeFile(errorSkippedChunksPath, JSON.stringify(skippedChunks, null, 2), 'utf-8');
        console.log(`[TRANSLATION] Saved ${skippedChunks.length} failed chunks (job failed) to ${errorSkippedChunksPath}`);
      } catch (writeErr) {
        errorSkippedChunksPath = undefined;
        console.warn(`[TRANSLATION] Failed to persist failed chunks on error: ${(writeErr as Error).message}`);
      }
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

    return {
      success: false,
      error: isCancelled ? 'Cancelled by user' : message,
      failedChunkCount,
      skippedChunksPath: errorSkippedChunksPath
    };
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
  const { createEpubSink } = await import('./epub-container.js');

  const structure = processor.getStructure();
  if (!structure) {
    throw new Error('No EPUB structure');
  }

  const zipWriter = await createEpubSink(outputPath, 'zip');
  const entries = processor.entryNames();

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

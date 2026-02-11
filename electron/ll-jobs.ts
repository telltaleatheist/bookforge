/**
 * Language Learning Jobs - Split pipeline handlers
 *
 * Separate handlers for each step of the language learning pipeline:
 * 1. ll-cleanup - AI cleanup of extracted text
 * 2. ll-translation - Translation and EPUB generation
 * 3. tts-conversion - Standard TTS (uses existing infrastructure)
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  splitIntoSentences,
  translateSentences,
  generateSeparateEpubs,
  cleanupText,
  BilingualProcessingConfig,
  ProcessingProgress,
  SentencePair,
  SplitGranularity
} from './bilingual-processor.js';
import { validateAndAlignSentences } from './sentence-alignment-window.js';

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Types & Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface StageAnalytics {
  name: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  error?: string;
  metrics?: {
    inputChars?: number;
    outputChars?: number;
    sentenceCount?: number;
    batchCount?: number;
    workerCount?: number;
    audioFilesGenerated?: number;
  };
}

interface ProjectAnalytics {
  projectId: string;
  projectTitle: string;
  createdAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  status: 'running' | 'completed' | 'error';
  stages: StageAnalytics[];
  summary?: {
    totalSentences?: number;
    sourceAudioDurationMs?: number;
    targetAudioDurationMs?: number;
    finalAudioDurationMs?: number;
  };
}

async function loadAnalytics(projectDir: string, projectId: string, projectTitle: string): Promise<ProjectAnalytics> {
  const analyticsPath = path.join(projectDir, 'analytics.json');
  try {
    const content = await fs.readFile(analyticsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Create new analytics
    return {
      projectId,
      projectTitle,
      createdAt: new Date().toISOString(),
      status: 'running',
      stages: []
    };
  }
}

async function saveAnalytics(projectDir: string, analytics: ProjectAnalytics): Promise<void> {
  const analyticsPath = path.join(projectDir, 'analytics.json');
  await fs.writeFile(analyticsPath, JSON.stringify(analytics, null, 2), 'utf-8');
}

function startStage(analytics: ProjectAnalytics, stageName: string): StageAnalytics {
  // Remove any existing stage with same name (restart scenario)
  analytics.stages = analytics.stages.filter(s => s.name !== stageName);

  const stage: StageAnalytics = {
    name: stageName,
    startedAt: new Date().toISOString(),
    status: 'running'
  };
  analytics.stages.push(stage);
  return stage;
}

function completeStage(
  analytics: ProjectAnalytics,
  stageName: string,
  metrics?: StageAnalytics['metrics'],
  error?: string
): void {
  const stage = analytics.stages.find(s => s.name === stageName);
  if (stage) {
    stage.completedAt = new Date().toISOString();
    if (stage.startedAt) {
      stage.durationMs = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
    }
    stage.status = error ? 'error' : 'completed';
    stage.error = error;
    if (metrics) {
      stage.metrics = metrics;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LLCleanupConfig {
  projectId: string;
  projectDir: string;
  // inputText removed - always reads from article.epub in projectDir
  sourceLang: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  cleanupPrompt?: string;
}

export interface LLTranslationConfig {
  projectId?: string;          // Required for bilingual workflow, optional for mono
  projectDir?: string;         // Required for bilingual workflow, optional for mono
  cleanedEpubPath?: string;    // Path to cleaned.epub (output from cleanup job)
  sourceLang: string;
  targetLang: string;
  title?: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  translationPrompt?: string;
  // Alignment verification
  autoApproveAlignment?: boolean;  // Skip preview if sentence counts match (default: true)
  // Sentence splitting granularity
  splitGranularity?: SplitGranularity;  // 'sentence' (default) or 'paragraph' (fewer segments)
}

export interface LLJobResult {
  success: boolean;
  outputPath?: string;
  translatedEpubPath?: string;  // For mono translation - path to translated EPUB
  error?: string;
  // For chaining to next job
  nextJobConfig?: {
    cleanedEpubPath?: string;     // From cleanup -> translation
    epubPath?: string;            // From translation -> TTS (legacy single EPUB)
    sentencePairsPath?: string;
    // Dual-EPUB flow for proper accent separation
    sourceEpubPath?: string;
    targetEpubPath?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Reporting
// ─────────────────────────────────────────────────────────────────────────────

function sendProgress(
  mainWindow: BrowserWindow | null,
  jobId: string,
  progress: ProcessingProgress
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ll-job:progress', {
      jobId,
      progress
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 1: AI Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run AI cleanup on extracted text
 * Reads from article.epub, writes cleaned content to cleaned.epub
 */
export async function runLLCleanup(
  jobId: string,
  config: LLCleanupConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-CLEANUP] Starting job ${jobId}`);

  // Always load text from article.epub
  const articleEpubPath = path.join(config.projectDir, 'article.epub');
  console.log(`[LL-CLEANUP] Loading text from article.epub: ${articleEpubPath}`);

  let inputText: string;
  try {
    const { extractTextFromEpub } = await import('./epub-processor.js');
    const result = await extractTextFromEpub(articleEpubPath);
    if (result.success && result.text) {
      inputText = result.text;
      console.log(`[LL-CLEANUP] Extracted ${inputText.length} chars from article.epub`);
    } else {
      throw new Error(result.error || 'Failed to extract text from EPUB');
    }
  } catch (err) {
    const errorMsg = `Failed to load text from article.epub: ${(err as Error).message}`;
    console.error(`[LL-CLEANUP] ${errorMsg}`);
    return {
      success: false,
      error: errorMsg
    };
  }

  console.log(`[LL-CLEANUP] Config:`, {
    projectId: config.projectId,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    textLength: inputText.length
  });

  // Load analytics
  const analytics = await loadAnalytics(config.projectDir, config.projectId, 'Project');
  startStage(analytics, 'cleanup');
  await saveAnalytics(config.projectDir, analytics);

  try {
    sendProgress(mainWindow, jobId, {
      phase: 'cleanup',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 0,
      message: 'Starting AI cleanup...'
    });

    // Build the bilingual config for the cleanup function
    const bilingualConfig: BilingualProcessingConfig = {
      projectId: config.projectId,
      sourceText: inputText,
      sourceLang: config.sourceLang,
      targetLang: 'en', // Not used for cleanup
      aiProvider: config.aiProvider,
      aiModel: config.aiModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      claudeApiKey: config.claudeApiKey,
      openaiApiKey: config.openaiApiKey,
      enableCleanup: true,
      cleanupPrompt: config.cleanupPrompt
    };

    // Run cleanup
    const cleanedText = await cleanupText(inputText, bilingualConfig, (progress) => {
      sendProgress(mainWindow, jobId, {
        phase: 'cleanup',
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks,
        currentSentence: 0,
        totalSentences: 0,
        percentage: progress.percentage,
        message: `Cleaning chunk ${progress.currentChunk}/${progress.totalChunks}...`
      });
    });

    // Generate cleaned.epub from the cleaned text
    // Split by double newlines to get paragraphs, then create EPUB
    const paragraphs = cleanedText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
    const cleanedEpubPath = path.join(config.projectDir, 'cleaned.epub');

    const { generateMonolingualEpub } = await import('./bilingual-processor.js');
    // Don't add bookforge marker to cleaned.epub - it's an intermediate format
    // The marker is only needed for TTS EPUBs (e.g., en.epub, de.epub)
    await generateMonolingualEpub(
      paragraphs,
      'Cleaned Article',
      config.sourceLang,
      cleanedEpubPath,
      { includeBookforgeMarker: false }
    );
    console.log(`[LL-CLEANUP] Generated cleaned.epub with ${paragraphs.length} paragraphs (${cleanedText.length} chars)`);

    // Update analytics
    completeStage(analytics, 'cleanup', {
      inputChars: inputText.length,
      outputChars: cleanedText.length
    });
    await saveAnalytics(config.projectDir, analytics);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 100,
      message: 'Cleanup complete'
    });

    return {
      success: true,
      outputPath: cleanedEpubPath,
      nextJobConfig: {
        cleanedEpubPath
      }
    };

  } catch (err) {
    console.error(`[LL-CLEANUP] Job ${jobId} failed:`, err);

    // Update analytics with error
    completeStage(analytics, 'cleanup', undefined, (err as Error).message);
    analytics.status = 'error';
    await saveAnalytics(config.projectDir, analytics);

    sendProgress(mainWindow, jobId, {
      phase: 'error',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 0,
      message: (err as Error).message
    });

    return {
      success: false,
      error: (err as Error).message
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job 2: Translation + EPUB Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate cleaned text and generate bilingual EPUB
 * Reads from cleaned.epub, saves to {sourceLang}.epub + {targetLang}.epub
 */
export async function runLLTranslation(
  jobId: string,
  config: LLTranslationConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-TRANSLATION] Starting job ${jobId}`);
  console.log(`[LL-TRANSLATION] Config:`, {
    projectId: config.projectId,
    cleanedEpubPath: config.cleanedEpubPath,
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel
  });

  // Validate required fields for bilingual translation
  if (!config.projectId || !config.projectDir || !config.cleanedEpubPath) {
    return {
      success: false,
      error: 'Bilingual translation requires projectId, projectDir, and cleanedEpubPath'
    };
  }

  // Load analytics
  const analytics = await loadAnalytics(config.projectDir, config.projectId, config.title || 'Project');
  startStage(analytics, 'translation');
  await saveAnalytics(config.projectDir, analytics);

  try {
    // Types for chapter-aware processing
    interface ChapterWithSentences {
      title: string;
      sourceSentences: string[];
      translatedSentences: string[];
    }

    // Check for cached translation first
    const sentencesCacheDir = path.join(config.projectDir, 'sentences');
    const targetCachePath = path.join(sentencesCacheDir, `${config.targetLang}.json`);
    let chapters: ChapterWithSentences[] = [];
    let pairs: SentencePair[] = [];
    let usedCache = false;

    try {
      const cachedContent = await fs.readFile(targetCachePath, 'utf-8');
      const cachedData = JSON.parse(cachedContent);

      // Verify cache is for correct source language
      if (cachedData.sourceLanguage === config.sourceLang) {
        // Check for chaptered cache (new format)
        if (cachedData.chapters?.length > 0) {
          console.log(`[LL-TRANSLATION] Found cached chaptered translation: ${cachedData.chapters.length} chapters`);
          chapters = cachedData.chapters.map((ch: any) => ({
            title: ch.title,
            sourceSentences: ch.sentences.map((s: any) => s.source),
            translatedSentences: ch.sentences.map((s: any) => s.target)
          }));
          // Flatten for alignment validation
          let idx = 0;
          for (const ch of cachedData.chapters) {
            for (const s of ch.sentences) {
              pairs.push({ index: idx++, source: s.source, target: s.target });
            }
          }
          usedCache = true;
        }
        // Check for flat cache (legacy format)
        else if (cachedData.sentences?.length > 0) {
          console.log(`[LL-TRANSLATION] Found cached flat translation: ${cachedData.sentences.length} pairs`);
          // Convert flat to single chapter
          chapters = [{
            title: config.title || 'Content',
            sourceSentences: cachedData.sentences.map((s: any) => s.source),
            translatedSentences: cachedData.sentences.map((s: any) => s.target)
          }];
          pairs = cachedData.sentences.map((s: { source: string; target: string }, i: number) => ({
            index: i,
            source: s.source,
            target: s.target
          }));
          usedCache = true;
        }

        if (usedCache) {
          sendProgress(mainWindow, jobId, {
            phase: 'translating',
            currentSentence: pairs.length,
            totalSentences: pairs.length,
            percentage: 70,
            message: `Using cached translation: ${pairs.length} sentences in ${chapters.length} chapters`
          });
        }
      }
    } catch {
      // No cache or invalid cache - proceed with translation
    }

    // If no cache, extract chapters and translate
    if (!usedCache) {
      // Extract chapters from the cleaned EPUB
      const { extractChaptersFromEpub } = await import('./epub-processor.js');
      const extractResult = await extractChaptersFromEpub(config.cleanedEpubPath);
      if (!extractResult.success || !extractResult.chapters) {
        throw new Error(extractResult.error || 'Failed to extract chapters from EPUB');
      }
      console.log(`[LL-TRANSLATION] Extracted ${extractResult.chapters.length} chapters from EPUB`);

      // Phase 1: Split each chapter into sentences
      const granularity = config.splitGranularity || 'sentence';
      const granularityLabel = granularity === 'paragraph' ? 'paragraphs' : 'sentences';
      sendProgress(mainWindow, jobId, {
        phase: 'splitting',
        currentSentence: 0,
        totalSentences: 0,
        percentage: 5,
        message: `Splitting ${extractResult.chapters.length} chapters into ${granularityLabel}...`
      });

      // Track chapter boundaries for reconstruction after translation
      interface ChapterBoundary {
        title: string;
        startIndex: number;
        endIndex: number;
      }
      const chapterBoundaries: ChapterBoundary[] = [];
      const allSentences: string[] = [];

      for (const chapter of extractResult.chapters) {
        const chapterSentences = splitIntoSentences(chapter.text, config.sourceLang, granularity);
        if (chapterSentences.length > 0) {
          chapterBoundaries.push({
            title: chapter.title,
            startIndex: allSentences.length,
            endIndex: allSentences.length + chapterSentences.length
          });
          allSentences.push(...chapterSentences);
        }
      }

      console.log(`[LL-TRANSLATION] Split into ${allSentences.length} ${granularityLabel} across ${chapterBoundaries.length} chapters`);

      // Phase 2: Translate all sentences (batched for efficiency)
      const bilingualConfig: BilingualProcessingConfig = {
        projectId: config.projectId,
        sourceText: '',  // Not used - we pass sentences directly
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        translationPrompt: config.translationPrompt
      };

      pairs = await translateSentences(allSentences, bilingualConfig, (progress) => {
        // Map translation progress to 10-70%
        const overallPercentage = 10 + Math.round((progress.percentage / 100) * 60);
        sendProgress(mainWindow, jobId, {
          phase: 'translating',
          currentSentence: progress.currentSentence,
          totalSentences: progress.totalSentences,
          percentage: overallPercentage,
          message: `Translating: ${progress.currentSentence}/${progress.totalSentences} sentences`
        });
      });

      console.log(`[LL-TRANSLATION] Translated ${pairs.length} sentence pairs`);

      // Reconstruct chapter structure from flat pairs
      for (const boundary of chapterBoundaries) {
        const chapterPairs = pairs.slice(boundary.startIndex, boundary.endIndex);
        chapters.push({
          title: boundary.title,
          sourceSentences: chapterPairs.map(p => p.source),
          translatedSentences: chapterPairs.map(p => p.target)
        });
      }
    }

    // Phase 3: Validate sentence alignment
    sendProgress(mainWindow, jobId, {
      phase: 'validating',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 75,
      message: 'Validating sentence alignment...'
    });

    // Only show alignment window if mainWindow is available
    if (mainWindow && !mainWindow.isDestroyed()) {
      const autoApprove = config.autoApproveAlignment !== false; // Default to true
      const alignmentResult = await validateAndAlignSentences(
        mainWindow,
        pairs,
        config.sourceLang,
        config.targetLang,
        config.projectId,
        jobId,
        autoApprove
      );

      if (alignmentResult.cancelled) {
        throw new Error('Job cancelled by user during alignment verification');
      }

      // Use the potentially modified pairs from alignment
      pairs = alignmentResult.pairs as SentencePair[];
      console.log(`[LL-TRANSLATION] Alignment approved with ${pairs.length} pairs`);
    }

    // Phase 4: Generate language EPUBs for TTS (e.g., en.epub, de.epub)
    // Each EPUB has chapters with one paragraph per sentence for proper alignment
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 85,
      message: `Generating chaptered EPUBs for TTS (${chapters.length} chapters)...`
    });

    // Name EPUBs by language code (e.g., en.epub, de.epub) for clarity with multiple translations
    const sourceEpubPath = path.join(config.projectDir, `${config.sourceLang}.epub`);
    const targetEpubPath = path.join(config.projectDir, `${config.targetLang}.epub`);
    const { generateChapteredEpub } = await import('./bilingual-processor.js');

    // Prepare chapter data for EPUB generation
    const sourceChapters = chapters.map(ch => ({
      title: ch.title,
      sentences: ch.sourceSentences
    }));
    const targetChapters = chapters.map(ch => ({
      title: ch.translatedSentences[0]?.toUpperCase() === ch.translatedSentences[0]
        ? ch.translatedSentences[0]  // Use first sentence if it looks like a title (all caps start)
        : ch.title,  // Otherwise keep original title
      sentences: ch.translatedSentences
    }));

    // Generate source language EPUB with chapters
    await generateChapteredEpub(
      sourceChapters,
      `${config.title || 'Book'} (${config.sourceLang})`,
      config.sourceLang,
      sourceEpubPath,
      { includeBookforgeMarker: false }
    );

    // Generate target language EPUB with chapters
    await generateChapteredEpub(
      targetChapters,
      `${config.title || 'Book'} (${config.targetLang})`,
      config.targetLang,
      targetEpubPath,
      { includeBookforgeMarker: false }
    );

    console.log(`[LL-TRANSLATION] Generated ${config.sourceLang}.epub and ${config.targetLang}.epub with ${chapters.length} chapters`);

    // Save sentence pairs for reference and assembly (flat format for compatibility)
    const pairsPath = path.join(config.projectDir, 'sentence_pairs.json');
    await fs.writeFile(pairsPath, JSON.stringify(pairs, null, 2));

    // Save to sentence cache for reuse (chaptered format)
    const sentencesDir = path.join(config.projectDir, 'sentences');
    await fs.mkdir(sentencesDir, { recursive: true });

    // Save source language cache with chapters
    const sourceCache = {
      language: config.sourceLang,
      sourceLanguage: null,
      createdAt: new Date().toISOString(),
      sentenceCount: pairs.length,
      chapters: chapters.map(ch => ({
        title: ch.title,
        sentences: ch.sourceSentences
      }))
    };
    await fs.writeFile(
      path.join(sentencesDir, `${config.sourceLang}.json`),
      JSON.stringify(sourceCache, null, 2)
    );

    // Save target language cache with chapters (with source pairs for reference)
    const targetCache = {
      language: config.targetLang,
      sourceLanguage: config.sourceLang,
      createdAt: new Date().toISOString(),
      sentenceCount: pairs.length,
      chapters: chapters.map(ch => ({
        title: ch.title,
        translatedTitle: ch.translatedSentences[0]?.toUpperCase() === ch.translatedSentences[0]
          ? ch.translatedSentences[0]
          : ch.title,
        sentences: ch.sourceSentences.map((src, i) => ({
          source: src,
          target: ch.translatedSentences[i] || ''
        }))
      }))
    };
    await fs.writeFile(
      path.join(sentencesDir, `${config.targetLang}.json`),
      JSON.stringify(targetCache, null, 2)
    );

    console.log(`[LL-TRANSLATION] Saved chaptered cache: ${config.sourceLang}.json, ${config.targetLang}.json`);

    // Update analytics
    completeStage(analytics, 'translation', {
      sentenceCount: pairs.length
    });
    analytics.summary = {
      ...analytics.summary,
      totalSentences: pairs.length
    };
    await saveAnalytics(config.projectDir, analytics);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 100,
      message: 'Translation complete - ready for TTS'
    });

    // Both EPUBs are generated with one paragraph per sentence for proper TTS alignment
    return {
      success: true,
      outputPath: targetEpubPath,
      nextJobConfig: {
        sourceEpubPath,   // e.g., en.epub - one paragraph per source sentence
        targetEpubPath,   // e.g., de.epub - one paragraph per target sentence
        sentencePairsPath: pairsPath
      }
    };

  } catch (err) {
    console.error(`[LL-TRANSLATION] Job ${jobId} failed:`, err);

    // Update analytics with error
    completeStage(analytics, 'translation', undefined, (err as Error).message);
    analytics.status = 'error';
    await saveAnalytics(config.projectDir, analytics);

    sendProgress(mainWindow, jobId, {
      phase: 'error',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 0,
      message: (err as Error).message
    });

    return {
      success: false,
      error: (err as Error).message
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mono Translation - Full book translation to single language
// ─────────────────────────────────────────────────────────────────────────────

export interface MonoTranslationConfig {
  cleanedEpubPath?: string;  // Input EPUB path (from job.epubPath if not provided)
  sourceLang: string;        // Source language of the book
  targetLang: string;        // Target language (usually 'en')
  title?: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  translationPrompt?: string;
}

/**
 * Mono Translation - Translates entire book to target language
 * Unlike bilingual translation, this produces a single translated EPUB
 * suitable for standard TTS processing.
 */
export async function runMonoTranslation(
  jobId: string,
  config: MonoTranslationConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[MONO-TRANSLATION] Starting job ${jobId}`);
  console.log(`[MONO-TRANSLATION] Config:`, {
    cleanedEpubPath: config.cleanedEpubPath,
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel
  });

  const inputEpubPath = config.cleanedEpubPath;
  if (!inputEpubPath) {
    return { success: false, error: 'No input EPUB path provided' };
  }

  // Output path: same directory as input, with _translated suffix
  const outputEpubPath = inputEpubPath.replace('.epub', '_translated.epub');

  try {
    // Extract chapters from the input EPUB
    const { extractChaptersFromEpub } = await import('./epub-processor.js');
    const extractResult = await extractChaptersFromEpub(inputEpubPath);

    if (!extractResult.success || !extractResult.chapters) {
      throw new Error(extractResult.error || 'Failed to extract chapters from EPUB');
    }

    const chapters = extractResult.chapters;
    console.log(`[MONO-TRANSLATION] Extracted ${chapters.length} chapters from EPUB`);

    sendProgress(mainWindow, jobId, {
      phase: 'splitting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 5,
      message: `Processing ${chapters.length} chapters for translation...`
    });

    // Split each chapter into sentences and collect all for translation
    interface ChapterWithSentences {
      title: string;
      sentences: string[];
      translatedSentences?: string[];
    }
    const chaptersWithSentences: ChapterWithSentences[] = [];
    const allSentences: string[] = [];
    const chapterBoundaries: { title: string; startIndex: number; endIndex: number }[] = [];

    for (const chapter of chapters) {
      const sentences = splitIntoSentences(chapter.text, config.sourceLang, 'sentence');
      if (sentences.length > 0) {
        chapterBoundaries.push({
          title: chapter.title,
          startIndex: allSentences.length,
          endIndex: allSentences.length + sentences.length
        });
        allSentences.push(...sentences);
        chaptersWithSentences.push({
          title: chapter.title,
          sentences
        });
      }
    }

    console.log(`[MONO-TRANSLATION] Split into ${allSentences.length} sentences across ${chapterBoundaries.length} chapters`);

    sendProgress(mainWindow, jobId, {
      phase: 'translating',
      currentSentence: 0,
      totalSentences: allSentences.length,
      percentage: 10,
      message: `Translating ${allSentences.length} sentences...`
    });

    // Translate all sentences
    const bilingualConfig: BilingualProcessingConfig = {
      projectId: jobId,  // Use jobId as project ID for mono translation
      sourceText: '',    // Not used - we pass sentences directly
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      aiProvider: config.aiProvider,
      aiModel: config.aiModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      claudeApiKey: config.claudeApiKey,
      openaiApiKey: config.openaiApiKey,
      translationPrompt: config.translationPrompt
    };

    const pairs = await translateSentences(allSentences, bilingualConfig, (progress) => {
      // Map translation progress to 10-80%
      const overallPercentage = 10 + Math.round((progress.percentage / 100) * 70);
      sendProgress(mainWindow, jobId, {
        phase: 'translating',
        currentSentence: progress.currentSentence,
        totalSentences: progress.totalSentences,
        percentage: overallPercentage,
        message: `Translating: ${progress.currentSentence}/${progress.totalSentences} sentences`
      });
    });

    console.log(`[MONO-TRANSLATION] Translated ${pairs.length} sentences`);

    // Reconstruct translated chapters
    for (const boundary of chapterBoundaries) {
      const chapter = chaptersWithSentences.find(ch => ch.title === boundary.title);
      if (chapter) {
        const chapterPairs = pairs.slice(boundary.startIndex, boundary.endIndex);
        chapter.translatedSentences = chapterPairs.map(p => p.target);
      }
    }

    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 85,
      message: 'Generating translated EPUB...'
    });

    // Generate translated EPUB using the chaptered format
    const { generateChapteredEpub } = await import('./bilingual-processor.js');

    // Prepare translated chapters for EPUB generation
    // For mono translation, we want natural paragraphs, so we join sentences
    // with proper paragraph breaks
    const translatedChapters = chaptersWithSentences.map(ch => ({
      title: ch.title,
      sentences: ch.translatedSentences || []
    }));

    await generateChapteredEpub(
      translatedChapters,
      `${config.title || 'Book'} (Translated)`,
      config.targetLang,
      outputEpubPath,
      { includeBookforgeMarker: true }  // Mark as processed by BookForge
    );

    console.log(`[MONO-TRANSLATION] Generated translated EPUB: ${outputEpubPath}`);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 100,
      message: 'Translation complete'
    });

    return {
      success: true,
      outputPath: outputEpubPath,
      translatedEpubPath: outputEpubPath
    };

  } catch (err) {
    console.error(`[MONO-TRANSLATION] Job ${jobId} failed:`, err);

    sendProgress(mainWindow, jobId, {
      phase: 'error',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 0,
      message: (err as Error).message
    });

    return {
      success: false,
      error: (err as Error).message
    };
  }
}

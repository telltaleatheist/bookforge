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
import { loadPrompt, PROMPTS } from './prompts.js';
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
import {
  startDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';

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
  sourceEpubPath?: string;  // Path to source EPUB (falls back to article.epub for articles)
  sourceLang: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  cleanupPrompt?: string;
  simplifyForLearning?: boolean;  // Simplify text for language learners
  startFresh?: boolean;  // Start from source EPUB vs use existing cleaned.epub
  // Test mode - limit chunks for faster testing
  testMode?: boolean;
  testModeChunks?: number;
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
  // Test mode - limit sentences for faster testing
  testMode?: boolean;
  testModeChunks?: number;  // Number of sentences to translate in test mode
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
 * Reads from source EPUB (or article.epub for articles), writes cleaned content to cleaned.epub
 */
export async function runLLCleanup(
  jobId: string,
  config: LLCleanupConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-CLEANUP] Starting job ${jobId}`);

  // Use sourceEpubPath if provided, otherwise fall back to article.epub (for articles)
  const sourceEpubPath = config.sourceEpubPath || path.join(config.projectDir, 'article.epub');

  // Always use 'cleaned.epub' for consistency
  const cleanedFilename = 'cleaned.epub';
  const cleanedEpubPath = path.join(config.projectDir, cleanedFilename);

  // Handle startFresh flag - delete existing cleaned.epub if starting fresh
  if (config.startFresh !== false) {  // Default to true if not specified
    try {
      await fs.stat(cleanedEpubPath);
      console.log(`[LL-CLEANUP] startFresh=true, deleting existing ${cleanedFilename}`);
      await fs.unlink(cleanedEpubPath);
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  // Determine which EPUB to read from based on simplification mode and existence
  let readFromPath = sourceEpubPath;
  let workingOnCleaned = false;

  // Check if we should read from an existing cleaned version
  // Only use existing cleaned.epub if startFresh is false
  if (config.startFresh === false) {
    try {
      await fs.stat(cleanedEpubPath);
      readFromPath = cleanedEpubPath;
      workingOnCleaned = true;
      console.log(`[LL-CLEANUP] startFresh=false, using existing cleaned EPUB: ${cleanedFilename}`);
    } catch {
      console.log(`[LL-CLEANUP] startFresh=false but no existing cleaned EPUB, will read from source: ${path.basename(sourceEpubPath)}`);
    }
  } else {
    console.log(`[LL-CLEANUP] startFresh=true, reading from source: ${path.basename(sourceEpubPath)}`);
  }

  console.log(`[LL-CLEANUP] Loading chapters from: ${path.basename(readFromPath)}`);

  // Always keep track of original chapters for diff comparison
  let originalChapters: Array<{ id: string; title: string; text: string }>;
  let workingChapters: Array<{ id: string; title: string; text: string }>;
  let inputText: string;

  try {
    const { extractChaptersFromEpub } = await import('./epub-processor.js');

    // Always load original chapters for diff comparison
    const originalResult = await extractChaptersFromEpub(sourceEpubPath);
    if (originalResult.success && originalResult.chapters) {
      originalChapters = originalResult.chapters;
      console.log(`[LL-CLEANUP] Loaded ${originalChapters.length} original chapters for diff comparison`);
    } else {
      throw new Error(originalResult.error || 'Failed to extract chapters from source EPUB');
    }

    // Load working chapters (may be from cleaned if it exists)
    if (workingOnCleaned) {
      const workingResult = await extractChaptersFromEpub(readFromPath);
      if (workingResult.success && workingResult.chapters) {
        workingChapters = workingResult.chapters;
        inputText = workingChapters.map(ch => ch.text).join('\n\n');
        console.log(`[LL-CLEANUP] Extracted ${workingChapters.length} chapters (${inputText.length} total chars) from existing cleaned EPUB`);
      } else {
        throw new Error(workingResult.error || 'Failed to extract chapters from cleaned EPUB');
      }
    } else {
      workingChapters = originalChapters;
      inputText = workingChapters.map(ch => ch.text).join('\n\n');
      console.log(`[LL-CLEANUP] Using ${workingChapters.length} chapters (${inputText.length} total chars) from source EPUB`);
    }
  } catch (err) {
    const errorMsg = `Failed to load chapters: ${(err as Error).message}`;
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
    textLength: inputText.length,
    simplifyForLearning: config.simplifyForLearning || false
  });

  // Debug: log the raw values
  console.log(`[LL-CLEANUP] Raw simplifyForLearning value:`, config.simplifyForLearning);
  console.log(`[LL-CLEANUP] typeof simplifyForLearning:`, typeof config.simplifyForLearning);
  console.log(`[LL-CLEANUP] startFresh value:`, config.startFresh);
  console.log(`[LL-CLEANUP] cleanupPrompt provided:`, config.cleanupPrompt ? 'YES' : 'NO');

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

    // Choose prompt based on user selection - simple trade-off
    let finalPrompt: string;

    if (config.simplifyForLearning) {
      // User chose simplification - load simplification prompt from file
      console.log(`[LL-CLEANUP] Loading simplification prompt from file`);
      finalPrompt = await loadPrompt(PROMPTS.LL_SIMPLIFY);
    } else {
      // User chose cleanup (or default) - load cleanup prompt from file or use provided
      console.log(`[LL-CLEANUP] Loading standard cleanup prompt`);
      finalPrompt = config.cleanupPrompt || await loadPrompt(PROMPTS.TTS_CLEANUP);
    }

    console.log(`[LL-CLEANUP] Prompt selected (${finalPrompt.length} chars)`);

    // Build the bilingual config for the cleanup function - will be modified per chapter in test mode
    const baseBilingualConfig: BilingualProcessingConfig = {
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
      cleanupPrompt: finalPrompt,
      testMode: config.testMode,
      testModeChunks: config.testModeChunks
    };

    // Track total chunks across all chapters for test mode
    let totalChunksToProcess = config.testMode && config.testModeChunks ? config.testModeChunks : Infinity;
    let totalChunksProcessedSoFar = 0;

    if (config.testMode && config.testModeChunks) {
      console.log(`[LL-CLEANUP] Test mode: will process up to ${config.testModeChunks} total chunks across all chapters`);
    }

    // Clean each chapter individually to preserve structure
    const cleanedChapters: Array<{ title: string; sentences: string[] }> = [];
    const estimatedTotalChunks = config.testMode && config.testModeChunks ?
      config.testModeChunks :
      workingChapters.length * 3; // Estimate ~3 chunks per chapter

    for (let i = 0; i < workingChapters.length; i++) {
      const chapter = workingChapters[i];

      // Stop if we've processed enough chunks in test mode
      if (totalChunksProcessedSoFar >= totalChunksToProcess) {
        console.log(`[LL-CLEANUP] Test mode: Stopping after ${totalChunksProcessedSoFar} chunks`);
        break;
      }

      console.log(`[LL-CLEANUP] Cleaning chapter ${i + 1}/${workingChapters.length}: ${chapter.title}`);

      // In test mode, limit chunks for this chapter based on remaining quota
      const chapterConfig = { ...baseBilingualConfig };
      if (config.testMode && config.testModeChunks) {
        const remainingChunks = totalChunksToProcess - totalChunksProcessedSoFar;
        if (remainingChunks <= 0) break;
        chapterConfig.testMode = true;
        chapterConfig.testModeChunks = remainingChunks;
      }

      // Track chunks processed in this chapter
      let chunksProcessedInThisChapter = 0;

      // Clean this chapter's text
      const cleanedChapterText = await cleanupText(chapter.text, chapterConfig, (progress) => {
        // Track chunks - cleanupText reports 1-based chunk numbers
        if (progress.currentChunk && progress.currentChunk > chunksProcessedInThisChapter) {
          const newChunks = progress.currentChunk - chunksProcessedInThisChapter;
          chunksProcessedInThisChapter = progress.currentChunk;
          totalChunksProcessedSoFar += newChunks;
        }

        // Calculate overall progress across all chapters
        const overallProgress = Math.round(
          ((totalChunksProcessedSoFar) / estimatedTotalChunks) * 100
        );

        sendProgress(mainWindow, jobId, {
          phase: 'cleanup',
          currentChunk: totalChunksProcessedSoFar,
          totalChunks: estimatedTotalChunks,
          currentSentence: 0,
          totalSentences: 0,
          percentage: overallProgress,
          message: `Cleaning chapter ${i + 1}/${workingChapters.length}: ${chapter.title}...`
        });
      });

      // Split cleaned chapter text into sentences/paragraphs
      const sentences = cleanedChapterText.split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

      cleanedChapters.push({
        title: chapter.title || `Chapter ${i + 1}`,
        sentences
      });

      // Log progress in test mode
      if (config.testMode && config.testModeChunks) {
        console.log(`[LL-CLEANUP] Processed ${chunksProcessedInThisChapter} chunks in chapter ${i + 1}, total so far: ${totalChunksProcessedSoFar}/${totalChunksToProcess}`);
      }
    }

    // Create combined cleaned text for analytics and diff
    const cleanedText = cleanedChapters
      .map(ch => ch.sentences.join('\n\n'))
      .join('\n\n');

    // We've already determined the input path earlier
    // Use workingOnCleaned flag to determine if this is incremental
    const inputEpubPath = workingOnCleaned ? cleanedEpubPath : sourceEpubPath;
    const isIncrementalUpdate = workingOnCleaned;

    // Start diff cache for Review Changes functionality
    // Only clear cache if this is not an incremental update
    if (!isIncrementalUpdate) {
      await clearDiffCache(cleanedEpubPath);
    }
    await startDiffCache(cleanedEpubPath);

    // Prepare chapter replacements for the new approach
    const chapterReplacements: Array<{ chapterId: string; newText: string }> = [];
    for (let i = 0; i < cleanedChapters.length; i++) {
      const cleanedChapter = cleanedChapters[i];
      // The chapter ID in EPUB is "chapter1", "chapter2", etc. (without dash)
      const chapterId = `chapter${i + 1}`;
      const newText = cleanedChapter.sentences.join('\n\n');
      chapterReplacements.push({ chapterId, newText });
    }

    // Use the new function to duplicate and modify the EPUB
    const { replaceChapterTextsInEpub } = await import('./epub-processor.js');
    const replaceResult = await replaceChapterTextsInEpub(
      inputEpubPath,
      cleanedEpubPath,
      chapterReplacements
    );

    if (!replaceResult.success) {
      throw new Error(`Failed to update EPUB: ${replaceResult.error}`);
    }

    console.log(`[LL-CLEANUP] Updated ${isIncrementalUpdate ? 'existing' : 'new'} cleaned EPUB with ${cleanedChapters.length} chapters (${cleanedText.length} chars)`);

    // Add diffs for each chapter to cache for Review Changes functionality
    // Always compare against the original source chapters for accurate diffs
    for (let i = 0; i < cleanedChapters.length; i++) {
      const originalChapter = originalChapters[i];
      const cleanedChapter = cleanedChapters[i];
      if (originalChapter && cleanedChapter) {
        await addChapterDiff(
          `chapter${i + 1}`,  // Match EPUB chapter IDs (no dash)
          cleanedChapter.title,
          originalChapter.text,
          cleanedChapter.sentences.join('\n\n')
        );
      }
    }

    // Finalize the diff cache
    await finalizeDiffCache();

    // Update the project metadata for the review tab to work
    // Check if this is a book (BFP) or article (project.json) based on projectId
    if (config.projectId.endsWith('.bfp')) {
      // This is a book project - update the BFP file with cleanedAt timestamp
      try {
        const bfpContent = await fs.readFile(config.projectId, 'utf-8');
        const bfpProject = JSON.parse(bfpContent);

        // Set cleanedAt timestamp so the Review tab will be enabled
        if (!bfpProject.audiobook) {
          bfpProject.audiobook = {};
        }
        bfpProject.audiobook.cleanedAt = new Date().toISOString();
        bfpProject.modified_at = new Date().toISOString();

        await fs.writeFile(config.projectId, JSON.stringify(bfpProject, null, 2), 'utf-8');
        console.log(`[LL-CLEANUP] Updated BFP with cleanedAt timestamp`);
      } catch (err) {
        console.warn(`[LL-CLEANUP] Failed to update BFP:`, err);
        // Don't fail the job if BFP update fails
      }
    } else {
      // This is a language learning article - update project.json
      try {
        const { updateProject } = await import('./web-fetch-bridge.js');
        // For articles, projectId is just the ID, projectDir already contains the full path
        const projectPath = path.dirname(config.projectDir);
        const projectsPath = path.dirname(projectPath);
        const libraryRoot = path.resolve(projectsPath, '../..');
        await updateProject(config.projectId, {
          cleanedEpubPath: cleanedEpubPath,
          hasCleaned: true,
          modifiedAt: new Date().toISOString()
        }, libraryRoot);
        console.log(`[LL-CLEANUP] Updated project.json with cleanedEpubPath and hasCleaned flag`);
      } catch (err) {
        console.warn(`[LL-CLEANUP] Failed to update project.json:`, err);
        // Don't fail the job if project update fails
      }
    }

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
        let chapterSentences = splitIntoSentences(chapter.text, config.sourceLang, granularity);

        // Filter out sentences that are just the chapter title (prevents cascading duplicates)
        // The title is already shown as h1 in the EPUB, so we don't need it as sentence content
        const normalizedTitle = chapter.title.replace(/[.!?]+$/, '').toLowerCase().trim();
        chapterSentences = chapterSentences.filter(s => {
          const normalizedSentence = s.replace(/[.!?]+$/, '').toLowerCase().trim();
          return normalizedSentence !== normalizedTitle;
        });

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

      // Apply test mode limit if enabled
      let sentencesToTranslate = allSentences;
      if (config.testMode && config.testModeChunks && config.testModeChunks > 0) {
        const limit = config.testModeChunks;
        sentencesToTranslate = allSentences.slice(0, limit);
        console.log(`[LL-TRANSLATION] Test mode: limiting to ${limit} sentences (was ${allSentences.length})`);

        // Also adjust chapter boundaries for test mode
        let remaining = limit;
        for (const boundary of chapterBoundaries) {
          const chapterSize = boundary.endIndex - boundary.startIndex;
          if (remaining <= 0) {
            boundary.endIndex = boundary.startIndex; // Empty chapter
          } else if (remaining < chapterSize) {
            boundary.endIndex = boundary.startIndex + remaining;
            remaining = 0;
          } else {
            remaining -= chapterSize;
          }
        }
      }

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

      pairs = await translateSentences(sentencesToTranslate, bilingualConfig, (progress) => {
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

    // Phase 3: Validate sentence alignment (skip if autoApprove is true)
    const autoApprove = config.autoApproveAlignment !== false; // Default to true

    if (!autoApprove && mainWindow && !mainWindow.isDestroyed()) {
      sendProgress(mainWindow, jobId, {
        phase: 'validating',
        currentSentence: pairs.length,
        totalSentences: pairs.length,
        percentage: 75,
        message: 'Validating sentence alignment...'
      });

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
    } else {
      console.log(`[LL-TRANSLATION] Skipping alignment window (autoApprove=${autoApprove}), using ${pairs.length} pairs`);
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
    // Filter out empty chapters AND ensure source/target have matching sentence counts per chapter
    const validChapters: Array<{ title: string; sourceSentences: string[]; targetSentences: string[] }> = [];

    for (const ch of chapters) {
      // Filter out undefined/empty sentences from both arrays
      const sourceSentences = (ch.sourceSentences || []).filter((s): s is string => typeof s === 'string' && s.length > 0);
      const targetSentences = (ch.translatedSentences || []).filter((s): s is string => typeof s === 'string' && s.length > 0);

      // Only include chapter if both have sentences AND counts match
      if (sourceSentences.length > 0 && targetSentences.length > 0) {
        // If counts don't match, truncate to the shorter one (shouldn't happen, but be safe)
        const minLen = Math.min(sourceSentences.length, targetSentences.length);
        if (sourceSentences.length !== targetSentences.length) {
          console.warn(`[LL-TRANSLATION] Chapter "${ch.title}" has mismatched counts: ${sourceSentences.length} source, ${targetSentences.length} target. Truncating to ${minLen}.`);
        }
        validChapters.push({
          title: ch.title,
          sourceSentences: sourceSentences.slice(0, minLen),
          targetSentences: targetSentences.slice(0, minLen)
        });
      }
    }

    const sourceChapters = validChapters.map(ch => ({
      title: ch.title,
      sentences: ch.sourceSentences
    }));

    const targetChapters = validChapters.map(ch => ({
      title: ch.title, // Use same title as source for consistency
      sentences: ch.targetSentences
    }));

    // Final validation: total sentence counts must match
    const totalSourceSentences = sourceChapters.reduce((sum, ch) => sum + ch.sentences.length, 0);
    const totalTargetSentences = targetChapters.reduce((sum, ch) => sum + ch.sentences.length, 0);

    if (totalSourceSentences !== totalTargetSentences) {
      throw new Error(`Source/target sentence count mismatch: ${totalSourceSentences} vs ${totalTargetSentences}`);
    }

    console.log(`[LL-TRANSLATION] Validated ${validChapters.length} chapters with ${totalSourceSentences} sentences each`);

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

    console.log(`[LL-TRANSLATION] Generated ${config.sourceLang}.epub and ${config.targetLang}.epub with ${validChapters.length} chapters`);

    // Save sentence pairs for reference and assembly (flat format using validated data)
    const validatedPairs = validChapters.flatMap(ch =>
      ch.sourceSentences.map((src, i) => ({
        index: i,
        source: src,
        target: ch.targetSentences[i]
      }))
    );
    const pairsPath = path.join(config.projectDir, 'sentence_pairs.json');
    await fs.writeFile(pairsPath, JSON.stringify(validatedPairs, null, 2));

    // Save to sentence cache for reuse (chaptered format)
    const sentencesDir = path.join(config.projectDir, 'sentences');
    await fs.mkdir(sentencesDir, { recursive: true });

    // Save source language cache with validated chapters
    const sourceCache = {
      language: config.sourceLang,
      sourceLanguage: null,
      createdAt: new Date().toISOString(),
      sentenceCount: totalSourceSentences,
      chapters: validChapters.map(ch => ({
        title: ch.title,
        sentences: ch.sourceSentences
      }))
    };
    await fs.writeFile(
      path.join(sentencesDir, `${config.sourceLang}.json`),
      JSON.stringify(sourceCache, null, 2)
    );

    // Save target language cache with validated chapters (with source pairs for reference)
    const targetCache = {
      language: config.targetLang,
      sourceLanguage: config.sourceLang,
      createdAt: new Date().toISOString(),
      sentenceCount: totalTargetSentences,
      chapters: validChapters.map(ch => ({
        title: ch.title,
        sentences: ch.sourceSentences.map((src, i) => ({
          source: src,
          target: ch.targetSentences[i]
        }))
      }))
    };
    await fs.writeFile(
      path.join(sentencesDir, `${config.targetLang}.json`),
      JSON.stringify(targetCache, null, 2)
    );

    console.log(`[LL-TRANSLATION] Saved chaptered cache: ${config.sourceLang}.json, ${config.targetLang}.json`);

    // Update analytics with validated counts
    completeStage(analytics, 'translation', {
      sentenceCount: totalSourceSentences
    });
    analytics.summary = {
      ...analytics.summary,
      totalSentences: totalSourceSentences
    };
    await saveAnalytics(config.projectDir, analytics);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: totalSourceSentences,
      totalSentences: totalSourceSentences,
      percentage: 100,
      message: `Translation complete - ${validChapters.length} chapters, ${totalSourceSentences} sentences`
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

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
  cleanupText,
  callAI,
  LANGUAGE_NAMES,
  BilingualProcessingConfig,
  ProcessingProgress,
  SentencePair,
  SkippedChunk,
  SplitGranularity
} from './bilingual-processor.js';
import { validateAndAlignSentences } from './sentence-alignment-window.js';
import {
  startDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';
import {
  EpubProcessor,
  ZipReader,
  ZipWriter,
  extractBlockTexts,
  replaceBlockTexts,
  formatNumberedParagraphs,
  parseNumberedParagraphs,
  validateNumberedParagraphs,
} from './epub-processor.js';
import * as cheerio from 'cheerio';

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
  sourceEpubPath?: string;  // Path to source EPUB
  sourceLang: string;
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  cleanupPrompt?: string;
  customInstructions?: string;    // Additional instructions appended to the AI prompt
  simplifyForLearning?: boolean;  // Simplify text for language learners
  startFresh?: boolean;  // Start from source EPUB vs use existing cleaned/simplified EPUB
  // Test mode - limit chunks for faster testing
  testMode?: boolean;
  testModeChunks?: number;
}

export interface LLTranslationConfig {
  projectId?: string;          // Required for bilingual workflow, optional for mono
  projectDir?: string;         // Required for bilingual workflow, optional for mono
  cleanedEpubPath?: string;    // Path to cleaned/simplified EPUB (output from cleanup job)
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
 * Reads from source EPUB, writes to cleaned.epub or simplified.epub
 */
export async function runLLCleanup(
  jobId: string,
  config: LLCleanupConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-CLEANUP] Starting job ${jobId}`);

  // Use sourceEpubPath if provided, otherwise fall back to source/original.epub
  const sourceEpubPath = config.sourceEpubPath || path.join(config.projectDir, 'source', 'original.epub');

  // Output filename depends on mode: simplify → simplified.epub, cleanup → cleaned.epub
  const cleanedFilename = config.simplifyForLearning ? 'simplified.epub' : 'cleaned.epub';
  const cleanupStageDir = path.join(config.projectDir, 'stages', '01-cleanup');
  await fs.mkdir(cleanupStageDir, { recursive: true });
  const cleanedEpubPath = path.join(cleanupStageDir, cleanedFilename);

  // Handle startFresh flag - delete existing output if starting fresh
  if (config.startFresh !== false) {  // Default to true if not specified
    try {
      await fs.stat(cleanedEpubPath);
      console.log(`[LL-CLEANUP] startFresh=true, deleting existing ${cleanedFilename}`);
      await fs.unlink(cleanedEpubPath);
    } catch {
      // File doesn't exist, nothing to delete
    }
    // Also clean up legacy root-level output file
    try {
      await fs.unlink(path.join(config.projectDir, cleanedFilename));
      console.log(`[LL-CLEANUP] Deleted legacy root-level ${cleanedFilename}`);
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  // Determine which EPUB to read from based on simplification mode and existence
  let readFromPath = sourceEpubPath;
  let workingOnCleaned = false;

  // Check if we should read from an existing cleaned/simplified version
  // Only use existing output if startFresh is false
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
  // Use block-level extraction to get actual chapter IDs, but exclude h1 from cleanup text
  // (h1 headings should pass through untouched — AI cleanup would rewrite titles into body text)
  let originalChapters: Array<{ id: string; title: string; text: string }>;
  let workingChapters: Array<{ id: string; title: string; text: string }>;
  let inputText: string;

  try {
    const { extractChaptersWithBlocks } = await import('./epub-processor.js');

    // Always load original chapters for diff comparison
    const originalResult = await extractChaptersWithBlocks(sourceEpubPath);
    if (originalResult.success && originalResult.chapters) {
      // Use bodyText (excludes h1) for cleanup — headings pass through untouched
      originalChapters = originalResult.chapters.map(ch => ({
        id: ch.chapterId,
        title: ch.heading || ch.chapterId,
        text: ch.bodyText
      }));
      console.log(`[LL-CLEANUP] Loaded ${originalChapters.length} original chapters for diff comparison`);
    } else {
      throw new Error(originalResult.error || 'Failed to extract chapters from source EPUB');
    }

    // Load working chapters (may be from cleaned if it exists)
    if (workingOnCleaned) {
      const workingResult = await extractChaptersWithBlocks(readFromPath);
      if (workingResult.success && workingResult.chapters) {
        workingChapters = workingResult.chapters.map(ch => ({
          id: ch.chapterId,
          title: ch.heading || ch.chapterId,
          text: ch.bodyText
        }));
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

    // If simplifying, use the full cleanupEpub function from ai-bridge for proper simplification
    // Otherwise use the lightweight cleanupText function
    if (config.simplifyForLearning) {
      console.log(`[LL-CLEANUP] Using full cleanupEpub for simplification`);

      // Import the proper cleanup function
      const { cleanupEpub } = await import('./ai-bridge.js');

      // Build provider config
      const providerConfig: any = {
        provider: config.aiProvider
      };

      if (config.aiProvider === 'ollama') {
        providerConfig.ollama = {
          baseUrl: config.ollamaBaseUrl || 'http://localhost:11434',
          model: config.aiModel
        };
      } else if (config.aiProvider === 'claude') {
        providerConfig.claude = {
          apiKey: config.claudeApiKey || '',
          model: config.aiModel
        };
      } else if (config.aiProvider === 'openai') {
        providerConfig.openai = {
          apiKey: config.openaiApiKey || '',
          model: config.aiModel
        };
      }

      // Call cleanupEpub with simplifyForChildren flag
      const cleanupResult = await cleanupEpub(
        readFromPath,
        jobId,
        mainWindow,
        (progress) => {
          sendProgress(mainWindow, jobId, {
            phase: 'cleanup',
            currentChunk: progress.chunksCompletedInJob || progress.currentChunk || 0,
            totalChunks: progress.totalChunks || 0,
            currentSentence: 0,
            totalSentences: 0,
            percentage: progress.percentage || 0,
            message: progress.message || 'Processing...'
          });
        },
        providerConfig,
        {
          simplifyForChildren: true,  // This enables the simplification logic
          enableAiCleanup: true,       // Also do cleanup
          outputDir: cleanupStageDir,  // Output to stages/01-cleanup/
          testMode: config.testMode,
          testModeChunks: config.testModeChunks,
          customInstructions: config.customInstructions
        }
      );

      if (!cleanupResult.success) {
        throw new Error(cleanupResult.error || 'Simplification failed');
      }

      console.log(`[LL-CLEANUP] Simplification complete: ${cleanupResult.outputPath}`);

      // Update manifest pipeline status for simplified.epub
      const { updateManifest } = await import('./manifest-service.js');
      const projectId = path.basename(config.projectDir);

      await updateManifest({
        projectId: projectId,
        modifiedAt: new Date().toISOString(),
        pipeline: {
          cleanup: {
            status: 'complete',
            outputPath: 'stages/01-cleanup/simplified.epub',
            completedAt: new Date().toISOString(),
            model: config.aiModel
          }
        }
      });

      // Analytics
      completeStage(analytics, 'cleanup', {
        inputChars: cleanupResult.outputPath ? 0 : 0,  // We don't have exact char counts from cleanupEpub
        outputChars: 0
      });
      await saveAnalytics(config.projectDir, analytics);

      return {
        success: true,
        outputPath: cleanupResult.outputPath,
        nextJobConfig: {
          cleanedEpubPath: cleanupResult.outputPath
        }
      };
    }

    // For standard cleanup (non-simplification), continue with existing logic
    console.log(`[LL-CLEANUP] Using standard cleanup (not simplification)`);

    // Choose prompt based on user selection
    let finalPrompt = config.cleanupPrompt || await loadPrompt(PROMPTS.TTS_CLEANUP);
    if (config.customInstructions) {
      finalPrompt += `\n\nADDITIONAL INSTRUCTIONS:\n${config.customInstructions}`;
      console.log(`[LL-CLEANUP] Appended custom instructions (${config.customInstructions.length} chars)`);
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

    // Set up incremental flush - diff cache and EPUB replacement
    const isIncrementalUpdate = workingOnCleaned;
    if (!isIncrementalUpdate) {
      await clearDiffCache(cleanedEpubPath);
    }
    await startDiffCache(cleanedEpubPath, sourceEpubPath);
    const { replaceChapterTextsInEpub } = await import('./epub-processor.js');
    const chapterReplacements: Array<{ chapterId: string; newText: string }> = [];

    // Clean each chapter individually to preserve structure
    const cleanedChapters: Array<{ title: string; sentences: string[] }> = [];
    const allSkippedChunks: SkippedChunk[] = [];

    // Pre-calculate exact chunk count for accurate progress
    const CLEANUP_CHUNK_SIZE = 2500; // From bilingual-processor.ts
    let totalChunksNeeded = 0;
    const chapterChunkCounts: number[] = [];

    for (const chapter of workingChapters) {
      // Calculate chunks for this chapter using the same logic as splitIntoCleanupChunks
      const paragraphs = chapter.text.split(/\n\n+/);
      let chunkCount = 0;
      let currentChunkLength = 0;

      for (const paragraph of paragraphs) {
        if (currentChunkLength + paragraph.length + 2 > CLEANUP_CHUNK_SIZE && currentChunkLength > 0) {
          chunkCount++;
          currentChunkLength = paragraph.length;
        } else {
          currentChunkLength += (currentChunkLength ? 2 : 0) + paragraph.length;
        }
      }

      if (currentChunkLength > 0) {
        chunkCount++; // Add the final chunk
      }

      chapterChunkCounts.push(chunkCount || 1); // At least 1 chunk per chapter
      totalChunksNeeded += chunkCount || 1;
    }

    // Use exact count, or test mode limit if applicable
    let dynamicTotalChunks = config.testMode && config.testModeChunks ?
      Math.min(config.testModeChunks, totalChunksNeeded) :
      totalChunksNeeded;

    console.log(`[LL-CLEANUP] Pre-calculated ${totalChunksNeeded} total chunks across ${workingChapters.length} chapters`);

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
      const cleanupResult = await cleanupText(
        chapter.text,
        chapterConfig,
        (progress) => {
          // Track chunks - cleanupText reports 1-based chunk numbers
          if (progress.currentChunk && progress.currentChunk > chunksProcessedInThisChapter) {
            const newChunks = progress.currentChunk - chunksProcessedInThisChapter;
            chunksProcessedInThisChapter = progress.currentChunk;
            totalChunksProcessedSoFar += newChunks;
          }

          // Calculate overall progress across all chapters
          const overallProgress = Math.round(
            ((totalChunksProcessedSoFar) / dynamicTotalChunks) * 100
          );

          sendProgress(mainWindow, jobId, {
            phase: 'cleanup',
            currentChunk: totalChunksProcessedSoFar,
            totalChunks: dynamicTotalChunks,
            currentSentence: 0,
            totalSentences: 0,
            percentage: overallProgress,
            message: `Cleaning chapter ${i + 1}/${workingChapters.length}: ${chapter.title}...`
          });
        },
        chapter.title // Pass chapter title for skipped chunks tracking
      );

      const cleanedChapterText = cleanupResult.cleanedText;

      // Collect any skipped chunks from this chapter
      if (cleanupResult.skippedChunks && cleanupResult.skippedChunks.length > 0) {
        allSkippedChunks.push(...cleanupResult.skippedChunks);
        console.log(`[LL-CLEANUP] Chapter ${i + 1} had ${cleanupResult.skippedChunks.length} skipped chunks`);
      }

      // Split cleaned chapter text into sentences/paragraphs
      const sentences = cleanedChapterText.split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

      cleanedChapters.push({
        title: chapter.title || `Chapter ${i + 1}`,
        sentences
      });

      // Incremental flush: update diff cache and EPUB after each chapter
      const chapterId = workingChapters[i]?.id || `chapter${i + 1}`;
      const newText = sentences.join('\n\n');
      chapterReplacements.push({ chapterId, newText });

      const originalChapter = originalChapters[i];
      if (originalChapter) {
        await addChapterDiff(chapterId, chapter.title || `Chapter ${i + 1}`, originalChapter.text, newText);
      }

      const replaceResult = await replaceChapterTextsInEpub(sourceEpubPath, cleanedEpubPath, chapterReplacements);
      if (!replaceResult.success) {
        throw new Error(`Failed to flush EPUB at chapter ${i + 1}: ${replaceResult.error}`);
      }

      console.log(`[LL-CLEANUP] Flushed chapter ${i + 1}/${workingChapters.length} to EPUB and diff cache`);

      // Log progress in test mode
      if (config.testMode && config.testModeChunks) {
        console.log(`[LL-CLEANUP] Processed ${chunksProcessedInThisChapter} chunks in chapter ${i + 1}, total so far: ${totalChunksProcessedSoFar}/${totalChunksToProcess}`);
      }
    }

    // Create combined cleaned text for analytics
    const cleanedText = cleanedChapters
      .map(ch => ch.sentences.join('\n\n'))
      .join('\n\n');

    console.log(`[LL-CLEANUP] Completed ${cleanedChapters.length} chapters (${cleanedText.length} chars), EPUB and diff cache flushed incrementally`);

    // Finalize the diff cache (marks it as completed)
    await finalizeDiffCache();

    // Save skipped chunks if any were found
    if (allSkippedChunks.length > 0) {
      const skippedChunksPath = path.join(cleanupStageDir, 'skipped-chunks.json');
      await fs.writeFile(skippedChunksPath, JSON.stringify(allSkippedChunks, null, 2), 'utf-8');
      console.log(`[LL-CLEANUP] Saved ${allSkippedChunks.length} skipped chunks to ${skippedChunksPath}`);
    }

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

      // Copy cleaned/simplified EPUB and diff cache to the project output folder
      // The studio's Review tab looks in the output folder for diff view data.
      // We write to stages/ as the canonical location, then copy to output/.
      try {
        const projectName = path.basename(config.projectDir);
        const projectsDir = path.resolve(config.projectDir, '..');
        const outputFolder = path.join(projectsDir, projectName, 'output');
        await fs.mkdir(outputFolder, { recursive: true });

        await fs.copyFile(cleanedEpubPath, path.join(outputFolder, cleanedFilename));
        const diffCachePath = cleanedEpubPath.replace('.epub', '.diff.json');
        const diffCacheTarget = cleanedFilename.replace('.epub', '.diff.json');
        try {
          await fs.copyFile(diffCachePath, path.join(outputFolder, diffCacheTarget));
        } catch {
          // Diff cache may not exist yet if job was interrupted
        }

        // Copy skipped chunks file if it exists
        if (allSkippedChunks.length > 0) {
          const skippedChunksSource = path.join(cleanupStageDir, 'skipped-chunks.json');
          const skippedChunksTarget = path.join(outputFolder, 'skipped-chunks.json');
          try {
            await fs.copyFile(skippedChunksSource, skippedChunksTarget);
          } catch (err) {
            console.warn(`[LL-CLEANUP] Failed to copy skipped chunks file:`, err);
          }
        }

        console.log(`[LL-CLEANUP] Copied cleaned files to output folder: ${outputFolder}`);
      } catch (err) {
        console.warn(`[LL-CLEANUP] Failed to copy to output folder:`, err);
      }
    } else {
      // Check if this is a unified manifest project or language learning article
      const manifestPath = path.join(config.projectDir, 'manifest.json');
      try {
        await fs.access(manifestPath);
        // This is a unified manifest project - update the manifest
        const { updateManifest } = await import('./manifest-service.js');

        // Extract project ID from the project directory path
        const projectId = path.basename(config.projectDir);

        await updateManifest({
          projectId: projectId,
          modifiedAt: new Date().toISOString(),
          pipeline: {
            cleanup: {
              status: 'complete',
              outputPath: path.relative(config.projectDir, cleanedEpubPath).replace(/\\/g, '/'),
              completedAt: new Date().toISOString(),
              model: config.aiModel
            }
          }
        });
        console.log(`[LL-CLEANUP] Updated manifest.json with cleanup stage`);
      } catch (err) {
        // No manifest - might be a language learning article with project.json
        try {
          const projectJsonPath = path.join(config.projectDir, 'project.json');
          await fs.access(projectJsonPath);

          // Update article project.json
          const { updateProject } = await import('./web-fetch-bridge.js');
          const projectPath = path.dirname(config.projectDir);
          const projectsPath = path.dirname(projectPath);
          const libraryRoot = path.resolve(projectsPath, '../..');
          await updateProject(config.projectId, {
            cleanedEpubPath: cleanedEpubPath,
            hasCleaned: true,
            modifiedAt: new Date().toISOString()
          }, libraryRoot);
          console.log(`[LL-CLEANUP] Updated project.json with cleanedEpubPath and hasCleaned flag`);
        } catch (updateErr) {
          console.log(`[LL-CLEANUP] No manifest.json or project.json found, skipping metadata update`);
        }
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
 * Reads from cleaned/simplified EPUB, saves to {sourceLang}.epub + {targetLang}.epub
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
      chapterId: string;      // Actual EPUB chapter ID
      title: string;          // Chapter title (for TOC/nav)
      sourceSentences: string[];       // ALL sentences including heading as first item
      translatedSentences: string[];   // ALL translated sentences, 1:1 with source
    }

    // Clean up stale outputs from previous runs before starting
    const staleTranslationDir = path.join(config.projectDir, 'stages', '02-translate');
    const staleFiles = [
      path.join(staleTranslationDir, `${config.targetLang}.epub`),
      path.join(staleTranslationDir, `${config.sourceLang}.epub`),
      path.join(staleTranslationDir, 'sentences', `${config.targetLang}.json`),
      path.join(staleTranslationDir, 'sentences', `${config.sourceLang}.json`),
      path.join(staleTranslationDir, `sentence_pairs_${config.targetLang}.json`),
    ];
    for (const filePath of staleFiles) {
      try {
        await fs.unlink(filePath);
        console.log(`[LL-TRANSLATION] Deleted stale output: ${path.basename(filePath)}`);
      } catch {
        // File doesn't exist, nothing to delete
      }
    }

    // Check for cached translation first
    const sentencesCacheDir = path.join(staleTranslationDir, 'sentences');
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
            chapterId: ch.chapterId || '',
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
            chapterId: '',
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
      // Extract chapters from the cleaned EPUB with block-level info (includes h1 headings)
      const { extractChaptersWithBlocks } = await import('./epub-processor.js');
      const extractResult = await extractChaptersWithBlocks(config.cleanedEpubPath);
      if (!extractResult.success || !extractResult.chapters) {
        throw new Error(extractResult.error || 'Failed to extract chapters from EPUB');
      }
      console.log(`[LL-TRANSLATION] Extracted ${extractResult.chapters.length} chapters from EPUB (with block info)`);

      // Phase 1: Split each chapter's body text into sentences (heading tracked separately)
      const granularity = config.splitGranularity || 'sentence';
      const granularityLabel = granularity === 'paragraph' ? 'paragraphs' : 'sentences';
      sendProgress(mainWindow, jobId, {
        phase: 'splitting',
        currentSentence: 0,
        totalSentences: 0,
        percentage: 5,
        message: `Splitting ${extractResult.chapters.length} chapters into ${granularityLabel}...`
      });

      // Flatten all text (including headings) into a flat sentence stream per chapter
      // Heading text becomes the first sentence — everything is 1:1 between source and target
      interface ChapterBoundary {
        chapterId: string;
        title: string;         // For TOC/nav display
        startIndex: number;    // Start in allSentences
        endIndex: number;      // End in allSentences
      }
      const chapterBoundaries: ChapterBoundary[] = [];
      const allSentences: string[] = [];

      for (const chapter of extractResult.chapters) {
        const chapterSentences: string[] = [];

        // Heading becomes the first sentence (if present)
        if (chapter.heading) {
          chapterSentences.push(chapter.heading);
        }

        // Body text split into remaining sentences
        const bodySentences = splitIntoSentences(chapter.bodyText, config.sourceLang, granularity);
        chapterSentences.push(...bodySentences);

        const start = allSentences.length;
        allSentences.push(...chapterSentences);

        chapterBoundaries.push({
          chapterId: chapter.chapterId,
          title: chapter.heading || chapter.chapterId,
          startIndex: start,
          endIndex: allSentences.length
        });
      }

      console.log(`[LL-TRANSLATION] Split into ${allSentences.length} ${granularityLabel} across ${chapterBoundaries.length} chapters`);

      // Phase 2: Translate chapter-by-chapter with incremental flush
      // Set up for incremental EPUB and sentence cache flush
      const flushTranslationDir = path.join(config.projectDir, 'stages', '02-translate');
      await fs.mkdir(flushTranslationDir, { recursive: true });
      const flushSourceEpubPath = path.join(flushTranslationDir, `${config.sourceLang}.epub`);
      const flushTargetEpubPath = path.join(flushTranslationDir, `${config.targetLang}.epub`);
      const flushSentencesDir = path.join(config.projectDir, 'sentences');
      await fs.mkdir(flushSentencesDir, { recursive: true });
      const { generateChapteredEpub: flushGenerateEpub } = await import('./bilingual-processor.js');
      const flushBookTitle = config.title || 'Book';

      // Test mode: track global sentence limit
      const totalSentenceLimit = (config.testMode && config.testModeChunks && config.testModeChunks > 0)
        ? config.testModeChunks : Infinity;
      let totalSentencesTranslated = 0;

      if (totalSentenceLimit < Infinity) {
        console.log(`[LL-TRANSLATION] Test mode: will translate up to ${totalSentenceLimit} sentences`);
      }

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

      const totalSentencesToProcess = Math.min(allSentences.length, totalSentenceLimit);
      console.log(`[LL-TRANSLATION] Translating ${totalSentencesToProcess} sentences across ${chapterBoundaries.length} chapters`);

      for (const boundary of chapterBoundaries) {
        if (totalSentencesTranslated >= totalSentenceLimit) break;

        let chapterSentences = allSentences.slice(boundary.startIndex, boundary.endIndex);
        if (chapterSentences.length === 0) continue;

        // Apply test mode limit for this chapter
        const remaining = totalSentenceLimit - totalSentencesTranslated;
        if (chapterSentences.length > remaining) {
          chapterSentences = chapterSentences.slice(0, remaining);
        }

        console.log(`[LL-TRANSLATION] Translating chapter "${boundary.title}": ${chapterSentences.length} sentences`);

        const chapterPairs = await translateSentences(chapterSentences, bilingualConfig, (progress) => {
          const overallSentences = totalSentencesTranslated + progress.currentSentence;
          const overallPercentage = 10 + Math.round((overallSentences / totalSentencesToProcess) * 60);
          sendProgress(mainWindow, jobId, {
            phase: 'translating',
            currentSentence: overallSentences,
            totalSentences: totalSentencesToProcess,
            percentage: overallPercentage,
            message: `Translating: ${overallSentences}/${totalSentencesToProcess} sentences (chapter "${boundary.title}")`
          });
        });

        totalSentencesTranslated += chapterPairs.length;

        chapters.push({
          chapterId: boundary.chapterId,
          title: boundary.title,
          sourceSentences: chapterPairs.map(p => p.source),
          translatedSentences: chapterPairs.map(p => p.target)
        });

        // Re-index pairs for global sequential ordering
        const baseIndex = pairs.length;
        pairs.push(...chapterPairs.map((p, j) => ({ ...p, index: baseIndex + j })));

        // Incremental flush: write EPUBs and sentence caches with all completed chapters
        const flushChapters = chapters.filter(ch =>
          ch.sourceSentences.length > 0 && ch.translatedSentences.length > 0
        );
        if (flushChapters.length > 0) {
          // Flush source and target EPUBs
          const sourceChaptersForFlush = flushChapters.map(ch => ({ title: ch.title, sentences: ch.sourceSentences }));
          const targetChaptersForFlush = flushChapters.map(ch => ({ title: ch.title, sentences: ch.translatedSentences }));
          await flushGenerateEpub(sourceChaptersForFlush, flushBookTitle, config.sourceLang, flushSourceEpubPath, { flattenHeadings: true });
          await flushGenerateEpub(targetChaptersForFlush, `${flushBookTitle} (${config.targetLang.toUpperCase()})`, config.targetLang, flushTargetEpubPath, { flattenHeadings: true });

          // Flush sentence caches
          const flushTotalSource = flushChapters.reduce((sum, ch) => sum + ch.sourceSentences.length, 0);
          const flushTotalTarget = flushChapters.reduce((sum, ch) => sum + ch.translatedSentences.length, 0);
          await fs.writeFile(
            path.join(flushSentencesDir, `${config.sourceLang}.json`),
            JSON.stringify({
              language: config.sourceLang,
              sourceLanguage: null,
              createdAt: new Date().toISOString(),
              sentenceCount: flushTotalSource,
              chapters: flushChapters.map(ch => ({
                chapterId: ch.chapterId,
                title: ch.title,
                sentences: ch.sourceSentences
              }))
            }, null, 2)
          );
          await fs.writeFile(
            path.join(flushSentencesDir, `${config.targetLang}.json`),
            JSON.stringify({
              language: config.targetLang,
              sourceLanguage: config.sourceLang,
              createdAt: new Date().toISOString(),
              sentenceCount: flushTotalTarget,
              chapters: flushChapters.map(ch => ({
                chapterId: ch.chapterId,
                title: ch.title,
                sentences: ch.sourceSentences.map((src, i) => ({
                  source: src,
                  target: ch.translatedSentences[i]
                }))
              }))
            }, null, 2)
          );

          console.log(`[LL-TRANSLATION] Flushed ${flushChapters.length} chapters to EPUBs and sentence caches`);
        }
      }

      console.log(`[LL-TRANSLATION] Translated ${pairs.length} pairs across ${chapters.length} chapters`);
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

    // Name EPUBs by language code (e.g., en.epub, de.epub) in the translation stage directory
    const translationDir = path.join(config.projectDir, 'stages', '02-translate');
    await fs.mkdir(translationDir, { recursive: true });
    const sourceEpubPath = path.join(translationDir, `${config.sourceLang}.epub`);
    const targetEpubPath = path.join(translationDir, `${config.targetLang}.epub`);

    // Prepare chapter data for EPUB generation
    // Filter out empty chapters AND ensure source/target have matching sentence counts per chapter
    const validChapters: Array<{
      chapterId: string;
      title: string;
      sourceSentences: string[];
      targetSentences: string[];
    }> = [];

    for (const ch of chapters) {
      // Filter out undefined/empty sentences from both arrays
      const sourceSentences = (ch.sourceSentences || []).filter((s): s is string => typeof s === 'string' && s.length > 0);
      const targetSentences = (ch.translatedSentences || []).filter((s): s is string => typeof s === 'string' && s.length > 0);

      // Only include chapter if both have sentences AND counts match
      if (sourceSentences.length > 0 && targetSentences.length > 0) {
        const minLen = Math.min(sourceSentences.length, targetSentences.length);
        if (sourceSentences.length !== targetSentences.length) {
          console.warn(`[LL-TRANSLATION] Chapter "${ch.title}" has mismatched counts: ${sourceSentences.length} source, ${targetSentences.length} target. Truncating to ${minLen}.`);
        }
        validChapters.push({
          chapterId: ch.chapterId,
          title: ch.title,
          sourceSentences: sourceSentences.slice(0, minLen),
          targetSentences: targetSentences.slice(0, minLen)
        });
      }
    }

    // Final validation: total sentence counts must match
    const totalSourceSentences = validChapters.reduce((sum, ch) => sum + ch.sourceSentences.length, 0);
    const totalTargetSentences = validChapters.reduce((sum, ch) => sum + ch.targetSentences.length, 0);

    if (totalSourceSentences !== totalTargetSentences) {
      throw new Error(`Source/target sentence count mismatch: ${totalSourceSentences} vs ${totalTargetSentences}`);
    }

    console.log(`[LL-TRANSLATION] Validated ${validChapters.length} chapters with ${totalSourceSentences} sentences each`);

    // Generate new multi-chapter EPUBs with flat sentences (one <p> per sentence, no <h1>)
    const { generateChapteredEpub } = await import('./bilingual-processor.js');
    const bookTitle = config.title || 'Book';

    // Source EPUB (e.g., en.epub)
    const sourceChapters = validChapters.map(ch => ({
      title: ch.title,
      sentences: ch.sourceSentences
    }));
    await generateChapteredEpub(
      sourceChapters,
      bookTitle,
      config.sourceLang,
      sourceEpubPath,
      { flattenHeadings: true }
    );

    // Target EPUB (e.g., de.epub) — use translated first sentence as chapter title
    const targetChapters = validChapters.map(ch => ({
      title: ch.targetSentences[0] || ch.title,
      sentences: ch.targetSentences
    }));
    await generateChapteredEpub(
      targetChapters,
      `${bookTitle} (${config.targetLang.toUpperCase()})`,
      config.targetLang,
      targetEpubPath,
      { flattenHeadings: true }
    );

    console.log(`[LL-TRANSLATION] Generated ${config.sourceLang}.epub and ${config.targetLang}.epub with ${validChapters.length} chapters, ${totalSourceSentences} sentences each`);

    // Save sentence pairs for reference and assembly (flat format using validated data)
    const validatedPairs = validChapters.flatMap(ch =>
      ch.sourceSentences.map((src, i) => ({
        index: i,
        source: src,
        target: ch.targetSentences[i]
      }))
    );
    const pairsPath = path.join(translationDir, `sentence_pairs_${config.targetLang}.json`);
    await fs.writeFile(pairsPath, JSON.stringify(validatedPairs, null, 2));

    // Save to sentence cache for reuse (chaptered format)
    const sentencesDir = path.join(translationDir, 'sentences');
    await fs.mkdir(sentencesDir, { recursive: true });

    // Save source language cache
    const sourceCache = {
      language: config.sourceLang,
      sourceLanguage: null,
      createdAt: new Date().toISOString(),
      sentenceCount: totalSourceSentences,
      chapters: validChapters.map(ch => ({
        chapterId: ch.chapterId,
        title: ch.title,
        sentences: ch.sourceSentences
      }))
    };
    await fs.writeFile(
      path.join(sentencesDir, `${config.sourceLang}.json`),
      JSON.stringify(sourceCache, null, 2)
    );

    // Save target language cache (with source pairs for reference)
    const targetCache = {
      language: config.targetLang,
      sourceLanguage: config.sourceLang,
      createdAt: new Date().toISOString(),
      sentenceCount: totalTargetSentences,
      chapters: validChapters.map(ch => ({
        chapterId: ch.chapterId,
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
// Translates at PARAGRAPH level for natural, context-aware output.
// Preserves original EPUB structure (CSS, images, fonts, headings).
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

/** Max paragraphs per AI batch - increased for better context */
const MONO_BATCH_MAX_PARAGRAPHS = 10;
/** Max characters per AI batch (soft limit) - increased for better context */
const MONO_BATCH_MAX_CHARS = 5000;

/**
 * Validate translated text for common issues
 */
function validateTranslation(original: string, translated: string, index: number): void {
  // Check for sentences ending with hanging conjunctions
  if (translated.match(/\s+(and|or|but|for|nor|so|yet)\.\s*$/i)) {
    console.warn(`[MONO-TRANSLATION] Warning: Paragraph ${index} ends with hanging conjunction: "...${translated.slice(-20)}"`);
  }

  // Check for mid-sentence periods (lowercase after period not at paragraph end)
  const midSentencePeriod = translated.match(/\.\s+[a-z]/);
  if (midSentencePeriod && !translated.match(/\b(Mr|Mrs|Dr|Prof|St|vs|etc|e\.g|i\.e)\.\s+[a-z]/)) {
    console.warn(`[MONO-TRANSLATION] Warning: Paragraph ${index} may have incorrect period breaking sentence: "${midSentencePeriod[0]}"`);
  }

  // Check for misplaced commas
  if (translated.match(/,\s*,|\s+,\s+\w+,/)) {
    console.warn(`[MONO-TRANSLATION] Warning: Paragraph ${index} has unusual comma placement`);
  }

  // Check if translation is significantly shorter (might indicate missing content)
  if (translated.length < original.length * 0.5) {
    console.warn(`[MONO-TRANSLATION] Warning: Paragraph ${index} translation is unusually short (${translated.length} vs ${original.length} chars)`);
  }
}

/**
 * Translate a batch of paragraphs using <<<N>>> markers.
 * Returns an array of translated texts in the same order as the input.
 * Retries individual paragraphs that are missing from the AI response.
 */
async function translateParagraphBatch(
  paragraphs: string[],
  sourceLang: string,
  targetLang: string,
  config: MonoTranslationConfig,
  startIndex: number = 1
): Promise<string[]> {
  const sourceLanguage = LANGUAGE_NAMES[sourceLang] || sourceLang;
  const targetLanguage = LANGUAGE_NAMES[targetLang] || targetLang;

  const bilingualConfig: BilingualProcessingConfig = {
    projectId: '',
    sourceText: '',
    sourceLang,
    targetLang,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    claudeApiKey: config.claudeApiKey,
    openaiApiKey: config.openaiApiKey,
  };

  // Format paragraphs with <<<N>>> markers
  const formatted = formatNumberedParagraphs(paragraphs, startIndex);

  // Load the mono translation prompt if not provided
  let systemPrompt = config.translationPrompt;
  if (!systemPrompt) {
    systemPrompt = await loadPrompt(PROMPTS.MONO_TRANSLATION);
  }

  const prompt = `Translate the following paragraphs from ${sourceLanguage} to ${targetLanguage}.
Each paragraph is marked with <<<N>>>. Preserve these markers exactly.
Return ONLY the translated paragraphs with the same <<<N>>> markers. Do not add explanations.

${formatted}`;

  const response = await callAI(prompt, bilingualConfig, systemPrompt);

  // Parse the numbered response
  const { paragraphs: parsed } = parseNumberedParagraphs(response);
  const missing = validateNumberedParagraphs(parsed, paragraphs.length, startIndex);

  // Retry missing paragraphs individually
  for (const missingIdx of missing) {
    const originalIdx = missingIdx - startIndex;
    const originalText = paragraphs[originalIdx];
    console.log(`[MONO-TRANSLATION] Retrying missing paragraph ${missingIdx}: "${originalText.substring(0, 60)}..."`);

    const retryPrompt = `Translate the following paragraph from ${sourceLanguage} to ${targetLanguage}.
Return ONLY the translation, nothing else.

${originalText}`;

    const retryResponse = await callAI(retryPrompt, bilingualConfig, systemPrompt);
    parsed.set(missingIdx, retryResponse.trim());
  }

  // Assemble results in order
  const results: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const idx = startIndex + i;
    const translated = parsed.get(idx);
    if (translated && translated.length > 0) {
      // Validate the translation for common issues
      validateTranslation(paragraphs[i], translated, idx);
      results.push(translated);
    } else {
      // Last resort: use original text
      console.warn(`[MONO-TRANSLATION] Paragraph ${idx} still missing after retry, keeping original`);
      results.push(paragraphs[i]);
    }
  }

  return results;
}

/**
 * Split paragraphs into batches respecting size limits,
 * then translate each batch.
 */
async function translateAllParagraphs(
  paragraphs: string[],
  sourceLang: string,
  targetLang: string,
  config: MonoTranslationConfig,
  onProgress: (translated: number, total: number) => void
): Promise<string[]> {
  // Build batches
  const batches: { texts: string[]; startIndex: number }[] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;
  let globalIndex = 1; // <<<N>>> numbering starts at 1

  for (const para of paragraphs) {
    const wouldExceed = currentBatch.length >= MONO_BATCH_MAX_PARAGRAPHS ||
      (currentBatch.length > 0 && currentChars + para.length > MONO_BATCH_MAX_CHARS);

    if (wouldExceed) {
      batches.push({ texts: currentBatch, startIndex: globalIndex });
      globalIndex += currentBatch.length;
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(para);
    currentChars += para.length;
  }

  if (currentBatch.length > 0) {
    batches.push({ texts: currentBatch, startIndex: globalIndex });
  }

  console.log(`[MONO-TRANSLATION] ${paragraphs.length} paragraphs → ${batches.length} batches`);

  // Translate each batch
  const allTranslated: string[] = [];
  let translatedCount = 0;

  for (const batch of batches) {
    const translated = await translateParagraphBatch(
      batch.texts, sourceLang, targetLang, config, batch.startIndex
    );
    allTranslated.push(...translated);
    translatedCount += batch.texts.length;
    onProgress(translatedCount, paragraphs.length);
  }

  return allTranslated;
}

/**
 * Mono Translation - Translates entire book to target language.
 * Uses paragraph-level translation for natural, context-aware output.
 * Preserves original EPUB structure (CSS, images, fonts).
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

  // Determine project dir from the input path (walk up from source/ or stages/01-cleanup/)
  let projectDir = '';
  const inputDir = path.dirname(inputEpubPath);
  if (inputDir.includes(path.join('stages', '01-cleanup'))) {
    projectDir = path.resolve(inputDir, '..', '..');
  } else if (inputDir.endsWith('source') || inputDir.includes(path.join('source'))) {
    projectDir = path.dirname(inputDir);
  } else {
    projectDir = inputDir;
  }

  // Output path: stages/02-translate/translated.epub
  const translateDir = path.join(projectDir, 'stages', '02-translate');
  await fs.mkdir(translateDir, { recursive: true });
  const outputEpubPath = path.join(translateDir, 'translated.epub');

  try {
    // ── Step 1: Read EPUB structure ──────────────────────────────────────
    sendProgress(mainWindow, jobId, {
      phase: 'splitting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 5,
      message: 'Reading EPUB structure...'
    });

    const processor = new EpubProcessor();
    const structure = await processor.open(inputEpubPath);

    // Build chapter path map: ZIP entry path → chapter info
    const chapterPaths = new Map<string, typeof structure.chapters[0]>();
    for (const ch of structure.chapters) {
      const zipPath = processor.resolvePath(ch.href);
      chapterPaths.set(zipPath, ch);
    }

    console.log(`[MONO-TRANSLATION] EPUB has ${structure.chapters.length} chapters`);

    // ── Step 2: Extract paragraphs from each chapter ────────────────────
    const zipReader = new ZipReader(inputEpubPath);
    await zipReader.open();

    interface ChapterData {
      zipPath: string;
      xhtml: string;
      paragraphs: string[];
    }
    const chapterDataList: ChapterData[] = [];
    let totalParagraphs = 0;

    for (const [zipPath] of chapterPaths) {
      const buffer = await zipReader.readEntry(zipPath);
      const xhtml = buffer.toString('utf8');
      const paragraphs = extractBlockTexts(xhtml);

      if (paragraphs.length > 0) {
        chapterDataList.push({ zipPath, xhtml, paragraphs });
        totalParagraphs += paragraphs.length;
      }
    }

    console.log(`[MONO-TRANSLATION] ${totalParagraphs} paragraphs across ${chapterDataList.length} chapters`);

    sendProgress(mainWindow, jobId, {
      phase: 'translating',
      currentSentence: 0,
      totalSentences: totalParagraphs,
      percentage: 10,
      message: `Translating ${totalParagraphs} paragraphs...`
    });

    // ── Step 3: Translate paragraphs chapter by chapter ─────────────────
    const translatedChapterXhtml = new Map<string, string>();
    let paragraphsDone = 0;

    for (const chData of chapterDataList) {
      const chapterInfo = chapterPaths.get(chData.zipPath);
      const chapterTitle = chapterInfo?.title || chData.zipPath;
      console.log(`[MONO-TRANSLATION] Translating chapter: ${chapterTitle} (${chData.paragraphs.length} paragraphs)`);

      const translated = await translateAllParagraphs(
        chData.paragraphs,
        config.sourceLang,
        config.targetLang,
        config,
        (done, total) => {
          const chapterDone = paragraphsDone + done;
          // Map to 10-90% range
          const pct = 10 + Math.round((chapterDone / totalParagraphs) * 80);
          sendProgress(mainWindow, jobId, {
            phase: 'translating',
            currentSentence: chapterDone,
            totalSentences: totalParagraphs,
            percentage: Math.min(pct, 90),
            message: `Translating: ${chapterDone}/${totalParagraphs} paragraphs`
          });
        }
      );

      paragraphsDone += chData.paragraphs.length;

      // Replace block texts in original XHTML (preserves structure, CSS, etc.)
      let modifiedXhtml = replaceBlockTexts(chData.xhtml, translated);

      // Update xml:lang on translated chapters
      const $ = cheerio.load(modifiedXhtml, { xmlMode: true });
      $('html').attr('xml:lang', config.targetLang);
      $('html').attr('lang', config.targetLang);
      modifiedXhtml = $.xml();

      translatedChapterXhtml.set(chData.zipPath, modifiedXhtml);
    }

    // ── Step 4: Write new EPUB ──────────────────────────────────────────
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: totalParagraphs,
      totalSentences: totalParagraphs,
      percentage: 95,
      message: 'Writing translated EPUB...'
    });

    const zipWriter = new ZipWriter();
    const allEntries = zipReader.getEntries();

    for (const file of allEntries) {
      if (translatedChapterXhtml.has(file)) {
        zipWriter.addFile(file, Buffer.from(translatedChapterXhtml.get(file)!, 'utf8'));
      } else {
        const content = await zipReader.readEntry(file);
        zipWriter.addFile(file, content);
      }
    }

    zipReader.close();
    processor.close();

    // Write via temp file for atomic operation
    const tempPath = outputEpubPath + '.tmp';
    await zipWriter.write(tempPath);
    await fs.rename(tempPath, outputEpubPath);

    console.log(`[MONO-TRANSLATION] Generated translated EPUB: ${outputEpubPath}`);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: totalParagraphs,
      totalSentences: totalParagraphs,
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

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
  projectId: string;
  projectDir: string;
  cleanedEpubPath: string;  // Path to cleaned.epub (output from cleanup job)
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
    // The marker is only needed for TTS EPUBs (source.epub, target.epub)
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
 * Reads from cleaned.epub, saves to source.epub + target.epub
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

  // Load analytics
  const analytics = await loadAnalytics(config.projectDir, config.projectId, config.title || 'Project');
  startStage(analytics, 'translation');
  await saveAnalytics(config.projectDir, analytics);

  try {
    // Read cleaned text from the cleaned EPUB
    const { extractTextFromEpub } = await import('./epub-processor.js');
    const extractResult = await extractTextFromEpub(config.cleanedEpubPath);
    if (!extractResult.success || !extractResult.text) {
      throw new Error(extractResult.error || 'Failed to extract text from cleaned.epub');
    }
    const cleanedText = extractResult.text;
    console.log(`[LL-TRANSLATION] Loaded cleaned text from EPUB: ${cleanedText.length} chars`);

    // Phase 1: Split into sentences (respecting user's granularity preference)
    const granularity = config.splitGranularity || 'sentence';
    const granularityLabel = granularity === 'paragraph' ? 'paragraphs' : 'sentences';
    sendProgress(mainWindow, jobId, {
      phase: 'splitting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 5,
      message: `Splitting text into ${granularityLabel}...`
    });

    const sentences = splitIntoSentences(cleanedText, config.sourceLang, granularity);
    console.log(`[LL-TRANSLATION] Split into ${sentences.length} ${granularityLabel} (granularity=${granularity})`);

    // Phase 2: Translate
    const bilingualConfig: BilingualProcessingConfig = {
      projectId: config.projectId,
      sourceText: cleanedText,
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      aiProvider: config.aiProvider,
      aiModel: config.aiModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      claudeApiKey: config.claudeApiKey,
      openaiApiKey: config.openaiApiKey,
      translationPrompt: config.translationPrompt
    };

    let pairs = await translateSentences(sentences, bilingualConfig, (progress) => {
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

    // Phase 4: Generate source.epub and target.epub for TTS
    // Each EPUB has one paragraph per sentence for proper alignment
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 85,
      message: 'Generating EPUBs for TTS...'
    });

    // Extract sentences and generate separate EPUBs
    // No need to filter - pairs contain only real sentences (bookforge marker is not in sentence_pairs)
    // generateMonolingualEpub will add the bookforge marker for TTS
    const sourceSentences = pairs.map((p: any) => p.source);
    const targetSentences = pairs.map((p: any) => p.target);
    const sourceEpubPath = path.join(config.projectDir, 'source.epub');
    const targetEpubPath = path.join(config.projectDir, 'target.epub');
    const { generateMonolingualEpub } = await import('./bilingual-processor.js');

    // Generate source.epub (one paragraph per source sentence)
    // Don't add bookforge marker - audio files will be numbered 0, 1, 2... matching sentence pairs
    await generateMonolingualEpub(
      sourceSentences,
      `${config.title || 'Article'} (${config.sourceLang})`,
      config.sourceLang,
      sourceEpubPath,
      { includeBookforgeMarker: false }
    );

    // Generate target.epub (one paragraph per target sentence)
    await generateMonolingualEpub(
      targetSentences,
      `${config.title || 'Article'} (${config.targetLang})`,
      config.targetLang,
      targetEpubPath,
      { includeBookforgeMarker: false }
    );

    console.log(`[LL-TRANSLATION] Generated source.epub and target.epub`);

    // Save sentence pairs for reference and assembly
    const pairsPath = path.join(config.projectDir, 'sentence_pairs.json');
    await fs.writeFile(pairsPath, JSON.stringify(pairs, null, 2));

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
        sourceEpubPath,   // source.epub - one paragraph per source sentence
        targetEpubPath,   // target.epub - one paragraph per target sentence
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

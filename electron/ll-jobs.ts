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
  inputText: string;
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
  cleanedTextPath: string;
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
    cleanedTextPath?: string;     // From cleanup -> translation
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
 * Saves cleaned text to projectDir/cleaned.txt
 */
export async function runLLCleanup(
  jobId: string,
  config: LLCleanupConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-CLEANUP] Starting job ${jobId}`);
  console.log(`[LL-CLEANUP] Config:`, {
    projectId: config.projectId,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    textLength: config.inputText.length
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
      sourceText: config.inputText,
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
    const cleanedText = await cleanupText(config.inputText, bilingualConfig, (progress) => {
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

    // Save cleaned text
    const cleanedTextPath = path.join(config.projectDir, 'cleaned.txt');
    await fs.writeFile(cleanedTextPath, cleanedText, 'utf-8');
    console.log(`[LL-CLEANUP] Saved cleaned text to ${cleanedTextPath} (${cleanedText.length} chars)`);

    // Update analytics
    completeStage(analytics, 'cleanup', {
      inputChars: config.inputText.length,
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
      outputPath: cleanedTextPath,
      nextJobConfig: {
        cleanedTextPath
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
 * Reads from cleanedTextPath, saves to projectDir/bilingual.epub
 */
export async function runLLTranslation(
  jobId: string,
  config: LLTranslationConfig,
  mainWindow: BrowserWindow | null
): Promise<LLJobResult> {
  console.log(`[LL-TRANSLATION] Starting job ${jobId}`);
  console.log(`[LL-TRANSLATION] Config:`, {
    projectId: config.projectId,
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
    // Read cleaned text
    const cleanedText = await fs.readFile(config.cleanedTextPath, 'utf-8');
    console.log(`[LL-TRANSLATION] Loaded cleaned text: ${cleanedText.length} chars`);

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

    // Phase 4: Generate SEPARATE source/target EPUBs for dual-voice TTS
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 85,
      message: 'Generating source/target EPUBs...'
    });

    const { sourceEpubPath, targetEpubPath } = await generateSeparateEpubs(
      pairs,
      config.title || 'Bilingual Article',
      config.sourceLang,
      config.targetLang,
      config.projectDir
    );

    console.log(`[LL-TRANSLATION] Generated source EPUB at ${sourceEpubPath}`);
    console.log(`[LL-TRANSLATION] Generated target EPUB at ${targetEpubPath}`);

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
      message: 'Translation complete - EPUBs ready for dual-voice TTS'
    });

    return {
      success: true,
      outputPath: sourceEpubPath,  // Primary output for backwards compatibility
      nextJobConfig: {
        sourceEpubPath,
        targetEpubPath,
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

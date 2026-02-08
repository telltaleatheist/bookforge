/**
 * Language Learning Jobs - Multi-stage pipeline orchestration
 *
 * Orchestrates the full language learning audiobook generation pipeline:
 * 1. Extract text from HTML (filtering deleted blocks)
 * 2. AI cleanup (optional) - fixes OCR, formatting
 * 3. Split into sentences
 * 4. AI translation (sentence by sentence)
 * 5. Validate sentence alignment (popup if mismatch)
 * 6. Generate SEPARATE source/target EPUBs
 * 7. Dual-voice TTS (source language + target language)
 * 8. Bilingual assembly (interleave audio with pauses)
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  splitIntoSentences,
  translateSentences,
  generateSeparateEpubs,
  cleanupText,
  SentencePair,
  BilingualProcessingConfig,
  ProcessingProgress
} from './bilingual-processor.js';
import { extractTextFromHtml } from './web-fetch-bridge.js';
import { validateAndAlignSentences } from './sentence-alignment-window.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LanguageLearningJobConfig {
  projectId: string;
  sourceUrl: string;
  sourceLang: string;
  targetLang: string;
  htmlPath: string;
  pdfPath?: string;
  deletedBlockIds: string[];
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  // AI prompt settings
  translationPrompt?: string;
  enableCleanup?: boolean;
  cleanupPrompt?: string;
  // TTS settings
  sourceVoice: string;
  targetVoice: string;
  ttsEngine: 'xtts' | 'orpheus';
  speed: number;
  device: 'gpu' | 'mps' | 'cpu';
  workerCount?: number;
  title?: string;
  // Alignment verification settings
  autoAcceptResults?: boolean;  // Auto-continue to TTS if sentences match (still shows preview)
}

export interface TtsJobConfig {
  epubPath: string;
  outputDir: string;
  outputFilename: string;
  title: string;
  ttsEngine: 'xtts' | 'orpheus';
  voice: string;
  device: 'gpu' | 'mps' | 'cpu';
  speed: number;
  workerCount: number;
  language: string;
}

export interface LanguageLearningJobResult {
  success: boolean;
  data?: {
    // Old single-EPUB flow (deprecated)
    epubPath?: string;
    sentencePairsPath?: string;
    // New dual-EPUB flow for proper accent separation
    sourceEpubPath?: string;
    targetEpubPath?: string;
    // TTS configs for chaining - queue service will start TTS jobs
    // For dual-voice: run sourceTtsConfig first, then targetTtsConfig
    sourceTtsConfig?: TtsJobConfig;
    targetTtsConfig?: TtsJobConfig;
    // Legacy single config (deprecated)
    ttsConfig?: {
      outputDir: string;
      outputFilename: string;
      title: string;
      ttsEngine: 'xtts' | 'orpheus';
      voice: string;
      device: 'gpu' | 'mps' | 'cpu';
      speed: number;
      workerCount: number;
      language: string;
    };
    // Bilingual assembly config
    bilingualAssemblyConfig?: {
      projectId: string;
      audiobooksDir: string;
      pauseDuration: number;
      gapDuration: number;
    };
  };
  error?: string;
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
    mainWindow.webContents.send('language-learning:progress', {
      jobId,
      progress
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Job Runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full language learning job pipeline
 */
export async function runLanguageLearningJob(
  jobId: string,
  config: LanguageLearningJobConfig,
  mainWindow: BrowserWindow | null
): Promise<LanguageLearningJobResult> {
  console.log(`[LANGUAGE-LEARNING] Starting job ${jobId}`);
  console.log(`[LANGUAGE-LEARNING] Config:`, {
    projectId: config.projectId,
    targetLang: config.targetLang,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    enableCleanup: config.enableCleanup,
    workerCount: config.workerCount,
    ttsEngine: config.ttsEngine,
    targetVoice: config.targetVoice
  });

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 1: Extract text from HTML (0-5%)
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[LANGUAGE-LEARNING] Phase 1: Extracting text...`);
    sendProgress(mainWindow, jobId, {
      phase: 'extracting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 0,
      message: 'Extracting text from article...'
    });

    const extractResult = await extractTextFromHtml(config.htmlPath, config.deletedBlockIds);
    if (!extractResult.success || !extractResult.text) {
      throw new Error(extractResult.error || 'Failed to extract text from HTML');
    }

    let sourceText = extractResult.text;
    console.log(`[LANGUAGE-LEARNING] Extracted ${sourceText.length} characters`);

    sendProgress(mainWindow, jobId, {
      phase: 'extracting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 5,
      message: `Extracted ${sourceText.length} characters`
    });

    // Build the bilingual config (shared across phases)
    const bilingualConfig: BilingualProcessingConfig = {
      projectId: config.projectId,
      sourceText,
      sourceLang: config.sourceLang,
      targetLang: config.targetLang,
      aiProvider: config.aiProvider,
      aiModel: config.aiModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      claudeApiKey: config.claudeApiKey,
      openaiApiKey: config.openaiApiKey,
      // AI prompt settings
      enableCleanup: config.enableCleanup,
      cleanupPrompt: config.cleanupPrompt,
      translationPrompt: config.translationPrompt,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2: AI Cleanup (5-20%) - if enabled
    // ─────────────────────────────────────────────────────────────────────────
    if (config.enableCleanup) {
      console.log(`[LANGUAGE-LEARNING] Phase 2: AI Cleanup...`);
      sendProgress(mainWindow, jobId, {
        phase: 'cleanup',
        currentSentence: 0,
        totalSentences: 0,
        currentChunk: 0,
        totalChunks: 0,
        percentage: 5,
        message: 'Starting AI cleanup...'
      });

      sourceText = await cleanupText(sourceText, bilingualConfig, (progress) => {
        // Map cleanup progress (0-100%) to overall job progress (5-20%)
        const overallPercentage = 5 + Math.round((progress.percentage / 100) * 15);
        sendProgress(mainWindow, jobId, {
          phase: 'cleanup',
          currentChunk: progress.currentChunk,
          totalChunks: progress.totalChunks,
          currentSentence: 0,
          totalSentences: 0,
          percentage: overallPercentage,
          message: `Cleaning chunk ${progress.currentChunk}/${progress.totalChunks}...`
        });
      });

      // Update the config with cleaned text
      bilingualConfig.sourceText = sourceText;
      console.log(`[LANGUAGE-LEARNING] Cleanup complete: ${sourceText.length} characters`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 3: Split into sentences (20%)
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[LANGUAGE-LEARNING] Phase 3: Splitting sentences...`);
    sendProgress(mainWindow, jobId, {
      phase: 'splitting',
      currentSentence: 0,
      totalSentences: 0,
      percentage: 20,
      message: 'Splitting text into sentences...'
    });

    const sentences = splitIntoSentences(sourceText, config.sourceLang);
    console.log(`[LANGUAGE-LEARNING] Split into ${sentences.length} sentences`);

    sendProgress(mainWindow, jobId, {
      phase: 'splitting',
      currentSentence: sentences.length,
      totalSentences: sentences.length,
      percentage: 22,
      message: `Split into ${sentences.length} sentences`
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4: Translate sentences (22-70%)
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[LANGUAGE-LEARNING] Phase 4: Translating...`);
    const pairs = await translateSentences(sentences, bilingualConfig, (progress) => {
      // Map translation progress (0-100%) to overall job progress (22-70%)
      const overallPercentage = 22 + Math.round((progress.percentage / 100) * 48);
      sendProgress(mainWindow, jobId, {
        phase: 'translating',
        currentSentence: progress.currentSentence,
        totalSentences: progress.totalSentences,
        percentage: overallPercentage,
        message: `Translating: ${progress.currentSentence}/${progress.totalSentences} sentences`
      });
    });

    console.log(`[LANGUAGE-LEARNING] Translated ${pairs.length} sentence pairs`);

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5: Validate sentence alignment (70%)
    // Shows popup for user to verify/fix alignment before TTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[LANGUAGE-LEARNING] Phase 5: Validating sentence alignment...`);
    sendProgress(mainWindow, jobId, {
      phase: 'validating',
      currentSentence: pairs.length,
      totalSentences: pairs.length,
      percentage: 70,
      message: 'Validating sentence alignment...'
    });

    let alignedPairs = pairs;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Use autoAcceptResults from config (default true for backwards compatibility)
      const autoApprove = config.autoAcceptResults !== false;
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

      alignedPairs = alignmentResult.pairs as SentencePair[];
      console.log(`[LANGUAGE-LEARNING] Alignment approved with ${alignedPairs.length} pairs`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6: Generate SEPARATE source/target EPUBs (70-75%)
    // This ensures each language uses the correct voice without accent bleeding
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[LANGUAGE-LEARNING] Phase 6: Generating separate EPUBs...`);
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: alignedPairs.length,
      totalSentences: alignedPairs.length,
      percentage: 75,
      message: 'Generating source/target EPUBs...'
    });

    // Determine output paths
    const projectDir = path.dirname(config.htmlPath);
    const title = config.title || 'Bilingual Article';

    // Generate separate EPUBs for dual-voice TTS
    const { sourceEpubPath, targetEpubPath } = await generateSeparateEpubs(
      alignedPairs,
      title,
      config.sourceLang,
      config.targetLang,
      projectDir,
      (progress) => {
        const overallPercentage = 75 + Math.round((progress.percentage / 100) * 5);
        sendProgress(mainWindow, jobId, {
          phase: 'epub',
          currentSentence: alignedPairs.length,
          totalSentences: alignedPairs.length,
          percentage: overallPercentage,
          message: progress.message
        });
      }
    );

    console.log(`[LANGUAGE-LEARNING] Generated source EPUB: ${sourceEpubPath}`);
    console.log(`[LANGUAGE-LEARNING] Generated target EPUB: ${targetEpubPath}`);

    // Save sentence pairs for reference and bilingual assembly
    const pairsPath = path.join(projectDir, 'sentence_pairs.json');
    await fs.writeFile(pairsPath, JSON.stringify(alignedPairs, null, 2));

    // Prepare the audiobooks output directory
    // Path structure: .../language-learning/projects/<projectId>/
    // We want: .../language-learning/audiobooks/
    const projectsDir = path.dirname(projectDir);           // .../language-learning/projects
    const languageLearningDir = path.dirname(projectsDir);  // .../language-learning
    const audiobooksDir = path.join(languageLearningDir, 'audiobooks');
    await fs.mkdir(audiobooksDir, { recursive: true });

    // Calculate worker count for TTS config
    const workerCount = config.ttsEngine === 'orpheus' ? 1 : (config.workerCount || 4);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: alignedPairs.length,
      totalSentences: alignedPairs.length,
      percentage: 100,
      message: 'EPUBs ready - starting dual-voice TTS...'
    });

    console.log(`[LANGUAGE-LEARNING] Job ${jobId} completed - EPUBs ready for dual-voice TTS`);

    // Return success with DUAL TTS configs for proper accent separation
    // The queue service will:
    // 1. Run source TTS (English voice)
    // 2. Run target TTS (German voice)
    // 3. Run bilingual assembly to combine with pauses/gaps
    return {
      success: true,
      data: {
        sourceEpubPath,
        targetEpubPath,
        sentencePairsPath: pairsPath,
        // Source language TTS config
        sourceTtsConfig: {
          epubPath: sourceEpubPath,
          outputDir: audiobooksDir,
          outputFilename: `${config.projectId}_source.m4b`,
          title: `${title} (Source)`,
          ttsEngine: config.ttsEngine,
          voice: config.sourceVoice,
          device: config.device || 'mps',
          speed: config.speed,
          workerCount,
          language: config.sourceLang
        },
        // Target language TTS config
        targetTtsConfig: {
          epubPath: targetEpubPath,
          outputDir: audiobooksDir,
          outputFilename: `${config.projectId}_target.m4b`,
          title: `${title} (Target)`,
          ttsEngine: config.ttsEngine,
          voice: config.targetVoice,
          device: config.device || 'mps',
          speed: config.speed,
          workerCount,
          language: config.targetLang
        },
        // Bilingual assembly config - run after both TTS jobs complete
        bilingualAssemblyConfig: {
          projectId: config.projectId,
          audiobooksDir,
          pauseDuration: 0.3,
          gapDuration: 1.0
        }
      }
    };

  } catch (err) {
    console.error(`[LANGUAGE-LEARNING] Job ${jobId} failed:`, err);

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

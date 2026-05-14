/**
 * Book Analysis Engine
 *
 * Analyzes book content for rhetorical manipulation, propaganda techniques,
 * and problematic patterns. Iterates EPUB chapters, sends chunks to AI,
 * and produces a structured analysis report.
 *
 * Follows the cleanupEpub() pattern from ai-bridge.ts for progress reporting,
 * checkpoint/resume, and cancellation.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import { extractChaptersFromEpub, type ChapterData } from './epub-processor.js';
import { findBestBreakPoint, estimateNumCtx } from './ai-bridge.js';
import type { AIProviderConfig } from './ai-bridge.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalysisCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  enabled: boolean;
}

export interface AnalysisFlag {
  categoryId: string;
  quote: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  chapterId: string;
  chapterTitle: string;
}

export interface AnalysisReport {
  version: 1;
  epubPath: string;
  analyzedAt: string;
  categories: AnalysisCategory[];
  flags: AnalysisFlag[];
  chapterSummaries: Array<{
    chapterId: string;
    title: string;
    summary: string;
    flagCount: number;
  }>;
  statistics: {
    totalFlags: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

export interface AnalysisResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  flagCount?: number;
  analytics?: AnalysisAnalytics;
}

interface AnalysisAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalChapters: number;
  totalChunks: number;
  flagsFound: number;
  model: string;
}

interface AnalysisCheckpoint {
  version: number;
  sourceEpubPath: string;
  totalChapters: number;
  completedChapters: string[];
  completedChunkCount: number;
  flags: AnalysisFlag[];
  chapterSummaries: Array<{
    chapterId: string;
    title: string;
    summary: string;
    flagCount: number;
  }>;
  provider: string;
  model: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 6000;
const CHUNK_SEARCH_WINDOW = 1000;
const PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'book-analysis.txt');

// Active analysis jobs for cancellation
const activeAnalysisJobs = new Map<string, AbortController>();

// ─────────────────────────────────────────────────────────────────────────────
// Default Categories
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ANALYSIS_CATEGORIES: AnalysisCategory[] = [
  { id: 'thought_control', name: 'Thought Control', color: '#E53935', enabled: true, description: 'Discouraging critical thinking, independent thought, or questioning authority; demanding blind obedience' },
  { id: 'information_control', name: 'Information Control', color: '#1565C0', enabled: true, description: 'Discouraging outside sources; labeling criticism as persecution; controlling what members read/watch' },
  { id: 'us_vs_them', name: 'Us vs. Them', color: '#FB8C00', enabled: true, description: 'In-group/out-group divisions; dehumanizing outsiders; framing the world as hostile' },
  { id: 'fear_manipulation', name: 'Fear & Doom', color: '#7B1FA2', enabled: true, description: 'Apocalyptic fearmongering; divine punishment threats; urgency through fear' },
  { id: 'loaded_language', name: 'Loaded Language', color: '#00838F', enabled: true, description: 'Thought-terminating cliches; euphemisms masking harmful practices; jargon replacing critical thinking' },
  { id: 'emotional_manipulation', name: 'Emotional Manipulation', color: '#C62828', enabled: true, description: 'Guilt-tripping; love-bombing; shaming; exploiting grief or vulnerability' },
  { id: 'authority_claims', name: 'Authority Claims', color: '#4527A0', enabled: true, description: 'Claiming divine mandate; unquestionable leadership; special revelation' },
  { id: 'historical_revisionism', name: 'Historical Revisionism', color: '#2E7D32', enabled: true, description: 'Rewriting history; false narratives; cherry-picking facts; pseudohistory' },
  { id: 'scapegoating', name: 'Scapegoating', color: '#D84315', enabled: true, description: 'Blaming specific groups; conspiracy theories about minorities; racial/ethnic targeting' },
  { id: 'violence_glorification', name: 'Violence & Extremism', color: '#B71C1C', enabled: true, description: 'Justifying violence; martyrdom ideology; eliminationist rhetoric' },
  { id: 'false_prophecy', name: 'False Prophecy', color: '#8E24AA', enabled: true, description: 'Failed predictions presented as divine truth; date-setting; unfalsifiable claims' },
  { id: 'shunning', name: 'Shunning & Isolation', color: '#6D4C41', enabled: true, description: 'Social isolation tactics; cutting off family/friends; punishment for leaving' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

export function cancelAnalysisJob(jobId: string): boolean {
  const controller = activeAnalysisJobs.get(jobId);
  if (controller) {
    controller.abort();
    activeAnalysisJobs.delete(jobId);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Building
// ─────────────────────────────────────────────────────────────────────────────

async function loadAnalysisPrompt(): Promise<string> {
  const content = await fs.readFile(PROMPT_FILE_PATH, 'utf-8');
  return content.trim();
}

function buildPromptForChunk(
  template: string,
  categories: AnalysisCategory[],
  text: string
): string {
  const categoryBlock = categories
    .filter(c => c.enabled)
    .map(c => `- ${c.id}: "${c.name}" — ${c.description}`)
    .join('\n');

  return template
    .replace('{categories}', categoryBlock)
    .replace('{text}', text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseAnalysisResponse(
  response: string,
  chapterId: string,
  chapterTitle: string,
  validCategoryIds: Set<string>
): AnalysisFlag[] {
  // Strip markdown fencing if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // Handle empty results
  if (cleaned === '[]' || !cleaned) {
    return [];
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON array from response
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        console.warn(`[Analysis] Failed to parse AI response for chapter ${chapterId}`);
        return [];
      }
    } else {
      console.warn(`[Analysis] No JSON array found in AI response for chapter ${chapterId}`);
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    console.warn(`[Analysis] Response is not an array for chapter ${chapterId}`);
    return [];
  }

  const flags: AnalysisFlag[] = [];
  for (const item of parsed) {
    if (!item.categoryId || !item.quote || !item.description || !item.severity) {
      continue;
    }
    if (!validCategoryIds.has(item.categoryId)) {
      console.warn(`[Analysis] Unknown category "${item.categoryId}" — skipping flag`);
      continue;
    }
    if (!['low', 'medium', 'high'].includes(item.severity)) {
      continue;
    }
    flags.push({
      categoryId: item.categoryId,
      quote: item.quote,
      description: item.description,
      severity: item.severity,
      chapterId,
      chapterTitle,
    });
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (start + CHUNK_SIZE >= text.length) {
      chunks.push(text.substring(start));
      break;
    }
    const breakPoint = findBestBreakPoint(text, start + CHUNK_SIZE, start);
    chunks.push(text.substring(start, breakPoint));
    start = breakPoint;
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Provider Communication (analysis-specific — no truncation detection)
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = 'http://localhost:11434';
const TIMEOUT_MS = 180000; // 3 minutes per chunk

/**
 * Send a chunk to the configured AI provider and return the raw response text.
 * Unlike cleanChunkWithProvider, this does NOT do truncation detection, splitting,
 * or "use original text" fallbacks — analysis returns a small JSON array, not
 * the full input text back.
 */
async function analyzeChunkWithProvider(
  prompt: string,
  systemPrompt: string,
  config: AIProviderConfig,
  abortSignal?: AbortSignal
): Promise<string> {
  switch (config.provider) {
    case 'ollama':
      if (!config.ollama?.model) throw new Error('Ollama model not configured');
      return analyzeChunkOllama(prompt, systemPrompt, config.ollama.model, config.ollama.baseUrl, abortSignal);
    case 'claude':
      if (!config.claude?.apiKey) throw new Error('Claude API key not configured');
      if (!config.claude?.model) throw new Error('Claude model not configured');
      return analyzeChunkClaude(prompt, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal);
    case 'openai':
      if (!config.openai?.apiKey) throw new Error('OpenAI API key not configured');
      if (!config.openai?.model) throw new Error('OpenAI model not configured');
      return analyzeChunkOpenAI(prompt, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

async function analyzeChunkOllama(
  prompt: string,
  systemPrompt: string,
  model: string,
  baseUrl?: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const response = await fetch(`${baseUrl || OLLAMA_BASE_URL}/api/generate`, {
    signal: controller.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: 0.1,
        // Analysis response is small JSON — allow generous output but don't need input*2
        num_predict: 4096,
        num_ctx: estimateNumCtx(systemPrompt, prompt, 0.5),
      },
      keep_alive: '5m',
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.response || '[]';
}

async function analyzeChunkClaude(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Claude API error: ${response.status} - ${(errorData as any).error?.message || response.statusText}`);
    }

    const data = await response.json();
    return (data as any).content?.[0]?.text || '[]';
  } finally {
    clearTimeout(timeoutId);
  }
}

async function analyzeChunkOpenAI(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${response.status} - ${(errorData as any).error?.message || response.statusText}`);
    }

    const data = await response.json();
    return (data as any).choices?.[0]?.message?.content || '[]';
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint
// ─────────────────────────────────────────────────────────────────────────────

function getCheckpointPath(outputDir: string): string {
  return path.join(outputDir, 'analysis-progress.json');
}

async function loadCheckpoint(
  outputDir: string,
  epubPath: string,
  provider: string,
  model: string
): Promise<AnalysisCheckpoint | null> {
  const checkpointPath = getCheckpointPath(outputDir);
  try {
    const raw = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint: AnalysisCheckpoint = JSON.parse(raw);

    // Validate config hasn't changed
    if (
      checkpoint.sourceEpubPath !== epubPath ||
      checkpoint.provider !== provider ||
      checkpoint.model !== model
    ) {
      console.log('[Analysis] Checkpoint config mismatch — starting fresh');
      return null;
    }

    return checkpoint;
  } catch {
    return null;
  }
}

async function saveCheckpoint(
  outputDir: string,
  checkpoint: AnalysisCheckpoint
): Promise<void> {
  const checkpointPath = getCheckpointPath(outputDir);
  const tmpPath = checkpointPath + '.tmp';
  checkpoint.updatedAt = new Date().toISOString();
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  await fs.rename(tmpPath, checkpointPath);
}

async function deleteCheckpoint(outputDir: string): Promise<void> {
  try {
    await fs.unlink(getCheckpointPath(outputDir));
  } catch {
    // Ignore if already deleted
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Analysis Function
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeBook(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  providerConfig: AIProviderConfig,
  options: {
    categories: AnalysisCategory[];
    testMode?: boolean;
    testModeChunks?: number;
    outputDir?: string;
  }
): Promise<AnalysisResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Resolve output directory
  const outputDir = options.outputDir || path.join(path.dirname(epubPath), 'stages', '04-analysis');
  await fs.mkdir(outputDir, { recursive: true });

  // Register abort controller
  const abortController = new AbortController();
  activeAnalysisJobs.set(jobId, abortController);

  // Prevent system sleep
  const powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');

  // Get model name for logging
  const model = providerConfig.ollama?.model
    || providerConfig.claude?.model
    || providerConfig.openai?.model
    || 'unknown';

  const sendProgress = (data: {
    phase: string;
    progress: number;
    message?: string;
    currentChunk?: number;
    totalChunks?: number;
    currentChapter?: number;
    totalChapters?: number;
  }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'book-analysis',
        ...data,
      });
    }
  };

  try {
    // Load prompt template
    sendProgress({ phase: 'loading', progress: 0, message: 'Loading analysis prompt...' });
    const promptTemplate = await loadAnalysisPrompt();

    // Filter to enabled categories
    const enabledCategories = options.categories.filter(c => c.enabled);
    if (enabledCategories.length === 0) {
      throw new Error('No analysis categories enabled');
    }
    const validCategoryIds = new Set(enabledCategories.map(c => c.id));

    // Extract chapters from EPUB
    sendProgress({ phase: 'loading', progress: 5, message: 'Extracting chapters from EPUB...' });
    const extractResult = await extractChaptersFromEpub(epubPath);
    if (!extractResult.success || !extractResult.chapters) {
      throw new Error(extractResult.error || 'Failed to extract chapters from EPUB');
    }

    const chapters = extractResult.chapters;
    console.log(`[Analysis] Extracted ${chapters.length} chapters from EPUB`);

    // Pre-scan: chunk all chapters and count total work
    const chapterChunks: Array<{ chapter: ChapterData; chunks: string[] }> = [];
    let totalChunks = 0;
    for (const chapter of chapters) {
      const chunks = chunkText(chapter.text);
      chapterChunks.push({ chapter, chunks });
      totalChunks += chunks.length;
    }
    console.log(`[Analysis] Total chunks to analyze: ${totalChunks}`);

    // Apply test mode limit
    let chunksToProcess = totalChunks;
    if (options.testMode && options.testModeChunks) {
      chunksToProcess = Math.min(totalChunks, options.testModeChunks);
      console.log(`[Analysis] Test mode: limiting to ${chunksToProcess} chunks`);
    }

    // Load checkpoint (skip in test mode)
    let checkpoint: AnalysisCheckpoint | null = null;
    let allFlags: AnalysisFlag[] = [];
    let chapterSummaries: Array<{ chapterId: string; title: string; summary: string; flagCount: number }> = [];
    let completedChapterIds = new Set<string>();
    let overallChunkIndex = 0;

    if (!options.testMode) {
      checkpoint = await loadCheckpoint(outputDir, epubPath, providerConfig.provider, model);
      if (checkpoint) {
        allFlags = checkpoint.flags;
        chapterSummaries = checkpoint.chapterSummaries;
        completedChapterIds = new Set(checkpoint.completedChapters);
        overallChunkIndex = checkpoint.completedChunkCount;
        console.log(`[Analysis] Resuming from checkpoint: ${completedChapterIds.size} chapters, ${overallChunkIndex} chunks done`);
      }
    }

    // Process chapters
    let chunksProcessed = overallChunkIndex;

    for (const { chapter, chunks } of chapterChunks) {
      // Check if we've hit the test mode limit
      if (options.testMode && chunksProcessed >= chunksToProcess) {
        break;
      }

      // Skip completed chapters (checkpoint resume)
      if (completedChapterIds.has(chapter.id)) {
        continue;
      }

      // Check for cancellation
      if (abortController.signal.aborted) {
        throw new Error('Job cancelled');
      }

      const chapterFlags: AnalysisFlag[] = [];

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        // Check test mode limit
        if (options.testMode && chunksProcessed >= chunksToProcess) {
          break;
        }

        // Check for cancellation
        if (abortController.signal.aborted) {
          throw new Error('Job cancelled');
        }

        chunksProcessed++;
        const chunk = chunks[chunkIndex];

        sendProgress({
          phase: 'processing',
          progress: Math.round((chunksProcessed / chunksToProcess) * 90) + 5,
          message: `Analyzing: ${chapter.title} (chunk ${chunkIndex + 1}/${chunks.length})`,
          currentChunk: chunksProcessed,
          totalChunks: chunksToProcess,
          currentChapter: chapterChunks.indexOf(chapterChunks.find(cc => cc.chapter.id === chapter.id)!) + 1,
          totalChapters: chapters.length,
        });

        // Build the prompt for this chunk
        const fullPrompt = buildPromptForChunk(promptTemplate, enabledCategories, chunk);

        try {
          const response = await analyzeChunkWithProvider(
            fullPrompt,
            'You are a critical text analyst. Return ONLY valid JSON arrays.',
            providerConfig,
            abortController.signal
          );

          const flags = parseAnalysisResponse(response, chapter.id, chapter.title, validCategoryIds);
          chapterFlags.push(...flags);
          if (flags.length > 0) {
            console.log(`[Analysis] ${chapter.title} chunk ${chunkIndex + 1}: ${flags.length} flags found`);
          }
        } catch (err) {
          if (abortController.signal.aborted) {
            throw new Error('Job cancelled');
          }
          console.error(`[Analysis] Error analyzing ${chapter.title} chunk ${chunkIndex + 1}:`, err);
          // Continue to next chunk — don't fail the whole job for one chunk
        }
      }

      // Accumulate chapter results
      allFlags.push(...chapterFlags);
      chapterSummaries.push({
        chapterId: chapter.id,
        title: chapter.title,
        summary: chapterFlags.length > 0
          ? `Found ${chapterFlags.length} flag(s) across ${new Set(chapterFlags.map(f => f.categoryId)).size} categories`
          : 'No flags found',
        flagCount: chapterFlags.length,
      });
      completedChapterIds.add(chapter.id);

      // Save checkpoint after each chapter (skip in test mode)
      if (!options.testMode) {
        await saveCheckpoint(outputDir, {
          version: 1,
          sourceEpubPath: epubPath,
          totalChapters: chapters.length,
          completedChapters: Array.from(completedChapterIds),
          completedChunkCount: chunksProcessed,
          flags: allFlags,
          chapterSummaries,
          provider: providerConfig.provider,
          model,
          updatedAt: '',
        });
      }
    }

    // Build statistics
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0 };
    for (const flag of allFlags) {
      byCategory[flag.categoryId] = (byCategory[flag.categoryId] || 0) + 1;
      bySeverity[flag.severity] = (bySeverity[flag.severity] || 0) + 1;
    }

    const report: AnalysisReport = {
      version: 1,
      epubPath,
      analyzedAt: new Date().toISOString(),
      categories: enabledCategories,
      flags: allFlags,
      chapterSummaries,
      statistics: {
        totalFlags: allFlags.length,
        byCategory,
        bySeverity,
      },
    };

    // Write report
    sendProgress({ phase: 'saving', progress: 96, message: 'Saving analysis report...' });
    const outputPath = path.join(outputDir, 'analysis.json');
    const tmpPath = outputPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(report, null, 2), 'utf-8');
    await fs.rename(tmpPath, outputPath);

    // Delete checkpoint on success
    await deleteCheckpoint(outputDir);

    const completedAt = new Date().toISOString();
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    console.log(`[Analysis] Complete: ${allFlags.length} flags found in ${durationSeconds}s`);

    sendProgress({
      phase: 'complete',
      progress: 100,
      message: `Analysis complete: ${allFlags.length} flags found`,
    });

    // Cleanup
    activeAnalysisJobs.delete(jobId);
    powerSaveBlocker.stop(powerBlockerId);

    return {
      success: true,
      outputPath,
      flagCount: allFlags.length,
      analytics: {
        jobId,
        startedAt,
        completedAt,
        durationSeconds,
        totalChapters: chapters.length,
        totalChunks: chunksProcessed,
        flagsFound: allFlags.length,
        model,
      },
    };
  } catch (err) {
    activeAnalysisJobs.delete(jobId);
    powerSaveBlocker.stop(powerBlockerId);

    const error = (err as Error).message;
    console.error(`[Analysis] Job ${jobId} failed:`, error);

    sendProgress({
      phase: 'error',
      progress: 0,
      message: error,
    });

    return {
      success: false,
      error,
    };
  }
}

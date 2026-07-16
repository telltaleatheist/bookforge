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
import * as crypto from 'crypto';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import { extractChaptersFromEpub, type ChapterData } from './epub-processor.js';
import { findBestBreakPoint, estimateNumCtx } from './ai-bridge.js';
import { getOllamaThinkFields } from './ollama-capabilities.js';
import type { AIProviderConfig } from './ai-bridge.js';
import {
  commitAudiobookAnalysisReport,
  createAudiobookAnalysisBinding,
  resolveAudiobookAnalysisSource,
  audiobookAnalysisBindingsEqual,
  validateAudiobookAnalysisPayload,
  type AudiobookAnalysisBinding,
} from './audiobook-analysis-protocol.js';
import { atomicWriteFile } from './manifest-service.js';
import {
  fuzzyQuoteMatchesTranscript,
  locateAudiobookQuoteCueRange,
  parseAnalysisJsonArray,
  recoverAudiobookAnalysisChunk,
  TooManyAudiobookAnalysisSkipsError,
  type AudiobookAnalysisFailureClass,
  type AudiobookAnalysisSkippedChunk,
  type RecoverableAudiobookChunk,
} from './audiobook-analysis-recovery.js';

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

/** Durable descriptor of which project version this report was run against.
 *  Stored in the report so the association "sticks" — the UI pins the report to
 *  this version by id, and never silently re-points it to a different file. */
export interface AnalysisTarget {
  versionId: string;    // stable version identity ('original'|'cleaned'|'translated-de'|<variant id>)
  versionType: string;  // the version's type ('original'|'cleaned'|'translated'|'ebook'…)
  versionLabel: string; // human label, for display ("German EPUB", "AI Cleaned"…)
}

export interface AnalysisReport {
  version: 1;
  epubPath: string;
  target?: AnalysisTarget;
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
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  skippedChunksPath?: string;
  analytics?: AnalysisAnalytics;
}

interface AnalysisAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalChapters: number;
  totalChunks: number;
  requestAttempts?: number;
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
const CLAUDE_RESPONSE_LOG_LIMIT = 1200;

interface AnalysisRequestContext {
  jobId: string;
  sourceKind: 'document' | 'audiobook';
  currentChunk: number;
  totalChunks: number;
  /** Populated only after Anthropic returns HTTP success. Kept in memory until
   * strict parsing succeeds, then discarded with the per-chunk context. */
  claudeResponse?: Record<string, any>;
  responseLogged?: boolean;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  refusal?: string;
  reason?: string;
  message?: string;
  thinking?: string;
  signature?: string;
  [key: string]: unknown;
}

/** Keep the provider response needed to diagnose refusals, but never include
 * the request/transcript, API key, or private thinking/signature contents. */
function sanitizeClaudeResponse(data: Record<string, any>): Record<string, unknown> {
  const content = Array.isArray(data.content) ? data.content as ClaudeContentBlock[] : [];
  return {
    id: data.id ?? null,
    type: data.type ?? null,
    role: data.role ?? null,
    model: data.model ?? null,
    stop_reason: data.stop_reason ?? null,
    stop_sequence: data.stop_sequence ?? null,
    usage: data.usage ?? null,
    content: content.map(block => {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(block)) {
        if (key === 'thinking') {
          sanitized.thinking_length = typeof value === 'string' ? value.length : 0;
        } else if (key === 'signature') {
          sanitized.signature_present = typeof value === 'string' && value.length > 0;
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }),
  };
}

function logClaudeResponseDiagnostic(
  data: Record<string, any>,
  model: string,
  context?: AnalysisRequestContext,
): void {
  const sanitized = sanitizeClaudeResponse(data);
  const metadata = {
    provider: 'claude',
    requestedModel: model,
    request: context ? {
      jobId: context.jobId,
      sourceKind: context.sourceKind,
      currentChunk: context.currentChunk,
      totalChunks: context.totalChunks,
    } : undefined,
    responseId: sanitized['id'],
    responseModel: sanitized['model'],
    stopReason: sanitized['stop_reason'],
    stopSequence: sanitized['stop_sequence'],
    usage: sanitized['usage'],
    blockTypes: Array.isArray(sanitized['content'])
      ? (sanitized['content'] as Array<Record<string, unknown>>).map(block => block['type'] ?? 'unknown')
      : [],
  };
  const contentJson = JSON.stringify(sanitized['content'] ?? []);
  const preview = contentJson.length > CLAUDE_RESPONSE_LOG_LIMIT
    ? `${contentJson.slice(0, CLAUDE_RESPONSE_LOG_LIMIT)}… [truncated; ${contentJson.length} chars total]`
    : contentJson;
  console.error('[ClaudeAnalysis] Non-usable response metadata:', JSON.stringify(metadata));
  console.error(`[ClaudeAnalysis] Response content preview (max ${CLAUDE_RESPONSE_LOG_LIMIT} chars):`, preview);
  if (context) context.responseLogged = true;
}

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
  abortSignal?: AbortSignal,
  strictResponse = false,
  context?: AnalysisRequestContext,
): Promise<string> {
  switch (config.provider) {
    case 'ollama':
      if (!config.ollama?.model) throw new Error('Ollama model not configured');
      return analyzeChunkOllama(prompt, systemPrompt, config.ollama.model, config.ollama.baseUrl, abortSignal, strictResponse);
    case 'claude':
      if (!config.claude?.apiKey) throw new Error('Claude API key not configured');
      if (!config.claude?.model) throw new Error('Claude model not configured');
      return analyzeChunkClaude(prompt, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal, strictResponse, context);
    case 'openai':
      if (!config.openai?.apiKey) throw new Error('OpenAI API key not configured');
      if (!config.openai?.model) throw new Error('OpenAI model not configured');
      return analyzeChunkOpenAI(prompt, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal, strictResponse);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

async function analyzeChunkOllama(
  prompt: string,
  systemPrompt: string,
  model: string,
  baseUrl?: string,
  abortSignal?: AbortSignal,
  strictResponse = false,
): Promise<string> {
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(abortSignal, controller);

  try {
    const resolvedBaseUrl = baseUrl || OLLAMA_BASE_URL;
    // Capability-gated: thinking models (e.g. qwen3) get think:false so the
    // generation budget goes to the answer, not a discarded chain-of-thought.
    const thinkFields = await getOllamaThinkFields(resolvedBaseUrl, model);
    const response = await fetch(`${resolvedBaseUrl}/api/generate`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        system: systemPrompt,
        stream: false,
        ...thinkFields,
        options: {
          temperature: 0.1,
          // Analysis response is small JSON — allow generous output but don't need input*2
          num_predict: 4096,
          num_ctx: estimateNumCtx(systemPrompt, prompt, 0.5, model),
        },
        keep_alive: '5m',
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.response;
    if (strictResponse && (typeof content !== 'string' || !content.trim())) {
      throw new Error('Ollama returned an empty audiobook analysis response');
    }
    return content || '[]';
  } finally {
    unlinkAbort();
  }
}

/** Forward job cancellation to a per-request controller and always detach the
 * listener when the request finishes. `{ once: true }` alone only detaches when
 * cancellation actually fires, which leaked one listener per successful call. */
function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const forwardAbort = () => target.abort();
  if (source.aborted) target.abort();
  else source.addEventListener('abort', forwardAbort, { once: true });
  return () => source.removeEventListener('abort', forwardAbort);
}

async function analyzeChunkClaude(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal,
  strictResponse = false,
  context?: AnalysisRequestContext,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const unlinkAbort = linkAbortSignal(abortSignal, controller);

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

    const data = await response.json() as Record<string, any>;
    if (context) context.claudeResponse = data;
    const blocks = Array.isArray(data.content) ? data.content as ClaudeContentBlock[] : [];
    const content = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('')
      .trim();
    const blockTypes = blocks.map(block => block?.type || 'unknown');
    const refusalDetails = blocks
      .flatMap(block => [block.refusal, block.reason, block.message])
      .filter((value): value is string => typeof value === 'string' && !!value.trim());
    const refused = data.stop_reason === 'refusal' || blockTypes.includes('refusal');

    if (strictResponse && (refused || data.stop_reason === 'max_tokens' || !content)) {
      logClaudeResponseDiagnostic(data, model, context);
      const responseId = typeof data.id === 'string' ? data.id : 'unknown';
      if (refused) {
        const detail = refusalDetails[0] ? `: ${refusalDetails[0]}` : '';
        throw new Error(`Claude refused the audiobook analysis request${detail} (response ${responseId}).`);
      }
      if (data.stop_reason === 'max_tokens') {
        throw new Error(`Claude audiobook analysis hit its output limit (response ${responseId}).`);
      }
      throw new Error(
        `Claude returned no text for audiobook analysis (response ${responseId}; `
        + `stop_reason: ${data.stop_reason ?? 'unknown'}; blocks: ${blockTypes.join(', ') || 'none'}).`,
      );
    }
    return content || '[]';
  } finally {
    clearTimeout(timeoutId);
    unlinkAbort();
  }
}

async function analyzeChunkOpenAI(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  model: string,
  abortSignal?: AbortSignal,
  strictResponse = false,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const unlinkAbort = linkAbortSignal(abortSignal, controller);

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
    const content = (data as any).choices?.[0]?.message?.content;
    if (strictResponse && (typeof content !== 'string' || !content.trim())) {
      throw new Error('OpenAI returned an empty audiobook analysis response');
    }
    return content || '[]';
  } finally {
    clearTimeout(timeoutId);
    unlinkAbort();
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

/** Remove a project's analysis entirely: the finished report AND any in-progress
 *  checkpoint. Used by the "Delete analysis" action. Missing files are fine. */
export async function deleteAnalysis(outputDir: string): Promise<void> {
  await Promise.all([
    fs.unlink(path.join(outputDir, 'analysis.json')).catch(() => {}),
    fs.unlink(getCheckpointPath(outputDir)).catch(() => {}),
  ]);
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
    target?: AnalysisTarget;
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
      target: options.target,
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

// ─────────────────────────────────────────────────────────────────────────────
// Audiobook Analysis
// ─────────────────────────────────────────────────────────────────────────────

const AUDIOBOOK_PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'audiobook-analysis.txt');

type AudiobookAnalysisSource = Awaited<ReturnType<typeof resolveAudiobookAnalysisSource>>;
type AudiobookCue = AudiobookAnalysisSource['cues'][number];

export interface AudiobookAnalysisFlag {
  categoryId: string;
  quote: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  cueStartIndex: number;
  cueEndIndex: number;
  startTime: number;
  endTime: number;
}

interface AudiobookCueChunk {
  cues: AudiobookCue[];
  promptText: string;
}

interface AudiobookAnalysisPayload {
  analyzedAt: string;
  categories: AnalysisCategory[];
  flags: AudiobookAnalysisFlag[];
  skippedChunks: AudiobookAnalysisSkippedChunk[];
  statistics: {
    totalFlags: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    topLevelChunks: number;
    skippedChunks: number;
    analyzedCueCount: number;
    skippedCueCount: number;
  };
}

interface AudiobookAnalysisCheckpoint {
  version: 1;
  kind: 'audiobook-analysis-progress';
  binding: AudiobookAnalysisBinding;
  provider: string;
  model: string;
  categoryDigest: string;
  totalTopLevelChunks: number;
  completedTopLevelChunks: number[];
  flags: AudiobookAnalysisFlag[];
  skippedChunks: AudiobookAnalysisSkippedChunk[];
  requestAttempts: number;
  updatedAt: string;
}

interface AudiobookAnalysisProgressPaths {
  checkpoint: string;
  skippedChunks: string;
}

function audiobookAnalysisProgressPaths(source: AudiobookAnalysisSource): AudiobookAnalysisProgressPaths {
  const key = crypto.createHash('sha256')
    .update(`${source.projectId}\0${source.variant.id}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const dir = path.join(source.projectDir, 'stages', '04-analysis', 'audiobooks', 'progress');
  return {
    checkpoint: path.join(dir, `${key}.json`),
    skippedChunks: path.join(dir, `${key}.skipped-chunks.json`),
  };
}

function audiobookCategoryDigest(categories: AnalysisCategory[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(categories), 'utf8').digest('hex');
}

async function loadAudiobookAnalysisCheckpoint(checkpointPath: string): Promise<AudiobookAnalysisCheckpoint | null> {
  let raw: string;
  try {
    raw = await fs.readFile(checkpointPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Audiobook analysis checkpoint is corrupt: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Audiobook analysis checkpoint is not an object');
  }
  const checkpoint = parsed as AudiobookAnalysisCheckpoint;
  if (checkpoint.version !== 1 || checkpoint.kind !== 'audiobook-analysis-progress'
    || !checkpoint.binding || !Array.isArray(checkpoint.completedTopLevelChunks)
    || !Array.isArray(checkpoint.flags) || !Array.isArray(checkpoint.skippedChunks)
    || !Number.isInteger(checkpoint.totalTopLevelChunks) || checkpoint.totalTopLevelChunks < 1
    || !Number.isInteger(checkpoint.requestAttempts) || checkpoint.requestAttempts < 0) {
    throw new Error('Audiobook analysis checkpoint schema is invalid');
  }
  return checkpoint;
}

async function removeAudiobookAnalysisProgress(paths: AudiobookAnalysisProgressPaths): Promise<void> {
  await Promise.all([
    fs.unlink(paths.checkpoint).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }),
    fs.unlink(paths.skippedChunks).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }),
  ]);
}

async function saveAudiobookSkippedChunks(
  outputPath: string,
  binding: AudiobookAnalysisBinding,
  skippedChunks: AudiobookAnalysisSkippedChunk[],
): Promise<void> {
  await atomicWriteFile(outputPath, JSON.stringify({
    version: 1,
    kind: 'audiobook-analysis-skipped-chunks',
    binding,
    updatedAt: new Date().toISOString(),
    skippedChunks,
  }, null, 2));
}

function formatAudiobookCue(cue: AudiobookCue): string {
  return `[${cue.index}] ${cue.text}`;
}

function makeAudiobookCueChunk(cues: AudiobookCue[]): AudiobookCueChunk {
  return { cues, promptText: cues.map(formatAudiobookCue).join('\n') };
}

/**
 * Pack complete VTT cues into model-sized chunks. A cue is never split: its
 * integer id is the stable boundary the model must return with each finding.
 */
function chunkAudiobookCues(cues: AudiobookCue[]): AudiobookCueChunk[] {
  const chunks: AudiobookCueChunk[] = [];
  let chunkCues: AudiobookCue[] = [];
  let chunkLines: string[] = [];
  let chunkLength = 0;

  const flush = () => {
    if (chunkCues.length === 0) return;
    chunks.push(makeAudiobookCueChunk(chunkCues));
    chunkCues = [];
    chunkLines = [];
    chunkLength = 0;
  };

  for (const cue of cues) {
    const line = formatAudiobookCue(cue);
    const addedLength = line.length + (chunkLines.length > 0 ? 1 : 0);
    if (chunkCues.length > 0 && chunkLength + addedLength > CHUNK_SIZE) {
      flush();
    }
    chunkCues.push(cue);
    chunkLines.push(line);
    chunkLength += line.length + (chunkLines.length > 1 ? 1 : 0);
  }
  flush();
  return chunks;
}

function normalizeCueText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Strict parser for audiobook findings. Unlike the legacy EPUB parser, invalid
 * model output is fatal: publishing a plausible-looking finding with a guessed
 * or fabricated playback anchor would violate the report's timing guarantee. */
function parseAudiobookAnalysisResponse(
  response: string,
  chunk: AudiobookCueChunk,
  validCategoryIds: Set<string>,
): AudiobookAnalysisFlag[] {
  const parsed = parseAnalysisJsonArray(response);

  const cuePositions = new Map<number, number>();
  chunk.cues.forEach((cue, position) => {
    if (!Number.isInteger(cue.index)) {
      throw new Error(`Authoritative transcript contains a non-integer cue id: ${cue.index}`);
    }
    if (cuePositions.has(cue.index)) {
      throw new Error(`Authoritative transcript contains duplicate cue id ${cue.index}`);
    }
    cuePositions.set(cue.index, position);
  });

  return parsed.map((raw, findingIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const categoryId = item['categoryId'];
    const quote = item['quote'];
    const description = item['description'];
    const severity = item['severity'];
    const cueStartIndex = item['cueStartIndex'];
    const cueEndIndex = item['cueEndIndex'];

    if (typeof categoryId !== 'string' || !validCategoryIds.has(categoryId)) {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} has an invalid categoryId`);
    }
    if (typeof quote !== 'string' || !quote.trim()) {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} has no quote`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} has no description`);
    }
    if (severity !== 'low' && severity !== 'medium' && severity !== 'high') {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} has an invalid severity`);
    }
    if (!Number.isInteger(cueStartIndex) || !Number.isInteger(cueEndIndex)) {
      throw new Error(`Audiobook analysis finding ${findingIndex + 1} must use integer cue ids`);
    }

    let startPosition = cuePositions.get(cueStartIndex as number);
    let endPosition = cuePositions.get(cueEndIndex as number);
    let storedQuote = normalizeCueText(quote);
    let relocated = false;
    if (startPosition !== undefined && endPosition !== undefined && startPosition <= endPosition) {
      const claimedText = normalizeCueText(chunk.cues.slice(startPosition, endPosition + 1).map(cue => cue.text).join(' '));
      if (!claimedText.includes(storedQuote)) {
        if (fuzzyQuoteMatchesTranscript(quote, claimedText)) {
          // Briefcase permits fuzzy location. BookForge additionally seals the
          // persisted quote to authoritative VTT words so later verification is exact.
          storedQuote = claimedText;
          console.warn(
            `[AudiobookAnalysis] Reconciled finding ${findingIndex + 1} to exact cue text `
            + `for range ${cueStartIndex}-${cueEndIndex}`,
          );
        } else {
          const located = locateAudiobookQuoteCueRange(quote, chunk.cues);
          if (located) {
            startPosition = located.startPosition;
            endPosition = located.endPosition;
            relocated = true;
          } else {
            throw new Error(
              `Audiobook analysis finding ${findingIndex + 1} quote is not present in its cue range `
              + `${cueStartIndex}-${cueEndIndex} and could not be located unambiguously in the chunk`,
            );
          }
        }
      }
    } else {
      const located = locateAudiobookQuoteCueRange(quote, chunk.cues);
      if (!located) {
        throw new Error(
          `Audiobook analysis finding ${findingIndex + 1} returned an out-of-chunk cue range `
          + `${cueStartIndex}-${cueEndIndex} and its quote could not be located unambiguously`,
        );
      }
      startPosition = located.startPosition;
      endPosition = located.endPosition;
      relocated = true;
    }

    const anchoredCues = chunk.cues.slice(startPosition, endPosition + 1);
    if (relocated) {
      storedQuote = normalizeCueText(anchoredCues.map(cue => cue.text).join(' '));
      console.warn(
        `[AudiobookAnalysis] Relocated finding ${findingIndex + 1} from cue range `
        + `${cueStartIndex}-${cueEndIndex} to authoritative range `
        + `${anchoredCues[0].index}-${anchoredCues[anchoredCues.length - 1].index}`,
      );
    }

    return {
      categoryId,
      quote: storedQuote,
      description,
      severity,
      cueStartIndex: anchoredCues[0].index,
      cueEndIndex: anchoredCues[anchoredCues.length - 1].index,
      startTime: anchoredCues[0].startTime,
      endTime: anchoredCues[anchoredCues.length - 1].endTime,
    };
  });
}

function buildAudiobookAnalysisPayload(
  categories: AnalysisCategory[],
  flags: AudiobookAnalysisFlag[],
  skippedChunks: AudiobookAnalysisSkippedChunk[],
  topLevelChunks: number,
  totalCueCount: number,
): AudiobookAnalysisPayload {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0 };
  for (const flag of flags) {
    byCategory[flag.categoryId] = (byCategory[flag.categoryId] || 0) + 1;
    bySeverity[flag.severity]++;
  }
  const skippedCueCount = skippedChunks.reduce(
    (sum, skipped) => sum + skipped.cueEndIndex - skipped.cueStartIndex + 1,
    0,
  );
  return {
    analyzedAt: new Date().toISOString(),
    categories,
    flags,
    skippedChunks,
    statistics: {
      totalFlags: flags.length,
      byCategory,
      bySeverity,
      topLevelChunks,
      skippedChunks: skippedChunks.length,
      analyzedCueCount: totalCueCount - skippedCueCount,
      skippedCueCount,
    },
  };
}

function classifyAudiobookAnalysisError(error: unknown): AudiobookAnalysisFailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message === 'job cancelled' || message.includes('aborterror') || message.includes('aborted')) {
    return { reason: 'request-error', recoverable: false, splitAllowed: false, retrySameChunk: false };
  }
  const unrecoverable = [
    'invalid_api_key', 'authentication', 'unauthorized', 'credit balance',
    'insufficient_quota', 'quota exceeded', 'billing', 'model not found',
    'does not exist', 'http 400', 'api error: 400', 'http 401', 'api error: 401',
    'http 403', 'api error: 403',
  ];
  if (unrecoverable.some(pattern => message.includes(pattern))) {
    return { reason: 'request-error', recoverable: false, splitAllowed: false, retrySameChunk: false };
  }
  if (message.includes('copyright')) {
    return { reason: 'copyright', recoverable: true, splitAllowed: true, retrySameChunk: false };
  }
  if (message.includes('refus')) {
    return { reason: 'ai-refusal', recoverable: true, splitAllowed: true, retrySameChunk: false };
  }
  if (message.includes('empty') || message.includes('no text')) {
    return { reason: 'empty-response', recoverable: true, splitAllowed: true, retrySameChunk: false };
  }
  if (message.includes('output limit') || message.includes('max_tokens')
    || message.includes('maximum context length') || message.includes('finish reason: length')) {
    return { reason: 'output-limit', recoverable: true, splitAllowed: true, retrySameChunk: false };
  }
  return { reason: 'request-error', recoverable: true, splitAllowed: false, retrySameChunk: true };
}

function logInvalidAudiobookAnalysisResponse(
  provider: string,
  response: string,
  error: Error,
  chunk: RecoverableAudiobookChunk<AudiobookCue>,
  attempt: number,
): void {
  const preview = response.length > CLAUDE_RESPONSE_LOG_LIMIT
    ? `${response.slice(0, CLAUDE_RESPONSE_LOG_LIMIT)}… [truncated; ${response.length} chars total]`
    : response;
  console.error('[AudiobookAnalysis] Invalid provider response:', JSON.stringify({
    provider,
    attempt,
    cueStartIndex: chunk.cues[0].index,
    cueEndIndex: chunk.cues[chunk.cues.length - 1].index,
    validationError: error.message,
  }));
  console.error(`[AudiobookAnalysis] Response preview (max ${CLAUDE_RESPONSE_LOG_LIMIT} chars):`, preview);
}

/**
 * Analyze the authoritative transcript sealed to one audiobook variant.
 *
 * Identity and persistence are intentionally delegated to the protocol module:
 * it snapshots the M4B + canonical cue hashes before processing and re-verifies
 * that exact binding while atomically committing the finished report.
 */
export async function analyzeAudiobook(
  projectId: string,
  variantId: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  providerConfig: AIProviderConfig,
  options: {
    categories: AnalysisCategory[];
    testMode?: boolean;
    testModeChunks?: number;
  },
): Promise<AnalysisResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const abortController = new AbortController();
  activeAnalysisJobs.set(jobId, abortController);
  const powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
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
    if (options.testMode) {
      throw new Error('Test mode is not available for audiobook analysis');
    }
    const enabledCategories = options.categories.filter(category => category.enabled);
    if (enabledCategories.length === 0) {
      throw new Error('No analysis categories enabled');
    }
    const validCategoryIds = new Set(enabledCategories.map(category => category.id));

    sendProgress({ phase: 'loading', progress: 0, message: 'Verifying audiobook transcript...' });
    const source = await resolveAudiobookAnalysisSource(projectId, variantId);
    if (abortController.signal.aborted) throw new Error('Job cancelled');
    if (source.cues.length === 0) {
      throw new Error('The authoritative audiobook transcript contains no cues');
    }
    const promptTemplate = (await fs.readFile(AUDIOBOOK_PROMPT_FILE_PATH, 'utf-8')).trim();
    const chunks = chunkAudiobookCues(source.cues);
    if (chunks.length === 0) {
      throw new Error('The authoritative audiobook transcript produced no analysis chunks');
    }
    const progressPaths = audiobookAnalysisProgressPaths(source);
    const categoryDigest = audiobookCategoryDigest(enabledCategories);
    const checkpoint = await loadAudiobookAnalysisCheckpoint(progressPaths.checkpoint);
    let expectedBinding: AudiobookAnalysisBinding;
    let allFlags: AudiobookAnalysisFlag[] = [];
    let skippedChunks: AudiobookAnalysisSkippedChunk[] = [];
    let requestAttempts = 0;
    let completedTopLevelChunks = new Set<number>();

    if (checkpoint) {
      const currentCheckpointBinding = await createAudiobookAnalysisBinding(source, checkpoint.binding.analysisId);
      const checkpointMatches = audiobookAnalysisBindingsEqual(checkpoint.binding, currentCheckpointBinding)
        && checkpoint.provider === providerConfig.provider
        && checkpoint.model === model
        && checkpoint.categoryDigest === categoryDigest
        && checkpoint.totalTopLevelChunks === chunks.length;
      if (checkpointMatches) {
        const completed = checkpoint.completedTopLevelChunks;
        if (new Set(completed).size !== completed.length
          || completed.some(index => !Number.isInteger(index) || index < 0 || index >= chunks.length)) {
          throw new Error('Audiobook analysis checkpoint has invalid completed chunk indexes');
        }
        expectedBinding = currentCheckpointBinding;
        allFlags = [...checkpoint.flags];
        skippedChunks = [...checkpoint.skippedChunks];
        const checkpointPayload = buildAudiobookAnalysisPayload(
          enabledCategories,
          allFlags,
          skippedChunks,
          chunks.length,
          source.cues.length,
        );
        const checkpointPayloadError = validateAudiobookAnalysisPayload(checkpointPayload, source.cues);
        if (checkpointPayloadError) {
          throw new Error(`Audiobook analysis checkpoint payload is invalid: ${checkpointPayloadError}`);
        }
        requestAttempts = checkpoint.requestAttempts;
        completedTopLevelChunks = new Set(completed);
        console.log(
          `[AudiobookAnalysis] Resuming ${completedTopLevelChunks.size}/${chunks.length} top-level chunks `
          + `with ${allFlags.length} flags and ${skippedChunks.length} skipped ranges`,
        );
      } else {
        console.warn('[AudiobookAnalysis] Existing progress targets different source bytes or settings; starting a new analysis');
        await removeAudiobookAnalysisProgress(progressPaths);
        expectedBinding = await createAudiobookAnalysisBinding(source);
      }
    } else {
      expectedBinding = await createAudiobookAnalysisBinding(source);
    }

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (completedTopLevelChunks.has(chunkIndex)) continue;
      if (abortController.signal.aborted) throw new Error('Job cancelled');
      const chunk = chunks[chunkIndex];
      const currentChunk = chunkIndex + 1;
      sendProgress({
        phase: 'processing',
        progress: Math.round((currentChunk / chunks.length) * 90) + 5,
        message: `Analyzing audiobook transcript (chunk ${currentChunk}/${chunks.length})`,
        currentChunk,
        totalChunks: chunks.length,
      });

      let latestRequestContext: AnalysisRequestContext | undefined;
      try {
        const recovered = await recoverAudiobookAnalysisChunk({
          chunk,
          topLevelChunkNumber: currentChunk,
          totalTopLevelChunks: chunks.length,
          existingSkippedCount: skippedChunks.length,
          maxSkippedChunks: 10,
          signal: abortController.signal,
          makeChunk: makeAudiobookCueChunk,
          analyze: async recoveryChunk => {
            latestRequestContext = {
              jobId,
              sourceKind: 'audiobook',
              currentChunk,
              totalChunks: chunks.length,
            };
            const fullPrompt = buildPromptForChunk(promptTemplate, enabledCategories, recoveryChunk.promptText);
            return analyzeChunkWithProvider(
              fullPrompt,
              'You are a selective audiobook transcript analyst. Return only sparse, passage-level findings as a valid JSON array with exact integer cue ids. Most ordinary cues require no finding.',
              providerConfig,
              abortController.signal,
              true,
              latestRequestContext,
            );
          },
          parse: (response, recoveryChunk) =>
            parseAudiobookAnalysisResponse(response, recoveryChunk, validCategoryIds),
          classifyError: classifyAudiobookAnalysisError,
          classifyInvalidResponse: (response, validationError) => {
            const contentFailure = classifyAudiobookAnalysisError(
              new Error(`${validationError.message}\n${response.slice(0, 1200)}`),
            );
            // Parsing/schema/anchor failures are model-output failures, not
            // transport failures. Preserve recognized refusals/output limits,
            // but otherwise split immediately instead of retrying or skipping
            // the original large range.
            return contentFailure.reason === 'request-error'
              ? { reason: 'invalid-response', recoverable: true, splitAllowed: true, retrySameChunk: false }
              : { ...contentFailure, retrySameChunk: false };
          },
          onInvalidResponse: (response, error, recoveryChunk, attempt) => {
            if (latestRequestContext?.claudeResponse && !latestRequestContext.responseLogged) {
              logClaudeResponseDiagnostic(latestRequestContext.claudeResponse, model, latestRequestContext);
            }
            if (providerConfig.provider !== 'claude') {
              logInvalidAudiobookAnalysisResponse(
                providerConfig.provider,
                response,
                error,
                recoveryChunk,
                attempt,
              );
            }
          },
          onEvent: event => {
            const action = event.action === 'retrying' ? 'Retrying'
              : event.action === 'splitting' ? 'Splitting' : 'Skipping';
            const message = `${action} cues ${event.cueStartIndex}-${event.cueEndIndex}: ${event.message}`;
            console.warn(`[AudiobookAnalysis] ${message}`);
            sendProgress({
              phase: 'processing',
              progress: Math.round((chunkIndex / chunks.length) * 90) + 5,
              message,
              currentChunk,
              totalChunks: chunks.length,
            });
          },
        });
        allFlags.push(...recovered.flags);
        skippedChunks.push(...recovered.skippedChunks);
        requestAttempts += recovered.requestAttempts;
      } catch (err) {
        // A refusal can arrive as ordinary text. Preserve Claude metadata even
        // when the provider call succeeded but strict parsing failed afterward.
        if (latestRequestContext?.claudeResponse && !latestRequestContext.responseLogged) {
          logClaudeResponseDiagnostic(
            latestRequestContext.claudeResponse,
            model,
            latestRequestContext,
          );
        }
        if (err instanceof TooManyAudiobookAnalysisSkipsError) {
          skippedChunks.push(...err.skippedChunks);
          await saveAudiobookSkippedChunks(progressPaths.skippedChunks, expectedBinding, skippedChunks);
        }
        throw err;
      }

      completedTopLevelChunks.add(chunkIndex);
      const checkpointToSave: AudiobookAnalysisCheckpoint = {
        version: 1,
        kind: 'audiobook-analysis-progress',
        binding: expectedBinding,
        provider: providerConfig.provider,
        model,
        categoryDigest,
        totalTopLevelChunks: chunks.length,
        completedTopLevelChunks: [...completedTopLevelChunks].sort((a, b) => a - b),
        flags: allFlags,
        skippedChunks,
        requestAttempts,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteFile(progressPaths.checkpoint, JSON.stringify(checkpointToSave, null, 2));
      if (skippedChunks.length > 0) {
        await saveAudiobookSkippedChunks(progressPaths.skippedChunks, expectedBinding, skippedChunks);
      }
    }

    const payload = buildAudiobookAnalysisPayload(
      enabledCategories,
      allFlags,
      skippedChunks,
      chunks.length,
      source.cues.length,
    );

    if (abortController.signal.aborted) throw new Error('Job cancelled');
    sendProgress({ phase: 'saving', progress: 96, message: 'Verifying and saving audiobook analysis...' });
    let skippedChunksPath: string | undefined;
    if (skippedChunks.length > 0) {
      skippedChunksPath = path.join(
        source.projectDir,
        'stages',
        '04-analysis',
        'audiobooks',
        expectedBinding.analysisId,
        'skipped-chunks.json',
      );
      await saveAudiobookSkippedChunks(skippedChunksPath, expectedBinding, skippedChunks);
    }
    const committed = await commitAudiobookAnalysisReport({
      projectId,
      variantId,
      expectedBinding,
      payload,
    });
    try {
      await removeAudiobookAnalysisProgress(progressPaths);
    } catch (err) {
      console.warn(`[AudiobookAnalysis] Report committed, but progress cleanup failed: ${(err as Error).message}`);
    }

    const completedAt = new Date().toISOString();
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    sendProgress({
      phase: 'complete',
      progress: 100,
      message: `Audiobook analysis complete: ${allFlags.length} flags found`,
    });
    return {
      success: true,
      outputPath: committed.outputPath,
      flagCount: allFlags.length,
      contentSkipsDetected: skippedChunks.length > 0,
      contentSkipsAffected: skippedChunks.length,
      skippedChunksPath,
      analytics: {
        jobId,
        startedAt,
        completedAt,
        durationSeconds,
        totalChapters: 0,
        totalChunks: chunks.length,
        requestAttempts,
        flagsFound: allFlags.length,
        model,
      },
    };
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[AudiobookAnalysis] Job ${jobId} failed:`, error);
    sendProgress({ phase: 'error', progress: 0, message: error });
    return { success: false, error };
  } finally {
    activeAnalysisJobs.delete(jobId);
    powerSaveBlocker.stop(powerBlockerId);
  }
}

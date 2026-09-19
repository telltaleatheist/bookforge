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

import { publishBridgeEvent } from './bridge-events';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import { extractChaptersFromEpub, type ChapterData } from './epub-processor.js';
import { aiCallServer, findBestBreakPoint } from './ai-bridge.js';
// The ONE rule for "did this refusal name a holder" — see queue-steps/runtime.ts.
import { busyLineOf } from './queue-steps/runtime';
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
  /**
   * THE RUN DID NOT HAPPEN AND NOTHING IS WRONG — the one line that turns this
   * failure into a WAIT.
   *
   * Present exactly when a Crucible refused because something else holds that
   * card: `409 leased` (another client is mid-run on the model) or
   * `409 server_busy` (its lane is held). It carries the holder in the SDK's
   * own words.
   *
   * It exists so the QUEUE can park the row: `queue-steps/book-analysis.ts`
   * hands it to `stepFailure` and `settleStep` puts the step back to `queued`
   * with that line on it, rather than reddening a row nobody did anything
   * wrong on (bug hunt 2026-09-19, A5).
   */
  busyLine?: string;
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
  /**
   * WHICH MACHINE ran it, by registry name — the other half of the question
   * `model` answers, read off the same provider block by `aiCallServer`
   * (electron/ai-bridge.ts). Owen, 2026-09-15: *"the analytics data should
   * contain which crucible server was used"*.
   *
   * In practice always present on a record this build writes: an analysis
   * REFUSES every provider but `crucible` (`analysisProviderRefusal`) and
   * refuses a crucible block that names no server, so a run that reaches the
   * record has a venue. Optional all the same, because every record written
   * before 2026-09-15 has none, and that absence means "from before the field"
   * — it is never repaired with a machine chosen now.
   */
  crucibleServer?: string;
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

export function buildPromptForChunk(
  template: string,
  categories: AnalysisCategory[],
  text: string
): string {
  const categoryBlock = categories
    .filter(c => c.enabled)
    .map(c => `- ${c.id}: "${c.name}" — ${c.description}`)
    .join('\n');

  // REPLACER FUNCTIONS, because what goes into the slots is the book. In a
  // replacement STRING `$&`, `` $` `` and `$'` are pattern references — the
  // matched text, everything before it and everything after it — and the match
  // here is the placeholder, in a template that is the whole prompt. Measured
  // on a chapter reading `… or $& if you prefer, plus $` and $'.`: the model was
  // sent `… or {text} if you prefer, plus` and then the ENTIRE prompt twice, the
  // half before the slot and the half after it. (A string pattern has no capture
  // group, so a plain `$1,000` survives; `$&` is the one that fires.) The model
  // would be reading, and flagging with quotes, a chapter the book does not
  // contain. A function's return value is inserted verbatim. The category block
  // goes the same way: its names and descriptions are typed by a person.
  return template
    .replace('{categories}', () => categoryBlock)
    .replace('{text}', () => text);
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

/**
 * How much of an unusable provider answer reaches the log.
 *
 * A cap rather than the whole string, because what names a bad answer is
 * almost always its FIRST few hundred characters — a refusal sentence, a
 * chatty preamble before the array, a JSON object where an array was asked
 * for — while the remainder is the same failure continuing at length. 1200 is
 * the figure the deleted Claude-specific diagnostic used, kept because it has
 * been enough to identify every malformed answer this path has seen.
 */
const PROVIDER_RESPONSE_LOG_LIMIT = 1200;

/**
 * The token budget one analysis chunk's answer is allowed.
 *
 * A number rather than a function of the input, because the answer is a small
 * JSON array of findings and its size is set by how many things are IN the
 * chunk, not by how long the chunk is. Sizing it from the prompt — which the
 * translate act legitimately does, because a translation echoes the whole
 * chunk back — would spend an entire chunk's budget on a document the model
 * was never going to repeat. 4096 is the same floor the cleanup pass found
 * sufficient for its edit-list JSON, and a chunk that overruns it is refused
 * by name rather than silently returning half an array.
 */
const ANALYSIS_CRUCIBLE_MAX_TOKENS = 4096;

/**
 * The one sentence a provider that cannot run an analysis gets told.
 *
 * It lives in a function rather than at the throw site because TWO places ask
 * the same question and must not drift: the dispatch below, and the model-name
 * resolver that runs before the first chunk. A job config persisted last week
 * can still name a provider this build no longer has, so both are reached in
 * normal operation and both owe the operator a sentence rather than a crash or
 * a quietly skipped chunk — a skipped chunk yields a report that is SHORT,
 * which reads exactly like a book with nothing to flag in it.
 *
 * Two histories arrive here and the answer is the same for both. Ollama,
 * Claude and OpenAI left BookForge entirely in Crucible phase 15 (cloud keys
 * now live inside the Crucible engine, which forwards to the upstream on the
 * operator's account), and the bundled local model never had an analysis arm
 * to begin with — this act has only ever run on Crucible.
 */
function analysisProviderRefusal(provider: string): Error {
  return new Error(
    `analysis_provider_unsupported: "${provider}" cannot run a book analysis. `
    + 'Ollama, Claude and OpenAI were removed from BookForge in Crucible phase 15, and the '
    + 'bundled local model has no analysis arm. Re-point this row at a Crucible server '
    + '(provider "crucible") and run it again.',
  );
}

/**
 * THE MODEL THIS ANALYSIS RUNS ON, asked of the server that will run it.
 *
 * The name is not cosmetic: `loadCheckpoint` compares it to decide whether a
 * resume may continue, so a wrong or vague one is how one model's flags get
 * grafted onto another model's run.
 *
 * ── IT ASKS THE SERVER, THROUGH THE ONE OWNER ─────────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3: an analysis sends `capability.selected`
 * for the `analysis` class on the server the row was placed on, and nothing
 * else. `crucibleActModel` is the one owner of that read and of the stamp that
 * memoises it onto this run's provider block, so the checkpoint's name, every
 * chat's model and the analytics row are one id, asked for once. It refuses
 * three ways (`crucible_capability_undecided`, `…_disabled`, `…_no_model`),
 * each naming what a person would do about it.
 *
 * Refusing here, at the top of the run, is worth failing the whole job over:
 * `analyzeBook`'s per-chunk catch swallows errors and would otherwise turn a
 * server that cannot analyse into an empty report.
 */
async function analysisModelName(config: AIProviderConfig): Promise<string> {
  if (config.provider !== 'crucible') throw analysisProviderRefusal(config.provider);
  const block = config.crucible;
  if (block === undefined) {
    throw new Error(
      'crucible_server_not_named: this analysis names the Crucible provider and carries no '
      + "server or act, so there is nothing to ask. The row's assigned venue is what fills "
      + 'them (electron/queue-steps/ai-provider.ts).',
    );
  }
  const { crucibleActModel } = await import('./crucible/text-venue.js');
  return crucibleActModel(block);
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
): Promise<string> {
  switch (config.provider) {
    case 'crucible': {
      /*
       * THE ANALYSIS ACT ON A CRUCIBLE SERVER (crucible
       * `docs/PHASE7-LANES.md`; `analysis` is one of the four capability
       * classes, `electron/crucible/text-acts.ts`).
       *
       * Both halves refused by name rather than defaulted: the server comes
       * from the row's assigned venue (`queue-steps/ai-provider.ts`) and the
       * model must already be RESIDENT — an analysis never loads one, because
       * a load evicts whatever is on that card.
       *
       * The budget is this act's own and not the cleanup's `max(4096, len*2)`:
       * an analysis returns a SMALL JSON array whose size has nothing to do
       * with the input's, and sizing it from the prompt would spend a chunk's
       * whole budget on a document it was never going to echo back.
       */
      if (!config.crucible?.server) throw new Error('crucible_server_not_named: this analysis names no Crucible server');
      if (!config.crucible?.model) throw new Error('crucible_model_not_named: this analysis names no Crucible model');
      const { crucibleChatOnce } = await import('./ai-bridge.js');
      const answer = await crucibleChatOnce({
        server: config.crucible.server,
        model: config.crucible.model,
        // The class this run IS, off the provider block the queue composed —
        // not a literal, so a door that is ever reached by another act cannot
        // label itself wrongly.
        act: config.crucible.act,
        system: systemPrompt,
        user: prompt,
        temperature: 0.1,
        maxTokens: ANALYSIS_CRUCIBLE_MAX_TOKENS,
        sizeChars: prompt.length,
        ...(abortSignal === undefined ? {} : { signal: abortSignal }),
      });
      if (answer.finishReason === 'length') {
        // Never the truncated JSON. A half-written array parses as a shorter
        // list of findings, which is a WRONG analysis rather than a failed one.
        throw new Error(
          `crucible_analysis_truncated: crucible "${config.crucible.server}" hit the `
          + `${ANALYSIS_CRUCIBLE_MAX_TOKENS}-token budget on a ${prompt.length}-char chunk, so its `
          + 'JSON answer is incomplete. A truncated finding list is not a shorter one.',
        );
      }
      return answer.content;
    }
    default:
      // Reached from a persisted row naming a provider this build removed, and
      // from `local`, which this act never implemented. See the refusal itself.
      throw analysisProviderRefusal(config.provider);
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

  const sendProgress = (data: {
    phase: string;
    progress: number;
    message?: string;
    currentChunk?: number;
    totalChunks?: number;
    currentChapter?: number;
    totalChapters?: number;
  }) => {
    publishBridgeEvent('queue:progress', { jobId, type: 'book-analysis', ...data });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'book-analysis',
        ...data,
      });
    }
  };

  try {
    // Inside the try, not above it: resolving the model can refuse the whole
    // job by name (an unsupported provider, an unstamped Crucible model), and
    // out here that refusal would escape past the power-save blocker and the
    // active-job registration instead of returning the usual failed result.
    const model = await analysisModelName(providerConfig);

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
          /*
           * A HELD CARD IS NOT A CHUNK THE MODEL STUMBLED ON (A5, 2026-09-19).
           *
           * `409 leased` / `409 server_busy` says the server would not take
           * this act at all, so every remaining chunk meets the same wall and
           * carrying on would write a report built from NO answers — a wrong
           * analysis rather than a partial one, and a row that never learns it
           * could simply have waited. Re-thrown whole so the holder's line
           * reaches the result and the queue parks the book.
           */
          if (busyLineOf(err) !== undefined) throw err;
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
        // WHICH MACHINE ran it, beside the model it ran. `undefined` keeps the
        // field off the record where there is no server to name, rather than
        // writing a null that a reader would have to tell apart from absent.
        crucibleServer: aiCallServer(providerConfig) ?? undefined,
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

    // The holder's line, carried rather than flattened into the sentence: it is
    // what lets the queue park this book instead of reddening it.
    const busyLine = busyLineOf(err);
    return {
      success: false,
      error,
      ...(busyLine === undefined ? {} : { busyLine }),
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
  /*
   * A HELD CARD IS NOT A CHUNK TO RETRY OR SPLIT (A5, 2026-09-19).
   *
   * `409 leased` / `409 server_busy` says the server would not take this act at
   * all: retrying it three times, splitting the cue range and skipping the
   * pieces would spend the whole recovery ladder on a wall every chunk meets,
   * and end in a skip threshold whose message has lost the holder's name.
   * `recoverable: false` makes the recovery re-throw the refusal WHOLE, so its
   * `busyLine` reaches the result and the queue parks the book instead of
   * failing it. Asked FIRST, because the message tests below would read a
   * 409's prose and call it a request error.
   */
  if (busyLineOf(error) !== undefined) {
    return { reason: 'request-error', recoverable: false, splitAllowed: false, retrySameChunk: false };
  }
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
  const preview = response.length > PROVIDER_RESPONSE_LOG_LIMIT
    ? `${response.slice(0, PROVIDER_RESPONSE_LOG_LIMIT)}… [truncated; ${response.length} chars total]`
    : response;
  console.error('[AudiobookAnalysis] Invalid provider response:', JSON.stringify({
    provider,
    attempt,
    cueStartIndex: chunk.cues[0].index,
    cueEndIndex: chunk.cues[chunk.cues.length - 1].index,
    validationError: error.message,
  }));
  console.error(`[AudiobookAnalysis] Response preview (max ${PROVIDER_RESPONSE_LOG_LIMIT} chars):`, preview);
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

  const sendProgress = (data: {
    phase: string;
    progress: number;
    message?: string;
    currentChunk?: number;
    totalChunks?: number;
  }) => {
    publishBridgeEvent('queue:progress', { jobId, type: 'book-analysis', ...data });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'book-analysis',
        ...data,
      });
    }
  };

  try {
    // Inside the try for the same reason as analyzeBook's: resolving the model
    // can refuse the job by name, and this function's `finally` is what stops
    // the power-save blocker and deregisters the job.
    const model = await analysisModelName(providerConfig);

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
            const fullPrompt = buildPromptForChunk(promptTemplate, enabledCategories, recoveryChunk.promptText);
            return analyzeChunkWithProvider(
              fullPrompt,
              'You are a selective audiobook transcript analyst. Return only sparse, passage-level findings as a valid JSON array with exact integer cue ids. Most ordinary cues require no finding.',
              providerConfig,
              abortController.signal,
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
            // Unconditional now. The guard this replaces was `provider !==
            // 'claude'`, and it was never about the generic log being wrong for
            // Claude — it was about Claude having already been logged, in
            // richer form, by an Anthropic-shaped diagnostic two lines above
            // that read stop_reason and refusal blocks off the raw response.
            // With Claude gone from BookForge there is no second logger and no
            // provider that should be silent about an unusable answer.
            logInvalidAudiobookAnalysisResponse(
              providerConfig.provider,
              response,
              error,
              recoveryChunk,
              attempt,
            );
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
        // WHICH MACHINE ran it, beside the model it ran. See the field's docs.
        crucibleServer: aiCallServer(providerConfig) ?? undefined,
      },
    };
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[AudiobookAnalysis] Job ${jobId} failed:`, error);
    sendProgress({ phase: 'error', progress: 0, message: error });
    // See the document arm above: a refusal that names a holder is a WAIT.
    const busyLine = busyLineOf(err);
    return { success: false, error, ...(busyLine === undefined ? {} : { busyLine }) };
  } finally {
    activeAnalysisJobs.delete(jobId);
    powerSaveBlocker.stop(powerBlockerId);
  }
}

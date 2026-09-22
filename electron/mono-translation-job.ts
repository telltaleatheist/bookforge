/**
 * THE TRANSLATE PASS — translate a book's EPUB, chapter by chapter, in place.
 *
 * This is the ledger pass a project runs when its source is not English
 * (`processing-passes.ts` → `runMonoTranslation`), and it is a DIFFERENT feature
 * from the language-learning pipeline this file used to serve. That file was
 * `ll-jobs.ts` (2,125 lines) and held three handlers: `runLLCleanup`,
 * `runLLTranslation` — the bilingual pipeline's own cleanup and side-by-side
 * translation — and this one. The language-learning feature was removed on
 * 2026-09-05 (Owen: "it needs to be rebuilt anyway ... clean it all out"); the
 * two LL handlers went with it and this one stayed, because a monolingual
 * translate pass is something a book pipeline wants whether or not anyone is
 * learning a language.
 *
 * Resumable by design: a checkpoint file and a per-chapter cache in the output
 * directory mean an interrupted run picks up at the chapter it reached, which is
 * what makes a several-hour translation survivable.
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { loadPrompt, PROMPTS } from './prompts.js';
import { mergeEpubParagraphs } from './epub-paragraph-merger';
import { aiCallModel, callAI, LANGUAGE_NAMES } from './text-ai.js';
import { aiCallServer, type AIProviderConfig } from './ai-bridge.js';
import { CrucibleTextActError } from './crucible/text-venue.js';
import { createEpubSink, openEpubSource } from './epub-container.js';
import {
  EpubProcessor,
  extractBlockTexts,
  replaceBlockTexts,
  formatNumberedParagraphs,
  parseNumberedParagraphs,
  validateNumberedParagraphs,
} from './epub-processor.js';
import * as cheerio from 'cheerio';
import { discardLibraryTree } from './library-trash';

// ─────────────────────────────────────────────────────────────────────────────
// Skip Marker Detection
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_MARKERS = ['[SKIP]', '[NO READABLE TEXT]', '[NOTHING TO CLEAN]'];
const isSkip = (s: string) => SKIP_MARKERS.some(m => s.trim() === m || s.trim().startsWith(m));

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

/** The analytics row a finished translate pass files (analytics-panel reads it). */
export interface TranslationJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalSentences: number;
  totalCharacters?: number;
  sentencesPerMinute: number;
  provider: string;
  /**
   * The model that ran, as the provider block names it — `null` where the block
   * names none. `aiCallModel` is the one reader of that, so the ledger and the
   * checkpoint below cannot disagree about which field a provider keeps it in.
   */
  model: string | null;
  /**
   * WHICH MACHINE ran it, by registry name — the other half of the same
   * question `model` answers, read once off the same provider block by
   * `aiCallServer` (electron/ai-bridge.ts). `undefined` where the block names
   * no Crucible server (the bundled local arm is this process), and on every
   * row written before 2026-09-15. Never repaired or defaulted: a sentences/min
   * figure attributed to a machine that did not produce it is worse than one
   * attributed to none.
   */
  crucibleServer?: string;
  sourceLang?: string;
  targetLang: string;
  /** 'bilingual' is a value only legacy rows on disk carry — that pipeline is gone. */
  mode: 'mono' | 'bilingual';
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * Progress this pass reports. Declared here now: it was `ProcessingProgress` in
 * bilingual-processor.ts, whose union of phases described the whole
 * language-learning pipeline. The phases this pass actually emits are the ones
 * left in it.
 */
export interface ProcessingProgress {
  phase: 'splitting' | 'translating' | 'epub' | 'complete' | 'error';
  currentChunk?: number;
  totalChunks?: number;
  currentSentence: number;
  totalSentences: number;
  percentage: number;
  message: string;
}

export interface TranslationJobResult {
  success: boolean;
  outputPath?: string;
  translatedEpubPath?: string;  // For mono translation - path to translated EPUB
  error?: string;
  /**
   * WHAT IS IN THE WAY, WHEN THE ANSWER IS "WAIT" RATHER THAN "BROKEN".
   *
   * The SDK's holder line — "leased: foundry, translate since …" — as
   * {@link CrucibleTextActError} carries it. A queue row parks against a server
   * only when the failure it settles on has one (`queue-steps/runtime.ts`,
   * `busyLineOf`); with no line the row reddens as though the book were
   * broken, and the operator is told to fix something that is merely busy.
   *
   * This result object is the translate path's only channel for it, because
   * `runMonoTranslation` answers with a value rather than throwing. Present
   * exactly when the refusal carried one.
   */
  busyLine?: string;
  // Job-analytics.json record (persisted by the renderer as a 'translation' entry).
  analytics?: TranslationJobAnalytics;
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
  publishBridgeEvent('ll-job:progress', { jobId, progress });
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
interface MonoTranslationCheckpoint {
  version: 1;
  sourceEpubPath: string;
  sourceLang: string;
  targetLang: string;
  aiProvider: string;
  /** As `TranslationJobAnalytics.model`: the block's own name for it, or null. */
  aiModel: string | null;
  totalChapters: number;
  totalParagraphs: number;
  completedChapters: string[];       // zipPath identifiers
  completedParagraphCount: number;
  updatedAt: string;
}

function getTranslationCheckpointPath(translateDir: string): string {
  return path.join(translateDir, 'translation-progress.json');
}

async function loadTranslationCheckpoint(translateDir: string): Promise<MonoTranslationCheckpoint | null> {
  try {
    const data = await fs.readFile(getTranslationCheckpointPath(translateDir), 'utf-8');
    const checkpoint = JSON.parse(data) as MonoTranslationCheckpoint;
    if (checkpoint.version !== 1) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

async function saveTranslationCheckpoint(translateDir: string, checkpoint: MonoTranslationCheckpoint): Promise<void> {
  const checkpointPath = getTranslationCheckpointPath(translateDir);
  const tmpPath = checkpointPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  await fs.rename(tmpPath, checkpointPath);
}

async function deleteTranslationCheckpoint(translateDir: string): Promise<void> {
  try {
    await fs.unlink(getTranslationCheckpointPath(translateDir));
  } catch {
    // File doesn't exist, that's fine
  }
}

// ── Chapter Cache ───────────────────────────────────────────────────────────

function getChapterCacheDir(translateDir: string): string {
  return path.join(translateDir, 'chapter-cache');
}

function getChapterCachePath(translateDir: string, zipPath: string): string {
  // Encode zipPath to safe filename: replace / with __
  const safeName = zipPath.replace(/\//g, '__');
  return path.join(getChapterCacheDir(translateDir), safeName);
}

async function saveChapterCache(translateDir: string, zipPath: string, xhtml: string): Promise<void> {
  const cacheDir = getChapterCacheDir(translateDir);
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = getChapterCachePath(translateDir, zipPath);
  const tmpPath = cachePath + '.tmp';
  await fs.writeFile(tmpPath, xhtml, 'utf-8');
  await fs.rename(tmpPath, cachePath);
}

async function loadChapterCache(translateDir: string, zipPath: string): Promise<string> {
  return fs.readFile(getChapterCachePath(translateDir, zipPath), 'utf-8');
}

async function deleteChapterCacheDir(translateDir: string): Promise<void> {
  try {
    // `stages/02-translate/chapter-cache` on the shared library: a chapter per
    // file, so it leaves by rename (library-trash.ts).
    await discardLibraryTree(getChapterCacheDir(translateDir), 'clearing the chapter cache');
  } catch {
    // Directory doesn't exist, that's fine
  }
}

/**
 * Validate that all cached chapter files exist for a checkpoint.
 * Returns false if any are missing (cache is corrupt/incomplete).
 */
async function validateChapterCache(translateDir: string, completedChapters: string[]): Promise<boolean> {
  for (const zipPath of completedChapters) {
    try {
      await fs.access(getChapterCachePath(translateDir, zipPath));
    } catch {
      return false;
    }
  }
  return true;
}

export interface MonoTranslationConfig {
  cleanedEpubPath?: string;  // Input EPUB path (from job.epubPath if not provided)
  sourceLang: string;        // Source language of the book
  targetLang: string;        // Target language (usually 'en')
  title?: string;
  /**
   * WHO TRANSLATES, as the one block every AI door in this app takes.
   *
   * It was five flat fields (`aiProvider`, `aiModel`, and one credential per
   * provider) and the caller expanded them into an `AiCallConfig` twice in this
   * file. `providerConfigOf` (electron/queue-steps/ai-provider.ts) is the ONE
   * mapping from a job's config to a provider block now, so a provider added
   * there — `crucible` was — reaches this pass without being taught to it
   * separately. It is also what carries the row's assigned MACHINE, which flat
   * fields had no room for.
   */
  provider: AIProviderConfig;
  translationPrompt?: string;
  customInstructions?: string;    // Additional instructions appended to the translation prompt
  /**
   * Where to write the translated EPUB, and the directory whose checkpoint and
   * chapter cache make the run resumable.
   *
   * The translate PASS sets this to its own numbered stage dir and then moves the
   * finished file onto the project's book EPUB, so the mono pipeline no longer
   * leaves a `stages/02-translate/translated.epub` for anything to find. Absent
   * keeps the legacy wizard's location.
   */
  outputEpubPath?: string;
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

  // Format paragraphs with <<<N>>> markers
  const formatted = formatNumberedParagraphs(paragraphs, startIndex);

  // Load the mono translation prompt if not provided
  let systemPrompt = config.translationPrompt;
  if (!systemPrompt) {
    systemPrompt = await loadPrompt(PROMPTS.MONO_TRANSLATION);
  }

  let prompt = `Translate the following paragraphs from ${sourceLanguage} to ${targetLanguage}.
Each paragraph is marked with <<<N>>>. Preserve these markers exactly.
Return ONLY the translated paragraphs with the same <<<N>>> markers. Do not add explanations.`;

  if (config.customInstructions) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${config.customInstructions}`;
  }

  prompt += `\n\n${formatted}`;

  const response = await callAI(prompt, config.provider, systemPrompt);

  // Parse the numbered response
  const { paragraphs: parsed } = parseNumberedParagraphs(response);
  const missing = validateNumberedParagraphs(parsed, paragraphs.length, startIndex);

  // Retry missing paragraphs individually
  for (const missingIdx of missing) {
    const originalIdx = missingIdx - startIndex;
    const originalText = paragraphs[originalIdx];
    console.log(`[MONO-TRANSLATION] Retrying missing paragraph ${missingIdx}: "${originalText.substring(0, 60)}..."`);

    let retryPrompt = `Translate the following paragraph from ${sourceLanguage} to ${targetLanguage}.
Return ONLY the translation, nothing else.`;

    if (config.customInstructions) {
      retryPrompt += `\n\nADDITIONAL INSTRUCTIONS:\n${config.customInstructions}`;
    }

    retryPrompt += `\n\n${originalText}`;

    const retryResponse = await callAI(retryPrompt, config.provider, systemPrompt);
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
 * Translate a list of chapter titles in a single AI call.
 * Used for nav.xhtml and toc.ncx entries.
 */
async function translateChapterTitles(
  titles: string[],
  config: MonoTranslationConfig
): Promise<string[]> {
  const sourceLanguage = LANGUAGE_NAMES[config.sourceLang] || config.sourceLang;
  const targetLanguage = LANGUAGE_NAMES[config.targetLang] || config.targetLang;

  const formatted = formatNumberedParagraphs(titles, 1);

  const prompt = `Translate the following chapter titles from ${sourceLanguage} to ${targetLanguage}.
Each title is marked with <<<N>>>. Preserve these markers exactly.
Return ONLY the translated titles with the same <<<N>>> markers. Do not add explanations.
Keep translations concise — these are chapter headings, not full sentences.

${formatted}`;

  const response = await callAI(prompt, config.provider);

  const { paragraphs: parsed } = parseNumberedParagraphs(response);

  // Assemble results in order, falling back to original if missing
  const results: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    const idx = i + 1;
    const translated = parsed.get(idx);
    if (translated && translated.length > 0) {
      results.push(translated);
    } else {
      console.warn(`[MONO-TRANSLATION] Title ${idx} missing from translation, keeping original: "${titles[i]}"`);
      results.push(titles[i]);
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
): Promise<TranslationJobResult> {
  /*
   * WHO RAN IT, read ONCE off the provider block.
   *
   * The checkpoint compares them to decide whether a resume is the same run,
   * the analytics record files them, and the log prints them — three readers
   * of one fact, which is three places for a second spelling of "which model"
   * to appear (crucible `docs/ARCHITECTURE.md` R1).
   */
  const providerName = config.provider.provider;
  const modelName = aiCallModel(config.provider);
  // The third reader of that one fact: WHICH MACHINE. Read here, beside the
  // provider and the model, for the reason above — the analytics record files
  // it and the log prints it, and two lookups is two places to drift.
  const serverName = aiCallServer(config.provider);
  console.log(`[MONO-TRANSLATION] Starting job ${jobId}`);
  console.log(`[MONO-TRANSLATION] Config:`, {
    cleanedEpubPath: config.cleanedEpubPath,
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
    aiProvider: providerName,
    aiModel: modelName,
    crucibleServer: serverName
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

  // Where the translation lands, and the directory its resume state lives in.
  // A caller that names the file owns both; otherwise it is the legacy wizard's
  // stages/02-translate/translated.epub.
  const outputEpubPath = config.outputEpubPath || path.join(projectDir, 'stages', '02-translate', 'translated.epub');
  const translateDir = path.dirname(outputEpubPath);
  await fs.mkdir(translateDir, { recursive: true });

  const tStartMs = Date.now();  // wall-clock start for the translation analytics record

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
    const zipReader = await openEpubSource(inputEpubPath);

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

    // ── Step 2.5: Load checkpoint & validate ────────────────────────────
    let completedZipPaths = new Set<string>();
    let paragraphsDone = 0;
    let resuming = false;

    const existingCheckpoint = await loadTranslationCheckpoint(translateDir);
    if (existingCheckpoint) {
      // Validate config matches
      const configMatch =
        existingCheckpoint.sourceEpubPath === inputEpubPath &&
        existingCheckpoint.sourceLang === config.sourceLang &&
        existingCheckpoint.targetLang === config.targetLang &&
        existingCheckpoint.aiProvider === providerName &&
        existingCheckpoint.aiModel === modelName;

      if (!configMatch) {
        console.log(`[MONO-TRANSLATION] Checkpoint config mismatch — starting fresh`);
        console.log(`[MONO-TRANSLATION]   checkpoint: ${existingCheckpoint.sourceLang}→${existingCheckpoint.targetLang} ${existingCheckpoint.aiProvider}/${existingCheckpoint.aiModel}`);
        console.log(`[MONO-TRANSLATION]   current:    ${config.sourceLang}→${config.targetLang} ${providerName}/${modelName}`);
        await deleteTranslationCheckpoint(translateDir);
        await deleteChapterCacheDir(translateDir);
      } else {
        // Validate that cached chapter files actually exist
        const cacheValid = await validateChapterCache(translateDir, existingCheckpoint.completedChapters);
        if (!cacheValid) {
          console.log(`[MONO-TRANSLATION] Checkpoint exists but cache files missing — starting fresh`);
          await deleteTranslationCheckpoint(translateDir);
          await deleteChapterCacheDir(translateDir);
        } else {
          // Resume from checkpoint
          completedZipPaths = new Set(existingCheckpoint.completedChapters);
          paragraphsDone = existingCheckpoint.completedParagraphCount;
          resuming = true;
          console.log(`[MONO-TRANSLATION] Resuming: ${completedZipPaths.size}/${chapterDataList.length} chapters done, ${paragraphsDone}/${totalParagraphs} paragraphs`);
        }
      }
    }

    // ── Step 3: Translate paragraphs chapter by chapter ─────────────────
    if (resuming) {
      const pct = 10 + Math.round((paragraphsDone / totalParagraphs) * 80);
      sendProgress(mainWindow, jobId, {
        phase: 'translating',
        currentSentence: paragraphsDone,
        totalSentences: totalParagraphs,
        percentage: Math.min(pct, 90),
        message: `Resuming translation: ${paragraphsDone}/${totalParagraphs} paragraphs already done`
      });
    } else {
      sendProgress(mainWindow, jobId, {
        phase: 'translating',
        currentSentence: 0,
        totalSentences: totalParagraphs,
        percentage: 10,
        message: `Translating ${totalParagraphs} paragraphs...`
      });
    }

    for (const chData of chapterDataList) {
      // Skip chapters already completed in a previous run
      if (completedZipPaths.has(chData.zipPath)) {
        continue;
      }

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

      // Replace any [SKIP] markers with the original paragraph text
      // The AI may return [SKIP] for paragraphs it refuses to translate —
      // we must substitute the original text so markers never reach the EPUB.
      for (let i = 0; i < translated.length; i++) {
        if (isSkip(translated[i]) && i < chData.paragraphs.length) {
          translated[i] = chData.paragraphs[i];
        }
      }

      // Replace block texts in original XHTML (preserves structure, CSS, etc.)
      let modifiedXhtml = replaceBlockTexts(chData.xhtml, translated);

      // Update xml:lang on translated chapters
      const $ = cheerio.load(modifiedXhtml, { xmlMode: true });
      $('html').attr('xml:lang', config.targetLang);
      $('html').attr('lang', config.targetLang);
      modifiedXhtml = $.xml();

      // Cache translated chapter to disk and update checkpoint
      await saveChapterCache(translateDir, chData.zipPath, modifiedXhtml);
      completedZipPaths.add(chData.zipPath);

      await saveTranslationCheckpoint(translateDir, {
        version: 1,
        sourceEpubPath: inputEpubPath,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        aiProvider: providerName,
        aiModel: modelName,
        totalChapters: chapterDataList.length,
        totalParagraphs,
        completedChapters: Array.from(completedZipPaths),
        completedParagraphCount: paragraphsDone,
        updatedAt: new Date().toISOString(),
      });
    }

    // ── Step 3.5: Translate navigation document titles ──────────────────
    sendProgress(mainWindow, jobId, {
      phase: 'translating',
      currentSentence: totalParagraphs,
      totalSentences: totalParagraphs,
      percentage: 92,
      message: 'Translating chapter titles...'
    });

    // Map of ZIP entry path → translated content for nav/toc files
    const translatedNavFiles = new Map<string, Buffer>();

    // Translate nav.xhtml (EPUB 3 table of contents)
    if (structure.navPath) {
      try {
        const navBuffer = await zipReader.readEntry(structure.navPath);
        const navXml = navBuffer.toString('utf8');
        const $nav = cheerio.load(navXml, { xmlMode: true });

        // Collect all anchor texts from navigation
        const navTexts: string[] = [];
        const navAnchors: any[] = [];
        $nav('nav a, a').each((_, el) => {
          const text = $nav(el).text().trim();
          if (text.length > 0) {
            navTexts.push(text);
            navAnchors.push($nav(el));
          }
        });

        if (navTexts.length > 0) {
          console.log(`[MONO-TRANSLATION] Translating ${navTexts.length} navigation titles`);
          const translatedTitles = await translateChapterTitles(navTexts, config);
          for (let i = 0; i < navAnchors.length; i++) {
            if (i < translatedTitles.length && translatedTitles[i].length > 0) {
              navAnchors[i].text(translatedTitles[i]);
            }
          }
          // Update xml:lang
          $nav('html').attr('xml:lang', config.targetLang);
          $nav('html').attr('lang', config.targetLang);
          translatedNavFiles.set(structure.navPath, Buffer.from($nav.xml(), 'utf8'));
        }
      } catch (err) {
        console.warn(`[MONO-TRANSLATION] Could not translate nav.xhtml:`, err);
      }
    }

    // Translate toc.ncx (EPUB 2 table of contents)
    if (structure.ncxPath) {
      try {
        const ncxBuffer = await zipReader.readEntry(structure.ncxPath);
        const ncxXml = ncxBuffer.toString('utf8');
        const $ncx = cheerio.load(ncxXml, { xmlMode: true });

        // Collect all navLabel text elements
        const ncxTexts: string[] = [];
        const ncxTextEls: any[] = [];
        $ncx('navLabel text, navlabel text').each((_, el) => {
          const text = $ncx(el).text().trim();
          if (text.length > 0) {
            ncxTexts.push(text);
            ncxTextEls.push($ncx(el));
          }
        });

        if (ncxTexts.length > 0) {
          console.log(`[MONO-TRANSLATION] Translating ${ncxTexts.length} NCX titles`);
          const translatedTitles = await translateChapterTitles(ncxTexts, config);
          for (let i = 0; i < ncxTextEls.length; i++) {
            if (i < translatedTitles.length && translatedTitles[i].length > 0) {
              ncxTextEls[i].text(translatedTitles[i]);
            }
          }
          translatedNavFiles.set(structure.ncxPath, Buffer.from($ncx.xml(), 'utf8'));
        }
      } catch (err) {
        console.warn(`[MONO-TRANSLATION] Could not translate toc.ncx:`, err);
      }
    }

    // ── Step 4: Write new EPUB from cache ────────────────────────────────
    sendProgress(mainWindow, jobId, {
      phase: 'epub',
      currentSentence: totalParagraphs,
      totalSentences: totalParagraphs,
      percentage: 95,
      message: 'Writing translated EPUB...'
    });

    const zipWriter = await createEpubSink(outputEpubPath, 'zip');
    const allEntries = zipReader.getEntries();

    for (const file of allEntries) {
      if (completedZipPaths.has(file)) {
        // Read translated XHTML from chapter cache
        const cachedXhtml = await loadChapterCache(translateDir, file);
        zipWriter.addFile(file, Buffer.from(cachedXhtml, 'utf8'));
      } else if (translatedNavFiles.has(file)) {
        // Use translated navigation document
        zipWriter.addFile(file, translatedNavFiles.get(file)!);
      } else {
        const content = await zipReader.readEntry(file);
        zipWriter.addFile(file, content);
      }
    }

    zipReader.close();
    processor.close();

    // The sink lands its own container — `ZipWriter.write` already stages beside
    // the target and renames on. The `outputEpubPath + '.tmp'` that stood here
    // was a second staging on top of that, under a name that claims a container
    // the sink is no longer obliged to produce.
    await zipWriter.write(outputEpubPath);

    // Merge fragmented paragraphs in translated EPUB
    await mergeEpubParagraphs(outputEpubPath);

    // Clean up checkpoint and cache after successful write
    await deleteTranslationCheckpoint(translateDir);
    await deleteChapterCacheDir(translateDir);

    console.log(`[MONO-TRANSLATION] Generated translated EPUB: ${outputEpubPath}`);

    sendProgress(mainWindow, jobId, {
      phase: 'complete',
      currentSentence: totalParagraphs,
      totalSentences: totalParagraphs,
      percentage: 100,
      message: 'Translation complete'
    });

    const tDuration = Math.round((Date.now() - tStartMs) / 1000);
    const tMinutes = tDuration / 60;
    return {
      success: true,
      outputPath: outputEpubPath,
      translatedEpubPath: outputEpubPath,
      analytics: {
        jobId,
        startedAt: new Date(tStartMs).toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: tDuration,
        totalSentences: totalParagraphs,
        sentencesPerMinute: tMinutes > 0 ? Math.round((totalParagraphs / tMinutes) * 10) / 10 : 0,
        provider: providerName,
        model: modelName,
        // WHICH MACHINE produced `sentencesPerMinute` above. `undefined` keeps
        // it off the record entirely on the local arm, where absent already
        // means "not known".
        crucibleServer: serverName ?? undefined,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        mode: 'mono',
        success: true,
        outputPath: outputEpubPath,
      }
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

    /*
     * THE HOLDER'S LINE IS CARRIED, NOT FLATTENED AWAY.
     *
     * A `CrucibleTextActError` for `crucible_model_leased` or
     * `crucible_server_busy` is a WAIT, and `busyLine` is the whole of what
     * makes it one to the queue. Rebuilding the answer as `{success, error}`
     * dropped it here — the message survived, the parkability did not — so a
     * translate against a busy server reddened its row while a simplify
     * against the same server parked. Read off the typed error rather than
     * duck-typed off `unknown`: this path has one class that carries it.
     */
    return {
      success: false,
      error: (err as Error).message,
      ...(err instanceof CrucibleTextActError && err.busyLine !== undefined
        ? { busyLine: err.busyLine }
        : {}),
    };
  }
}

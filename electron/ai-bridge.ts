/**
 * AI Bridge - Multi-provider AI wrapper for text cleanup
 *
 * Supports multiple AI providers:
 * - Ollama (local, free) at localhost:11434
 * - Claude (Anthropic API)
 * - OpenAI (ChatGPT API)
 */

import { BrowserWindow, powerSaveBlocker } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';

// Power save blocker ID - prevents system sleep during AI cleanup
let aiPowerBlockerId: number | null = null;

/**
 * Start preventing system sleep (call when AI cleanup starts)
 */
function startAIPowerBlock(): void {
  if (aiPowerBlockerId === null) {
    aiPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[AI-BRIDGE] Power save blocker started (ID:', aiPowerBlockerId, ')');
  }
}

/**
 * Stop preventing system sleep (call when AI cleanup completes)
 */
function stopAIPowerBlock(): void {
  if (aiPowerBlockerId !== null) {
    powerSaveBlocker.stop(aiPowerBlockerId);
    console.log('[AI-BRIDGE] Power save blocker stopped');
    aiPowerBlockerId = null;
  }
}
import {
  extractChapterAsText,
  splitTextIntoParagraphs,
  extractBlockTextsWithTags
} from './epub-processor.js';
import {
  startDiffCache,
  resumeDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';
import { getOllamaThinkFields } from './ollama-capabilities.js';
import {
  normalizeQuotes,
  extractHyphenPairs,
  applyHyphenJoins,
  detectFootnotes,
  scanDamagedWords,
  buildFewShotBlock,
  applyEditList,
  firstJsonObject,
  scoreFootnoteCandidates,
  selectFootnoteDeletions,
  pickObservationWindow,
  type FootnoteObservation,
  type HyphenVerdict,
} from './ai-cleanup-prepass.js';


// ─────────────────────────────────────────────────────────────────────────────
// Ollama Context Sizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the num_ctx needed for an Ollama request.
 * Without this, Ollama allocates the model's full context window (e.g. 131K for cogito)
 * which wastes tens of GB of KV cache memory. Even generous estimates here are a fraction
 * of that. Uses 3 chars/token ratio with 1.5x headroom on top.
 *
 * Two constraints shape the final value:
 *  - Bucketing to NUM_CTX_BUCKET (4096): Ollama fully reloads the entire model whenever
 *    num_ctx changes, even by one token. A 19 GB model reloads in ~18s, so per-chunk
 *    estimates that each land on a slightly different value cause relentless reload churn.
 *    Rounding up to coarse 4096-token buckets makes consecutive chunks of similar size land
 *    on the SAME num_ctx, so Ollama reuses the already-loaded runner instead of reloading.
 *  - Capping at numCtxMaxForModel(model): the model's weights plus KV cache must fit
 *    alongside the desktop on a 24 GB card — see numCtxMaxForModel for the size-tiered
 *    ceilings. When the padded estimate exceeds the cap it is clamped; the output-length
 *    safeguard (>=70% check with retry/split, below) handles any truncated generation, and
 *    the estimate is double-padded anyway (output budgeted at 2x input, then x1.5 headroom),
 *    so a realistic 8000-char chunk needs only ~6K tokens.
 */
export function estimateNumCtx(systemPrompt: string, inputText: string, outputMultiplier: number, model: string): number {
  const CHARS_PER_TOKEN = 3;
  // Bucket so similar-sized chunks reuse the loaded runner (Ollama reloads on any change).
  const NUM_CTX_BUCKET = 4096;
  const systemTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const inputTokens = Math.ceil(inputText.length / CHARS_PER_TOKEN);
  const outputTokens = inputTokens * outputMultiplier;
  const raw = Math.ceil((systemTokens + inputTokens + outputTokens + 512) * 1.5);
  const bucketed = Math.max(NUM_CTX_BUCKET, Math.ceil(raw / NUM_CTX_BUCKET) * NUM_CTX_BUCKET);
  return Math.min(numCtxMaxForModel(model), bucketed);
}

/**
 * num_ctx for a call whose OUTPUT is a fixed `numPredict` budget rather than
 * ~2x the input (the edit-list / observation planning calls: tiny user turn, large
 * fixed generation incl. in-band thinking). estimateNumCtx would size the window to
 * the tiny input and clip the generation into a REASONING_OVERRUN; this sizes it to
 * system + input + numPredict so the whole answer fits (still GPU-capped).
 */
export function estimateNumCtxForBudget(systemPrompt: string, inputText: string, numPredict: number, model: string): number {
  const CHARS_PER_TOKEN = 3;
  const NUM_CTX_BUCKET = 4096;
  const sys = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN);
  const inp = Math.ceil(inputText.length / CHARS_PER_TOKEN);
  const raw = Math.ceil((sys + inp + numPredict + 512) * 1.2);
  const bucketed = Math.max(NUM_CTX_BUCKET, Math.ceil(raw / NUM_CTX_BUCKET) * NUM_CTX_BUCKET);
  return Math.min(numCtxMaxForModel(model), bucketed);
}

/**
 * Derive the num_ctx ceiling from the model's parameter count, sniffed from the
 * tag (e.g. 'cogito:14b', 'qwen3:32b', 'llama3.1:8b-instruct-q4_K_M'; MoE tags
 * like 'mixtral:8x7b' count experts × size).
 *
 * The ceiling exists so weights + KV cache stay fully on a 24 GB GPU — once a
 * layer spills to CPU, every token bottlenecks on it:
 *  - ≤15B (14b-class and smaller): Q4_K_M weights are ≤ ~9.5 GiB, leaving room
 *    for a taller KV cache, so allow 16384 tokens (~4 GiB of f16 KV).
 *  - Larger (32B-class) OR unrecognized size: keep the 12288 ceiling tuned for
 *    32B Q4_K_M (~18.5 GiB weights + ~3 GiB KV). Treating an unknown size as
 *    32B-class is a deliberate conservative choice — the cost of guessing too
 *    low is a rare clamped estimate (caught by the output-length safeguard),
 *    while guessing too high spills layers to CPU and cripples the whole job.
 */
export function numCtxMaxForModel(model: string): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(model);
  const dense = /(\d+(?:\.\d+)?)b/i.exec(model);
  const sizeB = moe
    ? parseInt(moe[1], 10) * parseFloat(moe[2])
    : dense
      ? parseFloat(dense[1])
      : null;
  if (sizeB !== null && sizeB <= 15) return 16384;
  return 12288;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AIProvider = 'ollama' | 'claude' | 'openai' | 'local';

export interface AIProviderConfig {
  provider: AIProvider;
  ollama?: {
    baseUrl: string;
    model: string;
  };
  claude?: {
    apiKey: string;
    model: string;
  };
  openai?: {
    apiKey: string;
    model: string;
  };
  // Bundled llama.cpp. The active model is chosen in AI Setup and resolved by
  // llama-bridge; `model` here is informational only.
  local?: {
    model?: string;
  };
}

export interface ProviderConnectionResult {
  available: boolean;
  error?: string;
  models?: string[];
}

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

export interface CleanupProgress {
  chapterId: string;
  chapterTitle: string;
  currentChunk: number;
  totalChunks: number;
  percentage: number;
}

export interface CleanupResult {
  success: boolean;
  cleanedText?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup Checkpoint (resume support)
// ─────────────────────────────────────────────────────────────────────────────

interface CleanupCheckpoint {
  version: number;
  sourceEpubPath: string;
  outputFilename: string;
  totalChapters: number;
  totalChunks: number;
  completedChapters: string[];
  completedChunkCount: number;
  provider: string;
  model: string;
  simplifyForChildren: boolean;
  updatedAt: string;
}

function getCheckpointPath(outputDir: string): string {
  return path.join(outputDir, 'cleanup-progress.json');
}

async function loadCheckpoint(outputDir: string): Promise<CleanupCheckpoint | null> {
  try {
    const data = await fsPromises.readFile(getCheckpointPath(outputDir), 'utf-8');
    const checkpoint = JSON.parse(data) as CleanupCheckpoint;
    if (checkpoint.version !== 1) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

async function saveCheckpoint(outputDir: string, checkpoint: CleanupCheckpoint): Promise<void> {
  const checkpointPath = getCheckpointPath(outputDir);
  const tmpPath = checkpointPath + '.tmp';
  await fsPromises.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  await fsPromises.rename(tmpPath, checkpointPath);
}

async function deleteCheckpoint(outputDir: string): Promise<void> {
  try {
    await fsPromises.unlink(getCheckpointPath(outputDir));
  } catch {
    // File doesn't exist, that's fine
  }
}

function getProviderModel(config: AIProviderConfig): string {
  if (config.provider === 'ollama') return config.ollama?.model || 'unknown';
  if (config.provider === 'claude') return config.claude?.model || 'unknown';
  if (config.provider === 'openai') return config.openai?.model || 'unknown';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'cogito:14b';
const CHUNK_SIZE = 8000; // characters per chunk

// Skipped chunk tracking (reset at start of each cleanup job)
export interface SkippedChunk {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number (e.g., "Chunk 5/121")
  totalChunks: number;         // Total chunks in the job
  reason: 'copyright' | 'content-skip' | 'ai-refusal' | 'truncated' | 'error' | 'repetition' | 'reasoning-overrun' | 'edit-parse-fail' | 'acceptance-gate';
  text: string;           // The original text that was skipped
  aiResponse?: string;    // What the AI actually returned (for debugging)
}

/**
 * Per-job cleanup accounting. Previously these were module-level globals, which
 * were only safe while exactly one cleanup job ran at a time. The queue can now
 * run two AI jobs concurrently (a cloud Claude/OpenAI job in its own lane
 * alongside a GPU/Ollama job), so a single job MUST own its own counters and
 * skipped-chunk list — a shared global would cross-contaminate the two jobs'
 * skip reports and fallback thresholds. One instance is created per cleanupEpub
 * call and threaded through cleanChunkWithProvider → applyOutputSafeguards.
 */
export interface CleanupJobState {
  copyrightFallbackCount: number;  // Chunks that fell back due to a copyright refusal
  skipFallbackCount: number;       // Chunks where AI returned [SKIP] for non-trivial content
  markerMismatchCount: number;     // Chunks where AI dropped/added [[BLOCK]] markers (legacy report field)
  truncatedFallbackCount: number;  // Chunks where AI returned <70% of input (non-copyright)
  errorFallbackCount: number;      // Chunks where the AI request itself failed (network/HTTP/hung server)
  repetitionFallbackCount: number; // Chunks that degenerated into a repetition loop even after a retry
  skippedChunks: SkippedChunk[];   // Detailed tracking of all skipped chunks
  editLog: EditLogEntry[];         // Per-edit disposition log for the edit-list cleanup pass
}

/**
 * One entry in the edit-list cleanup pass's per-job audit trail. Every edit the
 * model proposed is recorded with its verbatim find/replace and the applier's
 * disposition (APPLIED / FOUND_FUZZY / MULTI / NOT_FOUND / a blocked category), so
 * a failed or rejected edit is silently correct (original text stands) but never
 * invisible. Chunk-level parse failures are recorded with status 'CHUNK_PARSE_FAIL'.
 * Written to edit-log.json next to skipped-chunks.json.
 */
export interface EditLogEntry {
  chapterTitle: string;
  overallChunkNumber: number;
  status: string;          // EditStatus from ai-cleanup-prepass, or 'CHUNK_PARSE_FAIL'
  find?: string;
  replace?: string;
  count?: number;
  span?: string;
  detail?: string;         // for CHUNK_PARSE_FAIL: why it failed
}

export function newCleanupJobState(): CleanupJobState {
  return {
    copyrightFallbackCount: 0,
    skipFallbackCount: 0,
    markerMismatchCount: 0,
    truncatedFallbackCount: 0,
    errorFallbackCount: 0,
    repetitionFallbackCount: 0,
    skippedChunks: [],
    editLog: [],
  };
}
const CHUNK_SEARCH_WINDOW = 1000; // characters to search for logical break point
const TIMEOUT_MS = 180000; // 3 minutes per chunk
const OLLAMA_INACTIVITY_TIMEOUT_MS = 300000; // Abort if Ollama sends no data for 5 minutes (covers model load + prompt eval; healthy generation streams tokens continuously)
const MAX_FALLBACK_COUNT = 10;  // Abort job if this many chunks fall back to original text
// Below this size a chunk that the AI skipped/refused/truncated is no longer
// split further — it's registered as a skipped chunk and the original is kept.
// Above it, the unified safeguards split in half and retry (smaller chunks are
// less likely to be refused/truncated). 8000-char chunks cascade 8k→4k→2k.
const MIN_SPLIT_SIZE = 2000;
const TRUNCATION_RETRY_REMINDER = 'IMPORTANT REMINDER: You must return ALL of the text content. Do not summarize, condense, or skip sections. Minor length reduction from removing artifacts is fine, but the full text must be preserved.\n\n';
const REPETITION_RETRY_REMINDER = 'IMPORTANT: Your previous attempt at this exact text got stuck in a loop, repeating the same sentence over and over and deleting the real content that followed it. This is a critical failure. Process the text below ONCE, top to bottom. Never repeat a sentence that is not repeated in the source. Preserve every distinct original sentence in its original order.\n\n';

// ─────────────────────────────────────────────────────────────────────────────
// Repetition / degeneration guard
//
// A cleanup model can fall into an autoregressive repetition loop: it emits one
// sentence, then re-emits it indefinitely, spending its whole output budget on
// the loop and dropping the real text that should have followed. The length
// checks miss this because a loop produces MORE text, not less. detectRepetition
// catches it after generation so the chunk can be retried (and, if it still
// loops, fall back to the untouched source rather than ship corrupted text).
// ─────────────────────────────────────────────────────────────────────────────

const REPETITION_MIN_SENTENCE_CHARS = 15;   // ignore tiny fragments ("Yes.", "OK.") that legitimately repeat
const REPETITION_RUN_THRESHOLD = 4;         // N identical sentences in a row = a loop
const REPETITION_TOTAL_THRESHOLD = 6;       // a single sentence appearing this many times overall...
const REPETITION_COVERAGE_THRESHOLD = 0.30; // ...AND dominating this fraction of the chunk = a loop

/** Normalize a sentence for repetition comparison (case/space/trailing-punct insensitive). */
function normalizeForRepetition(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:"'‘’“”—–\-\s]+$/, '')
    .trim();
}

/**
 * Detect a repetition/degeneration loop in cleaned output.
 * Returns { repeated: true, detail } if the text is degenerate, else { repeated: false }.
 *
 * Two signals, either of which trips it:
 *  1) A run of >= REPETITION_RUN_THRESHOLD consecutive identical non-trivial sentences.
 *  2) A single non-trivial sentence that appears >= REPETITION_TOTAL_THRESHOLD times
 *     AND makes up >= REPETITION_COVERAGE_THRESHOLD of all sentences (non-consecutive collapse).
 */
export function detectRepetition(output: string): { repeated: boolean; detail?: string } {
  if (!output) return { repeated: false };

  // Split into sentences on sentence-ending punctuation followed by whitespace.
  const sentences = output
    .split(/(?<=[.!?…])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (sentences.length < REPETITION_RUN_THRESHOLD) return { repeated: false };

  const norm = sentences.map(normalizeForRepetition);

  // Signal 1: longest run of consecutive identical, non-trivial sentences.
  let runStart = 0;
  for (let i = 1; i <= norm.length; i++) {
    const same = i < norm.length && norm[i] === norm[runStart];
    if (!same) {
      const runLen = i - runStart;
      if (runLen >= REPETITION_RUN_THRESHOLD && norm[runStart].length >= REPETITION_MIN_SENTENCE_CHARS) {
        return {
          repeated: true,
          detail: `"${sentences[runStart].slice(0, 60)}…" repeated ${runLen}× in a row`,
        };
      }
      runStart = i;
    }
  }

  // Signal 2: one sentence dominating the chunk even if not perfectly consecutive.
  const counts = new Map<string, number>();
  for (const n of norm) {
    if (n.length >= REPETITION_MIN_SENTENCE_CHARS) {
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  for (const [n, c] of counts) {
    if (c >= REPETITION_TOTAL_THRESHOLD && c / norm.length >= REPETITION_COVERAGE_THRESHOLD) {
      return {
        repeated: true,
        detail: `one sentence appears ${c}× (${Math.round((c / norm.length) * 100)}% of the chunk)`,
      };
    }
  }

  return { repeated: false };
}

/**
 * Get total number of chunks that fell back to original text (all failure types)
 */
function getTotalFallbackCount(state: CleanupJobState): number {
  return state.copyrightFallbackCount + state.skipFallbackCount + state.truncatedFallbackCount + state.errorFallbackCount + state.repetitionFallbackCount;
}

/**
 * Check if we've exceeded the max fallback threshold
 * Throws an error to abort the job if too many chunks have failed
 */
function checkFallbackThreshold(state: CleanupJobState): void {
  const totalFallbacks = getTotalFallbackCount(state);
  if (totalFallbacks >= MAX_FALLBACK_COUNT) {
    throw new Error(`TOO_MANY_FALLBACKS: ${totalFallbacks} chunks fell back to original text (threshold: ${MAX_FALLBACK_COUNT}). Aborting cleanup to prevent poor quality output.`);
  }
}

// Markers that indicate the AI couldn't process the text
const SKIP_MARKERS = ['[SKIP]', '[NO READABLE TEXT]', '[NOTHING TO CLEAN]'];

// Patterns that indicate AI went into conversational mode instead of processing text
const AI_ASSISTANT_PATTERNS = [
  /^(here is|here's) (the|your)/i,
  /^(i'll|i will|i can|i'd be) (help|assist|happy|glad)/i,
  /^(could you|can you|please provide|please paste)/i,
  /^(it seems|it appears|it looks like) (there is no|like there's no|you haven't)/i,
  /^(i don't see|i cannot see|there is no|there's no) (any )?(text|content)/i,
  /^(let me|allow me) (help|assist|know)/i,
  /\bplease (provide|share|paste|send)\b/i,
  /\bi('d| would) be happy to\b/i,
  /\bno (text|content) (was |has been )?(provided|given|shared)\b/i,
];

/**
 * Check if a single paragraph is a skip marker.
 */
function isSkipMarker(text: string): boolean {
  const trimmed = text.trim();
  return SKIP_MARKERS.some(m => trimmed === m || trimmed.startsWith(m));
}

/**
 * Replace per-paragraph SKIP markers with the original prose, scoped to a single
 * prose segment. When the AI returns [SKIP] for an individual paragraph inside an
 * otherwise-cleaned chunk, the original text is restored — not the marker itself.
 *
 * Scoped to a segment's ORIGINAL text (not the whole chapter): headings are no
 * longer part of the cleaned output, so aligning cleaned paragraphs against the
 * whole-chapter text (which still contains heading blocks) would mis-count. The
 * per-segment original paragraphs are the correct alignment target.
 */
function replaceSkipMarkersForProse(cleanedParagraphs: string[], originalProseText: string): string[] {
  // Quick check: any SKIP markers?
  if (!cleanedParagraphs.some(p => isSkipMarker(p))) return cleanedParagraphs;

  const originalParagraphs = splitTextIntoParagraphs(originalProseText);

  // If counts match, do 1-to-1 substitution
  if (cleanedParagraphs.length === originalParagraphs.length) {
    return cleanedParagraphs.map((p, i) =>
      isSkipMarker(p) ? originalParagraphs[i] : p
    );
  }

  // Counts don't match — filter out SKIP markers entirely rather than
  // inserting misaligned original text. The content is already in the
  // other cleaned paragraphs that the AI successfully processed.
  console.warn(`[AI-CLEANUP] Removing ${cleanedParagraphs.filter(p => isSkipMarker(p)).length} SKIP markers (prose paragraph count mismatch: ${cleanedParagraphs.length} cleaned vs ${originalParagraphs.length} original)`);
  return cleanedParagraphs.filter(p => !isSkipMarker(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Heading-preserving segmentation (AI cleanup)
//
// AI cleanup must preserve EVERY <h1>-<h6> heading verbatim — its tag, level, and
// text — because the downstream TTS pipeline (ebook2audiobook) relies on heading
// tags to voice titles exactly once with the right pauses. In the flattened-OCR
// workflow the headings are the ONLY document structure left in the exported EPUB,
// so the model must never see or rewrite heading text.
//
// Strategy: structural segmentation, NOT sentinel tokens (an LLM can silently drop
// or mangle a sentinel). Split each chapter into ordered segments at heading
// boundaries; chunk and clean ONLY the prose segments; on reassembly re-attach the
// original heading elements verbatim, interleaved back between the cleaned prose in
// original document order.
// ─────────────────────────────────────────────────────────────────────────────

/** One cleanup chunk of prose text (contains no headings). */
interface ProseChunk { text: string; }

/** An ordered piece of a chapter: a preserved heading, or a run of prose. */
type ChapterSegment =
  | { kind: 'heading'; tag: string; text: string }
  | { kind: 'prose'; text: string };

/** True for the tag names h1..h6. */
function isHeadingTag(tag: string): boolean {
  return /^h[1-6]$/.test(tag);
}

/**
 * Split a chapter's XHTML into ordered heading / prose segments.
 *
 * Consecutive non-heading blocks are joined (with blank lines) into a single prose
 * segment — the same text extractChapterAsText would emit for those blocks — so a
 * heading always sits on a segment boundary and NO cleanup chunk can ever span
 * across a heading.
 */
function segmentChapter(xhtml: string): ChapterSegment[] {
  const blocks = extractBlockTextsWithTags(xhtml);
  const segments: ChapterSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: 'prose', text: prose.join('\n\n') });
      prose = [];
    }
  };

  for (const block of blocks) {
    if (isHeadingTag(block.tagName)) {
      flushProse();
      segments.push({ kind: 'heading', tag: block.tagName, text: block.text });
    } else {
      prose.push(block.text);
    }
  }
  flushProse();
  return segments;
}

/**
 * Deterministic prose chunker. Hoisted out of cleanupEpub's former inner splitter
 * so the pre-scan, the worker queue, and reassembly all chunk PROSE identically
 * (reassembly recomputes per-segment chunk counts and must agree exactly). Packs
 * paragraphs up to CHUNK_SIZE, hard-splitting any single oversized paragraph at the
 * best available boundary (paragraph > sentence > word).
 */
function splitProseIntoChunks(text: string, chunkSize: number = CHUNK_SIZE): ProseChunk[] {
  const chunks: ProseChunk[] = [];

  const hardSplit = (piece: string) => {
    let rest = piece;
    while (rest.length > chunkSize) {
      let end = findBestBreakPoint(rest, chunkSize, 0);
      if (end <= 0 || end > rest.length) end = chunkSize; // guarantee progress
      const head = rest.slice(0, end).trim();
      if (head) chunks.push({ text: head });
      rest = rest.slice(end);
    }
    const tail = rest.trim();
    if (tail) chunks.push({ text: tail });
  };

  if (text.length <= chunkSize) {
    if (text.trim()) chunks.push({ text });
    return chunks;
  }

  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';
  for (const para of paragraphs) {
    // A single paragraph larger than chunkSize can't be packed — flush what we
    // have and hard-split it so no chunk ever exceeds chunkSize.
    if (para.length > chunkSize) {
      if (currentChunk) { chunks.push({ text: currentChunk }); currentChunk = ''; }
      hardSplit(para);
      continue;
    }
    const wouldBe = currentChunk ? currentChunk + '\n\n' + para : para;
    if (wouldBe.length > chunkSize && currentChunk) {
      chunks.push({ text: currentChunk });
      currentChunk = para;
    } else {
      currentChunk = wouldBe;
    }
  }
  if (currentChunk) chunks.push({ text: currentChunk });
  return chunks;
}

/**
 * The flat, heading-free chunk list for a chapter, in document order. Headings
 * contribute NO chunks, and because prose is chunked per-segment a chunk never
 * crosses a heading boundary. This is what the model sees.
 */
function chunkChapterProse(xhtml: string, chunkSize: number = CHUNK_SIZE, preprocess?: (proseText: string) => string): ProseChunk[] {
  const chunks: ProseChunk[] = [];
  for (const seg of segmentChapter(xhtml)) {
    if (seg.kind === 'prose') {
      // Deterministic pre-passes (footnote removal → hyphen joins → quote norm) run
      // HERE, before chunking, so the model sees repaired prose. The SAME preprocess
      // is threaded into rebuildChapterPreservingHeadings so its recomputed chunk
      // layout matches — otherwise reassembly would mis-count and mis-attach headings.
      const proseText = preprocess ? preprocess(seg.text) : seg.text;
      for (const chunk of splitProseIntoChunks(proseText, chunkSize)) chunks.push(chunk);
    }
  }
  return chunks;
}

/**
 * Normalize a heading's text for TTS: strip trailing punctuation/whitespace and
 * append a single period so the TTS engine inserts a pause after the title. This
 * is the long-standing heading behavior, now applied to EVERY heading.
 */
function normalizeHeadingForTts(text: string): string {
  let t = text.replace(/[.!?:;\s]+$/g, '').trim();
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/**
 * Rebuild a chapter's XHTML from the model's cleaned prose chunks, re-attaching
 * EVERY original heading verbatim (tag + level + text) in document order.
 *
 * `cleanedChunkTexts` is the flat, in-order list of cleaned prose chunks for the
 * chapter — one entry per chunk that chunkChapterProse produced. The segment layout
 * is recomputed from the ORIGINAL xhtml (deterministic: identical chunker on
 * identical input), and the cleaned chunks are sliced back onto their prose segments
 * with headings interleaved between them.
 *
 * No-fallback contract:
 *  - If more cleaned chunks remain than the recomputed layout can hold, the layout
 *    and the produced chunks disagree — a real misalignment bug — so we THROW rather
 *    than silently mis-attach a heading.
 *  - Running SHORT (cleaned chunks exhausted before the layout ends) is tolerated
 *    ONLY because test mode intentionally truncates a chapter's chunk list; in that
 *    case the untouched tail was never processed and is simply omitted.
 *  - A chapter with no <body> can't be reassembled — that is surfaced as an error,
 *    never silently passed through.
 */
function rebuildChapterPreservingHeadings(originalXhtml: string, cleanedChunkTexts: string[], chunkSize: number = CHUNK_SIZE, preprocess?: (proseText: string) => string): string {
  const segments = segmentChapter(originalXhtml);
  const bodyParts: string[] = [];
  let idx = 0;
  // Normalized text of the heading immediately preceding the next prose segment,
  // used to strip an echoed title from the start of that prose (see below).
  let pendingHeadingNorm: string | null = null;

  for (const seg of segments) {
    if (seg.kind === 'heading') {
      const headingText = normalizeHeadingForTts(seg.text);
      if (headingText) {
        bodyParts.push(`<${seg.tag}>${escapeXmlLocal(headingText)}</${seg.tag}>`);
        pendingHeadingNorm = seg.text.replace(/[.!?:;\s]+$/g, '').toLowerCase().trim() || null;
      }
      continue;
    }

    // Prose segment — consume exactly the chunks it originally produced. Apply the
    // SAME preprocess the chunker used so the recomputed count matches (see chunkChapterProse).
    const segChunkCount = splitProseIntoChunks(preprocess ? preprocess(seg.text) : seg.text, chunkSize).length;
    if (segChunkCount === 0) { pendingHeadingNorm = null; continue; }

    const available = cleanedChunkTexts.length - idx;
    if (available <= 0) {
      // Cleaned chunks exhausted before the layout ended: test-mode truncation.
      // The remaining segments were never processed — stop emitting.
      break;
    }
    const take = Math.min(segChunkCount, available);
    const slice = cleanedChunkTexts.slice(idx, idx + take);
    idx += take;

    // Join this segment's cleaned chunks and split back into paragraphs.
    let paragraphs = splitTextIntoParagraphs(slice.join('\n\n'));
    // Per-paragraph SKIP markers → restore THIS segment's original paragraphs.
    paragraphs = replaceSkipMarkersForProse(paragraphs, seg.text);

    // Echo-strip (generalized per segment): if the model echoed the preceding
    // heading's text at the start of the first prose paragraph, drop that
    // duplication — the heading is already re-attached above, so keeping it would
    // voice the title twice.
    if (pendingHeadingNorm && paragraphs.length > 0) {
      const first = paragraphs[0].trim();
      const firstNorm = first.toLowerCase();
      // Word-boundary guard: the character right after the matched title must be
      // punctuation/whitespace (or end of paragraph). Without it a heading like
      // "Hitler" would mangle prose that legitimately starts "Hitler's motorcade…"
      // into "'s motorcade…".
      const after = first.charAt(pendingHeadingNorm.length);
      if (firstNorm.startsWith(pendingHeadingNorm) && (!after || /[\s.!?:;,—–-]/.test(after))) {
        const remainder = first.substring(pendingHeadingNorm.length).replace(/^[.!?:;,—–\s-]+/, '').trim();
        if (remainder) paragraphs[0] = remainder;
        else paragraphs.shift();
      }
    }
    pendingHeadingNorm = null;

    for (const p of paragraphs) {
      if (p.trim()) bodyParts.push(`<p>${escapeXmlLocal(p)}</p>`);
    }
  }

  // No-fallback guard: leftover cleaned chunks mean the recomputed layout and the
  // chunks that were cleaned disagree (a real bug), not benign truncation.
  if (idx < cleanedChunkTexts.length) {
    throw new Error(
      `[AI-CLEANUP] Heading reassembly misaligned: consumed ${idx} of ${cleanedChunkTexts.length} cleaned chunks. ` +
      `The prose chunk layout recomputed from the chapter does not match the chunks that were cleaned.`
    );
  }

  const bodyHtml = bodyParts.join('\n');
  if (!/<body([^>]*)>[\s\S]*<\/body>/i.test(originalXhtml)) {
    throw new Error('[AI-CLEANUP] Cannot rebuild chapter: no <body> element found in original XHTML.');
  }
  return originalXhtml.replace(
    /<body([^>]*)>[\s\S]*<\/body>/i,
    `<body$1>\n${bodyHtml}\n</body>`
  );
}

/**
 * Check if AI output indicates a skip condition or conversational response.
 * Returns { skip: true, reason: string } if the output should be discarded,
 * or { skip: false } if the output is valid.
 */
function checkAIOutput(output: string, originalText: string): { skip: boolean; reason?: string } {
  const trimmed = output.trim();

  // Check for explicit skip markers
  for (const marker of SKIP_MARKERS) {
    if (trimmed === marker || trimmed.startsWith(marker)) {
      return { skip: true, reason: `AI returned skip marker: ${marker}` };
    }
  }

  // Check for AI assistant conversation patterns (check first 200 chars)
  const beginning = trimmed.substring(0, 200).toLowerCase();
  for (const pattern of AI_ASSISTANT_PATTERNS) {
    if (pattern.test(beginning)) {
      return { skip: true, reason: `AI went conversational: "${trimmed.substring(0, 50)}..."` };
    }
  }

  return { skip: false };
}

/**
 * Provider-agnostic output safeguards for AI cleanup.
 *
 * Every provider (local llama.cpp, Ollama, Claude, OpenAI) routes its cleaned
 * output through this one function from cleanChunkWithProvider, so the quality
 * checks and skipped-chunk accounting are identical no matter which backend ran
 * — previously the cloud/Ollama paths each carried their own copy and the local
 * path had NONE, which is how a model that returned empty/short output silently
 * produced hard errors instead of a graceful, recorded fallback.
 *
 * Two checks, mirroring the historical per-provider logic:
 *  1. Skip markers / conversational drift → fall back to the original chunk.
 *  2. Output far shorter than input (< threshold) → copyright-refusal check,
 *     then one reminder-retry, then split large chunks, then fall back.
 *
 * `retry(input, isRetry)` re-runs the SAME provider through the full pipeline
 * (so split halves are re-validated). It is a no-op safeguard for providers
 * whose output already passes — they return either a ≥threshold result or the
 * 100%-length original — so adding it centrally cannot change their behavior;
 * it only adds the missing net under the local path.
 */
interface OutputSafeguardOpts {
  isSimplifying: boolean;
  isRetry: boolean;
  chunkMeta?: ChunkMeta;
  label: string;
  state: CleanupJobState;
  retry: (input: string, isRetry: boolean) => Promise<string>;
}

async function applyOutputSafeguards(
  cleaned: string,
  text: string,
  opts: OutputSafeguardOpts
): Promise<string> {
  const { isSimplifying, isRetry, chunkMeta, label, state, retry } = opts;

  // Safeguard 1: the [SKIP] trapdoor. The model couldn't/wouldn't process this
  // chunk — an explicit [SKIP] marker, a conversational reply, OR an empty /
  // refusal response (treated the same). Smaller chunks are less likely to be
  // refused or mis-skipped, so split and retry; each half recurses through the
  // full provider pipeline and is re-validated. Only when a piece is too small
  // to split further do we register a visible skipped chunk and keep the
  // original text — NEVER a silent "kept the original and called it success".
  const outputCheck = !cleaned.trim()
    ? { skip: true, reason: 'empty/refusal response (no usable text)' }
    : checkAIOutput(cleaned, text);
  if (outputCheck.skip) {
    console.warn(`[${label}] ${outputCheck.reason} on ${text.length}-char chunk`);
    if (text.length >= MIN_SPLIT_SIZE) {
      console.warn(`[${label}] splitting and retrying smaller chunks`);
      const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
      const cleanedFirst = await retry(text.substring(0, midpoint), true);
      const cleanedSecond = await retry(text.substring(midpoint), true);
      return cleanedFirst + cleanedSecond;
    }
    // Too small to split further — register it (visible) and keep the original.
    if (text.length > 1000 && chunkMeta) {
      state.skipFallbackCount++;
      state.skippedChunks.push({
        chapterTitle: chunkMeta.chapterTitle,
        chunkIndex: chunkMeta.chunkIndex,
        overallChunkNumber: chunkMeta.overallChunkNumber,
        totalChunks: chunkMeta.totalChunks,
        reason: 'content-skip',
        text,
        aiResponse: cleaned.substring(0, 500),
      });
    }
    return text;
  }

  // Safeguard 2 (simplify): a single loose catastrophic-loss gate. Simplification
  // legitimately shortens and merges sentences, so only reject when almost all the
  // text is gone (<40% of input). Reject → keep original, record 'acceptance-gate';
  // NO retry, NO split, NO copyright branch (the [SKIP]/empty trapdoor above already
  // caught refusals). This replaces the old truncation cascade for simplify only.
  if (isSimplifying) {
    if (cleaned.length < text.length * 0.4) {
      console.warn(`[${label}] simplify acceptance-gate: ${cleaned.length} chars vs ${text.length} input (<40%) — keeping original`);
      if (chunkMeta) {
        state.truncatedFallbackCount++; // counted toward the abort threshold
        state.skippedChunks.push({
          chapterTitle: chunkMeta.chapterTitle,
          chunkIndex: chunkMeta.chunkIndex,
          overallChunkNumber: chunkMeta.overallChunkNumber,
          totalChunks: chunkMeta.totalChunks,
          reason: 'acceptance-gate',
          text,
          aiResponse: cleaned.substring(0, 500),
        });
      }
      return text;
    }
    return cleaned;
  }

  // Safeguard 2 (cleanup — custom rewrite prompt / detailed deletions): output far
  // shorter than input is likely truncation/removal; retry + split + copyright check.
  const lengthThreshold = 0.7;
  if (cleaned.length < text.length * lengthThreshold) {
    console.warn(`[${label}] returned ${cleaned.length} chars vs ${text.length} input (${Math.round(cleaned.length / Math.max(1, text.length) * 100)}%)`);
    console.warn(`[${label} RESPONSE START]\n${cleaned.substring(0, 500)}...\n[${label} RESPONSE END]`);

    const lowerCleaned = cleaned.toLowerCase();
    const isCopyrightRefusal =
      lowerCleaned.includes('copyright') ||
      lowerCleaned.includes('copyrighted') ||
      lowerCleaned.includes('cannot reproduce') ||
      lowerCleaned.includes('cannot process') ||
      lowerCleaned.includes('lengthy passage') ||
      lowerCleaned.includes('substantial excerpt');

    if (isCopyrightRefusal) {
      if (chunkMeta) {
        state.copyrightFallbackCount++;
        state.skippedChunks.push({
          chapterTitle: chunkMeta.chapterTitle,
          chunkIndex: chunkMeta.chunkIndex,
          overallChunkNumber: chunkMeta.overallChunkNumber,
          totalChunks: chunkMeta.totalChunks,
          reason: 'copyright',
          text,
          aiResponse: cleaned.substring(0, 500),
        });
      }
      return text;
    }

    // Retry once with an explicit "return ALL the text" reminder.
    if (!isRetry) {
      console.warn(`[${label}] Truncation detected, retrying with reminder`);
      const retryResult = await retry(TRUNCATION_RETRY_REMINDER + text, true);
      if (retryResult.length >= text.length * lengthThreshold) {
        return retryResult;
      }
    }

    // Split a large chunk and process each half (smaller chunks truncate less).
    if (text.length >= MIN_SPLIT_SIZE) {
      console.warn(`[${label}] Splitting truncated chunk (${text.length} chars) in half`);
      const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
      const firstHalf = text.substring(0, midpoint);
      const secondHalf = text.substring(midpoint);
      const cleanedFirst = await retry(firstHalf, true);
      const cleanedSecond = await retry(secondHalf, true);
      return cleanedFirst + cleanedSecond;
    }

    // Out of options — keep the original so content is never lost.
    console.warn(`[${label}] All retries exhausted - using original to prevent content loss`);
    if (chunkMeta) {
      state.truncatedFallbackCount++;
      state.skippedChunks.push({
        chapterTitle: chunkMeta.chapterTitle,
        chunkIndex: chunkMeta.chunkIndex,
        overallChunkNumber: chunkMeta.overallChunkNumber,
        totalChunks: chunkMeta.totalChunks,
        reason: 'truncated',
        text,
        aiResponse: cleaned.substring(0, 500),
      });
    }
    return text;
  }

  return cleaned;
}

/**
 * Find the best break point for chunking text.
 * Priority: paragraph break > sentence end > word boundary
 * Returns the index where the chunk should end (exclusive).
 *
 * Handles cross-platform line endings (\r\n, \n, \r) and various paragraph markers.
 */
export function findBestBreakPoint(text: string, targetEnd: number, minStart: number): number {
  if (targetEnd >= text.length) return text.length;

  const searchStart = Math.max(targetEnd - CHUNK_SEARCH_WINDOW, minStart);
  const searchText = text.substring(searchStart, targetEnd);

  // Priority 1: Paragraph break - look for blank lines (various formats)
  // Match: \n\n, \r\n\r\n, \n\r\n, or multiple newlines with optional whitespace
  const paragraphPatterns = [
    /\r?\n\s*\r?\n/g,  // Blank line (with optional whitespace between)
    /\r\n\r\n/g,       // Windows double line break
    /\n\n/g,           // Unix double line break
  ];

  let lastParagraphEnd = -1;
  for (const pattern of paragraphPatterns) {
    let match;
    pattern.lastIndex = 0; // Reset regex
    while ((match = pattern.exec(searchText)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (matchEnd > lastParagraphEnd) {
        lastParagraphEnd = matchEnd;
      }
    }
  }
  if (lastParagraphEnd > 0) {
    return searchStart + lastParagraphEnd;
  }

  // Priority 2: Sentence end (. ! ? followed by space, newline, or quote)
  // Search from end to find the last sentence boundary
  let lastSentenceEnd = -1;
  for (let i = searchText.length - 1; i > 0; i--) {
    const char = searchText[i - 1];
    const nextChar = searchText[i];
    if ((char === '.' || char === '!' || char === '?') &&
        (nextChar === ' ' || nextChar === '\n' || nextChar === '\r' ||
         nextChar === '"' || nextChar === "'" || nextChar === '\u201C' || nextChar === '\u201D' ||
         nextChar === '\u2018' || nextChar === '\u2019')) {
      lastSentenceEnd = i;
      break;
    }
  }
  if (lastSentenceEnd > 0) {
    return searchStart + lastSentenceEnd;
  }

  // Priority 3: Single line break (may indicate paragraph in some formats)
  const lastCRLF = searchText.lastIndexOf('\r\n');
  const lastLF = searchText.lastIndexOf('\n');
  const lastCR = searchText.lastIndexOf('\r');
  const lastLineBreak = Math.max(lastCRLF, lastLF, lastCR);
  if (lastLineBreak > 0) {
    // Move past the line break
    const breakLen = (lastCRLF === lastLineBreak) ? 2 : 1;
    return searchStart + lastLineBreak + breakLen;
  }

  // Priority 4: Word boundary (space)
  const lastSpace = searchText.lastIndexOf(' ');
  if (lastSpace > 0) {
    return searchStart + lastSpace + 1;
  }

  // Fallback: cut at target (shouldn't happen with reasonable text)
  return targetEnd;
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR Cleanup Prompt
// ─────────────────────────────────────────────────────────────────────────────

// Paths to the prompt files (must exist — no silent fallbacks).
// tts-cleanup.txt is the ONE cleanup prompt (English books + legacy callers);
// tts-cleanup-neutral.txt covers every other language. There are no per-language
// prompt variants anymore: number-to-words and abbreviation expansion — the only
// language-specific rules they carried — moved out of the AI pass entirely (they
// are engine-time e2a code now), so the AI pass is pure text repair.
const PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'tts-cleanup.txt');
const NEUTRAL_PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'tts-cleanup-neutral.txt');
// Edit-list cleanup: the model emits a JSON edit list (never rewrites text). Rides
// the same build copy step as the other prompts (`shx cp -r electron/prompts dist/electron/`).
const EDITLIST_PROMPT_FILE_PATH = path.join(__dirname, 'prompts', 'tts-cleanup-editlist.txt');

/** The literal phrase that switches cogito into in-band <think> reasoning. */
const THINKING_TRIGGER = 'Enable deep thinking subroutine.';

let cachedEditListPrompt: string | null = null;
/** Load (and cache) the edit-list cleanup prompt. Throws if missing — required. */
async function loadEditListPrompt(): Promise<string> {
  if (cachedEditListPrompt) return cachedEditListPrompt;
  cachedEditListPrompt = (await fsPromises.readFile(EDITLIST_PROMPT_FILE_PATH, 'utf-8')).trim();
  return cachedEditListPrompt;
}

/**
 * Load the TTS cleanup prompt from file.
 * Throws if the file doesn't exist — prompt files are required, not optional.
 */
export async function loadPrompt(): Promise<string> {
  const content = await fsPromises.readFile(PROMPT_FILE_PATH, 'utf-8');
  return content.trim();
}

/**
 * Save the TTS cleanup prompt to file.
 * Also updates the cached prompt so changes take effect immediately.
 */
export async function savePrompt(prompt: string): Promise<void> {
  // Ensure directory exists
  const dir = path.dirname(PROMPT_FILE_PATH);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(PROMPT_FILE_PATH, prompt, 'utf-8');
  // Update the cache so changes take effect immediately without restart
  cachedPrompt = prompt;
}

/**
 * Get the prompt file path (for reference)
 */
export function getPromptFilePath(): string {
  return PROMPT_FILE_PATH;
}

/**
 * Force reload the prompt from file.
 * Useful if the file was modified externally.
 */
export async function reloadPrompt(): Promise<string> {
  cachedPrompt = await loadPrompt();
  console.log('[AI-BRIDGE] Prompt reloaded from file, length:', cachedPrompt.length);
  return cachedPrompt;
}

/**
 * Build the TTS optimization prompt.
 * Loads from file if available, otherwise uses default.
 */
async function buildCleanupPromptAsync(): Promise<string> {
  return await loadPrompt();
}

/**
 * Synchronous access to cached prompts.
 * Prompts are loaded on module init and must succeed.
 */
let cachedPrompt: string | null = null;
let cachedNeutralPrompt: string | null = null;

function buildCleanupPrompt(_options: AICleanupOptions): string {
  if (!cachedPrompt) {
    throw new Error('Prompt file not loaded. Check that prompts/ directory exists.');
  }
  return cachedPrompt;
}

// Load prompts on module init — fail loudly if a file is missing
loadPrompt().then(prompt => {
  cachedPrompt = prompt;
  console.log(`[AI-BRIDGE] Loaded cleanup prompt (${prompt.length} chars)`);
}).catch(err => {
  console.error('[AI-BRIDGE] FATAL: Failed to load tts-cleanup.txt:', err);
});
fsPromises.readFile(NEUTRAL_PROMPT_FILE_PATH, 'utf-8').then(prompt => {
  cachedNeutralPrompt = prompt.trim();
  console.log(`[AI-BRIDGE] Loaded neutral cleanup prompt (${cachedNeutralPrompt.length} chars)`);
}).catch(err => {
  console.error('[AI-BRIDGE] FATAL: Failed to load tts-cleanup-neutral.txt:', err);
});

/**
 * Build a simple OCR cleanup prompt for queue processing (entire EPUB).
 * Same as buildCleanupPrompt but exposed for queue use.
 * Now supports language-specific prompts to avoid unwanted translation behavior.
 */
export function getOcrCleanupSystemPrompt(languageCode?: string): string {
  // English (or no language code — legacy callers): the editable prompt file.
  // This is the SAME file the prompt-editor UI (ai:get-prompt/ai:save-prompt)
  // edits, so user edits now apply to full-book cleanup too — before this
  // consolidation, English books got a hardcoded PROMPT_EN copy that had
  // silently drifted from the file.
  const primary = languageCode?.toLowerCase().split(/[-_]/)[0];
  if (!primary || primary === 'en' || primary === 'eng') {
    return buildCleanupPrompt({ fixHyphenation: true, fixOcrArtifacts: true, expandAbbreviations: true });
  }

  // Every other language: the language-neutral prompt (same repair rules, bound
  // to the text's own language). Nothing language-specific is lost — the old
  // per-language variants only differed in number-to-words and abbreviation
  // tables, and those rules no longer exist in the AI pass.
  console.log(`[AI-BRIDGE] Non-English book ('${languageCode}') — using the language-neutral cleanup prompt`);
  if (!cachedNeutralPrompt) {
    throw new Error('Neutral prompt file not loaded. Check that prompts/tts-cleanup-neutral.txt exists.');
  }
  return cachedNeutralPrompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detailed Cleanup - User-Marked Deletions as Few-Shot Examples
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletedBlockExample {
  text: string;
  category: 'header' | 'footer' | 'page_number' | 'custom' | 'block';
  page?: number;
}

/**
 * Build the examples section for detailed cleanup mode.
 * Groups examples by category and formats them for the AI prompt.
 */
function buildExamplesSection(examples: DeletedBlockExample[]): string {
  if (!examples || examples.length === 0) return '';

  // Group examples by category
  const groups: Record<string, string[]> = {
    header: [],
    footer: [],
    page_number: [],
    custom: [],
    block: []
  };

  for (const example of examples) {
    const category = example.category || 'block';
    if (groups[category]) {
      groups[category].push(example.text);
    }
  }

  // Build the formatted section - CONSERVATIVE approach
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════════════════════',
    'USER-MARKED DELETIONS (REFERENCE EXAMPLES)',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    'The user has marked specific text for removal. Use these as REFERENCE EXAMPLES.',
    '',
    'BE VERY CONSERVATIVE. Only remove text that is:',
    '1. An EXACT or near-exact match to the examples below',
    '2. CLEARLY the same type of structural element (e.g., standalone page numbers)',
    '3. Obviously NOT part of narrative content',
    '',
    'EXAMPLES OF SAFE REMOVALS:',
    '- Standalone page numbers: "127" on its own line → also remove "128", "129"',
    '- Running headers that are IDENTICAL FORMAT: "CHAPTER ONE" → "CHAPTER TWO"',
    '- Clear structural markers that exactly match the pattern shown',
    ''
  ];

  if (groups.header.length > 0) {
    lines.push('Header examples (remove ONLY exact format matches):');
    for (const text of groups.header.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.footer.length > 0) {
    lines.push('Footer examples (remove ONLY exact format matches):');
    for (const text of groups.footer.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.page_number.length > 0) {
    lines.push('Page number examples (remove standalone numbers matching this format):');
    for (const text of groups.page_number.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.custom.length > 0) {
    lines.push('Custom patterns (remove ONLY close matches):');
    for (const text of groups.custom.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  if (groups.block.length > 0) {
    lines.push('Other examples (be very conservative):');
    for (const text of groups.block.slice(0, 5)) {
      lines.push(`  "${text}"`);
    }
    lines.push('');
  }

  lines.push('───────────────────────────────────────────────────────────────────────────────');
  lines.push('REMOVAL RULES (CONSERVATIVE):');
  lines.push('');
  lines.push('ONLY REMOVE text that meets ALL of these criteria:');
  lines.push('1. Matches an example above in format/structure (not just content type)');
  lines.push('2. Is clearly NOT part of a sentence or paragraph');
  lines.push('3. Appears to be a standalone structural element');
  lines.push('');
  lines.push('DO NOT REMOVE:');
  lines.push('- Any text that is part of a sentence');
  lines.push('- Any text that discusses the subject matter');
  lines.push('- Footnotes or citations (unless EXACT pattern match to examples)');
  lines.push('- Anything you are uncertain about');
  lines.push('');
  lines.push('WHEN IN DOUBT, KEEP THE TEXT.');
  lines.push('It is much better to leave unwanted text than to delete wanted content.');
  lines.push('');

  return lines.join('\n');
}

/**
 * The three user-selectable simplify modes. Each has its own tightly-scoped
 * prompt file under prompts/, which is the single source of truth for that
 * mode's behavior:
 *   - dejargon:  plain English for over-complex academic prose
 *   - destiffen: natural English for stiff machine-translated prose
 *   - learner:   B1-B2 rewrite of archaic/complex language (the historic mode)
 */
export type SimplifyMode = 'dejargon' | 'destiffen' | 'learner';

const SIMPLIFY_PROMPT_FILES: Record<SimplifyMode, string> = {
  dejargon: 'simplify-dejargon.txt',
  destiffen: 'simplify-destiffen.txt',
  learner: 'simplify-learner.txt',
};

/**
 * Map a wire-level simplifyMode value to a canonical SimplifyMode.
 *
 * Accepts the current values plus the legacy values that older queued or resumed
 * jobs still carry, and THROWS on anything unrecognized — it never silently
 * defaults to a mode (no-fallbacks rule). `undefined` is a pre-mode job, which
 * always meant the A1-B1 language-learner behavior (the old `|| 'learning'`
 * default and the single "Simplify for learning" toggle) → 'learner'.
 */
export function resolveSimplifyMode(raw: string | undefined | null): SimplifyMode {
  switch (raw) {
    case undefined:
    case null:
    case 'learner':
    case 'learning': // legacy: A1-B1 language-learner mode
      return 'learner';
    case 'dejargon':
    case 'plain': // legacy: single "plain language" prompt that merged de-jargon + de-stiffen
      return 'dejargon';
    case 'destiffen':
      return 'destiffen';
    default:
      throw new Error(
        `Unknown simplifyMode: ${JSON.stringify(raw)} (expected 'dejargon' | 'destiffen' | 'learner')`
      );
  }
}

// Cache the simplify prompt files (same contract as loadPrompt() above).
const simplifyPromptCache = new Map<SimplifyMode, string>();

/**
 * Load a simplify mode's standalone prompt from its file. Throws if the file is
 * missing — prompt files are required, not optional.
 */
export async function getSimplifyPrompt(mode: SimplifyMode): Promise<string> {
  const cached = simplifyPromptCache.get(mode);
  if (cached) return cached;
  const p = path.join(__dirname, 'prompts', SIMPLIFY_PROMPT_FILES[mode]);
  const content = (await fsPromises.readFile(p, 'utf-8')).trim();
  simplifyPromptCache.set(mode, content);
  return content;
}

/**
 * Extract just the rewrite RULES from a standalone simplify prompt — the section
 * from "HOW TO REWRITE" onward, minus its trailing standalone output-contract
 * line. Used to bolt simplify behavior onto the cleanup prompt in the combined
 * "cleanup + simplify" mode WITHOUT stacking two competing [SKIP]/output
 * contracts (two contracts made the model emit a stray trailing [SKIP]).
 */
function simplifyRulesBody(promptText: string): string {
  const idx = promptText.indexOf('HOW TO REWRITE');
  if (idx === -1) {
    throw new Error('Simplify prompt is missing its "HOW TO REWRITE" section');
  }
  return promptText
    .slice(idx)
    .replace(/\n?Output ONLY the [^\n]*$/, '')
    .trimEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if Ollama is running and accessible
 */
export async function checkConnection(): Promise<{ connected: boolean; models?: OllamaModel[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { connected: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const models: OllamaModel[] = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at
    }));

    return { connected: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { connected: false, error: message };
  }
}

/**
 * Verify Ollama can actually serve a generate request end-to-end.
 * A hung server can still answer light endpoints like /api/tags while generate
 * requests sit in its queue forever — this catches that before a job starts.
 * Also warms the model (keep_alive) so the first real chunk doesn't pay load time.
 */
export async function verifyOllamaGenerate(model: string): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'Reply with the word OK.',
        stream: false,
        options: { num_predict: 8, num_ctx: 2048 },
        keep_alive: '5m'
      })
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    if (typeof data.response !== 'string' || data.response.length === 0) {
      return { ok: false, error: 'generate returned no response text' };
    }
    return { ok: true };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: `no response within ${TIMEOUT_MS / 1000}s — the server may be hung (check for stale ollama processes on port 11434)` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get list of available models
 */
export async function getModels(): Promise<OllamaModel[]> {
  const result = await checkConnection();
  return result.models || [];
}

/**
 * Check if a specific model is available
 */
export async function hasModel(modelName: string): Promise<boolean> {
  const models = await getModels();
  return models.some(m => m.name === modelName || m.name.startsWith(modelName + ':'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Connection Checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check connection for any AI provider
 */
export async function checkProviderConnection(provider: AIProvider, apiKey?: string): Promise<ProviderConnectionResult> {
  switch (provider) {
    case 'ollama':
      return checkOllamaConnection();
    case 'claude':
      return checkClaudeConnection(apiKey);
    case 'openai':
      return checkOpenAIConnection(apiKey);
    case 'local':
      return checkLocalConnection();
    default:
      return { available: false, error: `Unknown provider: ${provider}` };
  }
}

/**
 * Check the bundled local llama.cpp: usable when the binary is bundled and a
 * model is downloaded + selected. Does not start the server (that's lazy).
 */
async function checkLocalConnection(): Promise<ProviderConnectionResult> {
  try {
    const { llamaBridge } = await import('./llama-bridge.js');
    const s = await llamaBridge.status();
    if (!s.binaryPresent) {
      return { available: false, error: 'The local AI engine is not bundled in this build.' };
    }
    if (!s.activeModelDownloaded) {
      return { available: false, error: 'No local model is downloaded. Download one in AI Setup.' };
    }
    return { available: true, models: s.activeModelId ? [s.activeModelId] : [] };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check Ollama connection
 */
async function checkOllamaConnection(): Promise<ProviderConnectionResult> {
  const result = await checkConnection();
  return {
    available: result.connected,
    error: result.error,
    models: result.models?.map(m => m.name)
  };
}

/**
 * Check Claude (Anthropic) API connection. A cloud key can only be validated by
 * making a request, so this is a real check ONLY when a key is supplied: it
 * routes to getClaudeModels (a lightweight GET /v1/models). With no key it
 * reports unavailable with an honest reason instead of a fixed placeholder.
 */
async function checkClaudeConnection(apiKey?: string): Promise<ProviderConnectionResult> {
  if (!apiKey) {
    return { available: false, error: 'No Claude API key configured — add one in AI Setup.' };
  }
  const result = await getClaudeModels(apiKey);
  return {
    available: result.success,
    error: result.error,
    models: result.models?.map((m) => m.value),
  };
}

/**
 * Get available Claude models by querying the Anthropic API
 * Uses the /v1/models endpoint to fetch the actual list of available models
 */
export async function getClaudeModels(apiKey: string): Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }> {
  if (!apiKey) {
    return { success: false, error: 'No API key provided' };
  }

  // Verify the key format
  if (!apiKey.startsWith('sk-ant-')) {
    return { success: false, error: 'Invalid API key format (should start with sk-ant-)' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || response.statusText;

      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      }
      if (response.status === 403) {
        return { success: false, error: 'API key does not have access' };
      }

      return { success: false, error: `API error: ${errorMessage}` };
    }

    const data = await response.json();

    // Filter to only include chat models (claude-*) and format them nicely
    const models: { value: string; label: string }[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        const id = model.id;
        // Skip non-Claude models and embedding models
        if (!id.startsWith('claude-') || id.includes('embedding')) {
          continue;
        }

        // Create a friendly label
        // Check for 4.5 versions first (they contain 'opus-4-5' or 'sonnet-4-5')
        let label = id;
        if (id.includes('opus-4-5')) {
          label = 'Claude Opus 4.5';
        } else if (id.includes('sonnet-4-5')) {
          label = 'Claude Sonnet 4.5';
        } else if (id.includes('opus-4')) {
          label = 'Claude Opus 4';
        } else if (id.includes('sonnet-4')) {
          label = 'Claude Sonnet 4';
        } else if (id.includes('3-5-sonnet')) {
          label = 'Claude 3.5 Sonnet';
        } else if (id.includes('3-5-haiku')) {
          label = 'Claude 3.5 Haiku';
        } else if (id.includes('3-opus')) {
          label = 'Claude 3 Opus';
        } else if (id.includes('3-sonnet')) {
          label = 'Claude 3 Sonnet';
        } else if (id.includes('3-haiku')) {
          label = 'Claude 3 Haiku';
        }

        models.push({ value: id, label });
      }
    }

    // Sort models: Sonnet 4.5 first (recommended), then Opus 4.5, then older models
    models.sort((a, b) => {
      // Put sonnet-4-5 first as recommended (best balance of speed/quality)
      if (a.value.includes('sonnet-4-5') && !b.value.includes('sonnet-4-5')) return -1;
      if (!a.value.includes('sonnet-4-5') && b.value.includes('sonnet-4-5')) return 1;
      // Then opus-4-5
      if (a.value.includes('opus-4-5') && !b.value.includes('opus-4-5')) return -1;
      if (!a.value.includes('opus-4-5') && b.value.includes('opus-4-5')) return 1;
      // Then sonnet-4 (non-4.5)
      if (a.value.includes('sonnet-4') && !b.value.includes('sonnet-4')) return -1;
      if (!a.value.includes('sonnet-4') && b.value.includes('sonnet-4')) return 1;
      // Then opus-4 (non-4.5)
      if (a.value.includes('opus-4') && !b.value.includes('opus-4')) return -1;
      if (!a.value.includes('opus-4') && b.value.includes('opus-4')) return 1;
      // Then 3.5 models
      if (a.value.includes('3-5') && !b.value.includes('3-5')) return -1;
      if (!a.value.includes('3-5') && b.value.includes('3-5')) return 1;
      return a.label.localeCompare(b.label);
    });

    // Mark the first one as recommended
    if (models.length > 0 && !models[0].label.includes('Recommended')) {
      models[0].label += ' (Recommended)';
    }

    return { success: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('abort')) {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: message };
  }
}

/**
 * Check OpenAI API connection. Like Claude, this is a real check ONLY when a key
 * is supplied: it routes to getOpenAIModels (a lightweight GET /v1/models). With
 * no key it reports unavailable with an honest reason instead of a placeholder.
 */
async function checkOpenAIConnection(apiKey?: string): Promise<ProviderConnectionResult> {
  if (!apiKey) {
    return { available: false, error: 'No OpenAI API key configured — add one in AI Setup.' };
  }
  const result = await getOpenAIModels(apiKey);
  return {
    available: result.success,
    error: result.error,
    models: result.models?.map((m) => m.value),
  };
}

/**
 * Get available OpenAI models by querying the OpenAI API
 * Uses the /v1/models endpoint to fetch the actual list of available models
 */
export async function getOpenAIModels(apiKey: string): Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }> {
  if (!apiKey) {
    return { success: false, error: 'No API key provided' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || response.statusText;

      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      }
      if (response.status === 403) {
        return { success: false, error: 'API key does not have access' };
      }

      return { success: false, error: `API error: ${errorMessage}` };
    }

    const data = await response.json();

    // Filter to only include chat models (gpt-*) and format them nicely
    const models: { value: string; label: string }[] = [];

    if (data.data && Array.isArray(data.data)) {
      for (const model of data.data) {
        const id = model.id;
        // Only include GPT chat models, skip embedding, whisper, tts, dall-e, etc.
        if (!id.startsWith('gpt-')) {
          continue;
        }
        // Skip instruct and embedding variants
        if (id.includes('instruct') || id.includes('embedding')) {
          continue;
        }

        // Create a friendly label
        let label = id;
        if (id === 'gpt-4o') {
          label = 'GPT-4o';
        } else if (id === 'gpt-4o-mini') {
          label = 'GPT-4o Mini';
        } else if (id.startsWith('gpt-4o-')) {
          // Dated versions like gpt-4o-2024-11-20
          const dateMatch = id.match(/gpt-4o-(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            label = `GPT-4o (${dateMatch[1]})`;
          }
        } else if (id === 'gpt-4-turbo') {
          label = 'GPT-4 Turbo';
        } else if (id.startsWith('gpt-4-turbo-')) {
          const dateMatch = id.match(/gpt-4-turbo-(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            label = `GPT-4 Turbo (${dateMatch[1]})`;
          }
        } else if (id === 'gpt-4') {
          label = 'GPT-4';
        } else if (id.startsWith('gpt-4-')) {
          // Other GPT-4 variants
          label = id.replace('gpt-4-', 'GPT-4 ').replace(/-/g, ' ');
        } else if (id === 'gpt-3.5-turbo') {
          label = 'GPT-3.5 Turbo';
        } else if (id.startsWith('gpt-3.5-turbo-')) {
          label = `GPT-3.5 Turbo (${id.replace('gpt-3.5-turbo-', '')})`;
        }

        models.push({ value: id, label });
      }
    }

    // Sort models: GPT-4o first (recommended), then GPT-4 Turbo, then GPT-4, then GPT-3.5
    models.sort((a, b) => {
      // gpt-4o (non-mini, non-dated) first
      if (a.value === 'gpt-4o' && b.value !== 'gpt-4o') return -1;
      if (a.value !== 'gpt-4o' && b.value === 'gpt-4o') return 1;
      // gpt-4o-mini second
      if (a.value === 'gpt-4o-mini' && b.value !== 'gpt-4o-mini') return -1;
      if (a.value !== 'gpt-4o-mini' && b.value === 'gpt-4o-mini') return 1;
      // Other gpt-4o variants
      if (a.value.startsWith('gpt-4o') && !b.value.startsWith('gpt-4o')) return -1;
      if (!a.value.startsWith('gpt-4o') && b.value.startsWith('gpt-4o')) return 1;
      // gpt-4-turbo
      if (a.value.includes('turbo') && !b.value.includes('turbo')) return -1;
      if (!a.value.includes('turbo') && b.value.includes('turbo')) return 1;
      // gpt-4 before gpt-3.5
      if (a.value.startsWith('gpt-4') && b.value.startsWith('gpt-3')) return -1;
      if (a.value.startsWith('gpt-3') && b.value.startsWith('gpt-4')) return 1;
      return a.label.localeCompare(b.label);
    });

    // Mark the first one as recommended
    if (models.length > 0 && !models[0].label.includes('Recommended')) {
      models[0].label += ' (Recommended)';
    }

    return { success: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('abort')) {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Cancellation Support
// ─────────────────────────────────────────────────────────────────────────────

// Track active cleanup jobs for cancellation
interface ActiveCleanupJob {
  controller: AbortController;
  provider: AIProvider;
}
const activeCleanupJobs = new Map<string, ActiveCleanupJob>();

/**
 * Cancel an active cleanup job immediately.
 * Aborts any in-flight HTTP requests and stops chunk processing.
 *
 * For the bundled local engine (llama-server), aborting the HTTP request only
 * stops the current generation — the server process stays resident, holding the
 * model in VRAM until its 5-minute idle timer fires. Cancelling the job means the
 * user wants the GPU back now, so we also stop the server.
 */
export function cancelCleanupJob(jobId: string): boolean {
  const job = activeCleanupJobs.get(jobId);
  if (job) {
    console.log(`[AI-BRIDGE] Cancelling job ${jobId} - aborting all requests`);
    job.controller.abort();
    activeCleanupJobs.delete(jobId);
    if (job.provider === 'local') {
      // Fire-and-forget: free the model from VRAM immediately. stop() is a no-op
      // if the server isn't running, and the next job lazily restarts it.
      void import('./llama-bridge.js')
        .then(({ llamaBridge }) => llamaBridge.stop())
        .catch((err) => console.warn(`[AI-BRIDGE] Failed to stop local server on cancel: ${(err as Error).message}`));
    }
    return true;
  }
  return false;
}

/**
 * Check if a job has been cancelled
 */
function isJobCancelled(jobId: string): boolean {
  const job = activeCleanupJobs.get(jobId);
  return !job || job.controller.signal.aborted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Text Cleanup
// ─────────────────────────────────────────────────────────────────────────────

// Metadata for tracking skipped chunks
export interface ChunkMeta {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number across all chapters
  totalChunks: number;         // Total chunks in the job
}

/**
 * What the chunk pipeline is doing, passed explicitly from the caller that
 * chose the system prompt (cleanupEpub knows simplifyForChildren). Drives the
 * simplify-specific safeguard behavior (looser 0.3 length threshold, since
 * simplification legitimately shortens text) — previously this was inferred by
 * substring-matching prompt literals, which broke silently whenever a prompt
 * was reworded or a custom prompt was supplied.
 */
export type CleanupTask = 'cleanup' | 'simplify';

/**
 * Clean up a chunk of text using Claude API
 */
async function cleanChunkWithClaude(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string = 'claude-3-5-sonnet-20241022',
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta,
  isRetry: boolean = false
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        // Claude 3.5 models have 8192 max output tokens, Claude 4+ models have higher limits
        // Cap based on model version to avoid API errors while allowing full capacity
        max_tokens: model.includes('claude-3')
          ? Math.min(8192, Math.max(4096, text.length * 2))
          : Math.max(4096, text.length * 2),  // Claude 4+ can handle more
        system: systemPrompt,
        messages: [
          { role: 'user', content: text }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Claude API error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    // Concatenate ALL text-type content blocks (a response may also contain
    // non-text blocks, e.g. thinking).
    const extracted: string = Array.isArray(data.content)
      ? data.content
          .filter((b: { type?: string; text?: string }) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: { text?: string }) => b.text)
          .join('')
      : '';
    // CRITICAL: never `extracted || text`. An empty/refusal response (e.g. Claude
    // declining copyrighted book text, stop_reason 'refusal') must go through the
    // [SKIP] trapdoor below — split → retry → and if it still won't process, fall
    // back to the original AND register a skipped chunk — NOT silently return the
    // original as a clean "0 changes" success. (The old `|| text` did exactly that
    // and made whole-book refusals invisible — see no-fallbacks rule.)
    if (!extracted.trim()) {
      console.warn(`[Claude] Empty/refusal response (stop_reason: ${data.stop_reason ?? 'none'}) for ${text.length}-char chunk — routing through [SKIP] handling`);
    }
    const cleaned: string = extracted.trim() ? extracted : '[SKIP]';

    // The output was cut off (hit the token budget). Route through the unified
    // [SKIP] split so smaller chunks regenerate in full instead of keeping
    // truncated text.
    if (data.stop_reason === 'max_tokens') {
      console.warn(`[Claude] hit max_tokens for ${text.length}-char chunk — routing through unified [SKIP] split`);
      return '[SKIP]';
    }

    // Separate the model's answer from any reasoning/answer-tag wrapper, exactly
    // like the Ollama/local paths — so an answer-tag prompt (edit-list, simplify)
    // never leaks its <answer>/<think> tags into the book, and an unclosed answer
    // throws REASONING_OVERRUN. For the legacy no-tag rewrite prompt this is a
    // no-op (plain text has no tags). ALL other quality safeguards (the [SKIP]
    // trapdoor, truncation, copyright, splitting, registering skipped chunks) are
    // applied uniformly by applyOutputSafeguards in cleanChunkWithProvider.
    return extractAnswer(cleaned, model);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Clean up a chunk of text using OpenAI API
 */
async function cleanChunkWithOpenAI(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model: string = 'gpt-4o',
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta,
  isRetry: boolean = false
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(4096, text.length * 2),
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${response.status} - ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    // Never `content || text`. An empty/refusal response must go through the
    // [SKIP] trapdoor (split → retry → register a skipped chunk), not silently
    // return the original as a clean "0 changes" success. See no-fallbacks rule.
    const extracted: string = data.choices?.[0]?.message?.content ?? '';
    if (!extracted.trim()) {
      const finish = data.choices?.[0]?.finish_reason ?? 'none';
      console.warn(`[OpenAI] Empty/refusal response (finish_reason: ${finish}) for ${text.length}-char chunk — routing through [SKIP] handling`);
    }
    const cleaned = extracted.trim() ? extracted : '[SKIP]';

    // Separate answer from any reasoning/answer-tag wrapper (see the Claude path):
    // an answer-tag prompt (edit-list, simplify) must not leak its tags, and an
    // unclosed answer throws REASONING_OVERRUN. No-op for the legacy rewrite prompt.
    return extractAnswer(cleaned, model);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Clean up a chunk of text using the configured provider with retry logic
 */
/**
 * Clean a chunk using the bundled local llama.cpp model. The active model is
 * resolved inside llama-bridge (it lazily starts the server). Strips any
 * <think>…</think> reasoning the model may emit so the cleaned text is clean.
 */
async function cleanChunkWithLocal(
  text: string,
  systemPrompt: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const { llamaBridge } = await import('./llama-bridge.js');
  const raw = await llamaBridge.generate({
    system: systemPrompt,
    prompt: text,
    temperature: 0.1,
    signal: abortSignal,
    // The shared output safeguards (applied in cleanChunkWithProvider) handle an
    // empty/short result — retry, split, then fall back to the original chunk —
    // so don't let generate() throw a fatal error on empty content.
    allowEmpty: true,
  });
  // Same contract as the Ollama path: an unterminated <think> is a failed
  // generation, not text to ship. See extractAnswer().
  return extractAnswer(raw, 'local');
}

export async function cleanChunkWithProvider(
  text: string,
  systemPrompt: string,
  task: CleanupTask,
  config: AIProviderConfig,
  state: CleanupJobState,
  jobNumCtx: number,
  jobTemperature: number,
  maxRetries: number = 3,
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta,
  isRetry: boolean = false
): Promise<string> {
  let lastError: Error | null = null;

  // Simplification legitimately shortens output → looser length threshold in
  // the safeguards. Explicit from the caller that chose the prompt — never
  // inferred from prompt text.
  const isSimplifying = task === 'simplify';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check for cancellation before each attempt
    if (abortSignal?.aborted) {
      throw new Error('Job cancelled');
    }

    try {
      // Dispatch one cleanup call to the configured provider. Factored into a
      // closure so the repetition guard can re-run the same chunk with an
      // anti-repetition note prepended.
      const callProvider = async (inputText: string): Promise<string> => {
        switch (config.provider) {
          case 'ollama':
            if (!config.ollama?.model) {
              throw new Error('Ollama model not configured');
            }
            return cleanChunk(inputText, systemPrompt, config.ollama.model, jobNumCtx, jobTemperature, abortSignal, chunkMeta);
          case 'claude':
            if (!config.claude?.apiKey) {
              throw new Error('Claude API key not configured');
            }
            if (!config.claude?.model) {
              throw new Error('Claude model not configured');
            }
            return cleanChunkWithClaude(inputText, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal, chunkMeta);
          case 'openai':
            if (!config.openai?.apiKey) {
              throw new Error('OpenAI API key not configured');
            }
            if (!config.openai?.model) {
              throw new Error('OpenAI model not configured');
            }
            return cleanChunkWithOpenAI(inputText, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal, chunkMeta);
          case 'local':
            return cleanChunkWithLocal(inputText, systemPrompt, abortSignal);
          default:
            throw new Error(`Unknown provider: ${config.provider}`);
        }
      };

      let cleanedText = await callProvider(text);

      // Repetition / degeneration guard (provider-agnostic).
      // If the model looped, retry the chunk once with an explicit note about
      // what went wrong. If it STILL loops, record it for the user (skipped
      // chunks) and fall back to the untouched source — never ship the loop.
      const rep = detectRepetition(cleanedText);
      if (rep.repeated) {
        console.warn(`[AI-CLEANUP] Repetition detected (${rep.detail}) — retrying chunk with anti-repetition note`);
        const retried = await callProvider(REPETITION_RETRY_REMINDER + text);
        const retryRep = detectRepetition(retried);
        if (!retryRep.repeated) {
          console.log('[AI-CLEANUP] Retry resolved the repetition');
          cleanedText = retried;
        } else {
          console.warn(`[AI-CLEANUP] Repetition persisted after retry (${retryRep.detail}) — falling back to original block`);
          state.repetitionFallbackCount++;
          if (chunkMeta) {
            state.skippedChunks.push({
              chapterTitle: chunkMeta.chapterTitle,
              chunkIndex: chunkMeta.chunkIndex,
              overallChunkNumber: chunkMeta.overallChunkNumber,
              totalChunks: chunkMeta.totalChunks,
              reason: 'repetition',
              text,
              aiResponse: retried.substring(0, 500),
            });
          }
          return text;
        }
      }

      // Provider-agnostic output safeguards (skip-marker / truncation handling).
      // A no-op for providers whose output already passes; the real safety net
      // for the local llama.cpp path, which has no other validation. Split/retry
      // recurses back through this same function so halves are re-validated.
      return applyOutputSafeguards(cleanedText, text, {
        isSimplifying,
        isRetry,
        chunkMeta,
        label: `AI-CLEANUP:${config.provider}`,
        state,
        retry: (input, retryFlag) =>
          cleanChunkWithProvider(input, systemPrompt, task, config, state, jobNumCtx, jobTemperature, maxRetries, abortSignal, chunkMeta, retryFlag),
      });
    } catch (error) {
      // If aborted/cancelled, don't retry - throw immediately
      if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error('Job cancelled');
      }

      // Context overflow: the chunk is too big for the model's context window
      // (llama-server answers HTTP 400; some backends say "context"/"too long").
      // The chunker already caps chunk size, but be self-healing — split the
      // chunk and process each half rather than failing the whole job. Each half
      // recurses through the full pipeline, so this converges (8k→4k→2k→…).
      const msg = error instanceof Error ? error.message : String(error);
      const isContextOverflow = /HTTP 400|context|too long|exceed|n_ctx|too large/i.test(msg);
      if (isContextOverflow && text.length >= 1000) {
        console.warn(`[AI-CLEANUP:${config.provider}] Chunk too big for context (${text.length} chars: ${msg}) — splitting in half`);
        const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
        const firstHalf = text.substring(0, midpoint);
        const secondHalf = text.substring(midpoint);
        const cleanedFirst = await cleanChunkWithProvider(firstHalf, systemPrompt, task, config, state, jobNumCtx, jobTemperature, maxRetries, abortSignal, chunkMeta, true);
        const cleanedSecond = await cleanChunkWithProvider(secondHalf, systemPrompt, task, config, state, jobNumCtx, jobTemperature, maxRetries, abortSignal, chunkMeta, true);
        return cleanedFirst + cleanedSecond;
      }

      // A hybrid-reasoning model whose <think> block never closed produced NO
      // answer for this chunk (see extractAnswer). No re-roll: the overrun is
      // strongly correlated with the chunk's content, so a retry at the same
      // settings usually just burns another 60-90s reproducing it. Keep the
      // ORIGINAL chunk (uncleaned, never corrupted) and record it in
      // skipped-chunks.json — never silent, never book-fatal.
      if (error instanceof Error && error.message.includes('REASONING_OVERRUN')) {
        console.warn('[AI-CLEANUP] Reasoning overrun — keeping original chunk and recording it (no retry)');
        state.errorFallbackCount++;
        if (chunkMeta) {
          state.skippedChunks.push({
            chapterTitle: chunkMeta.chapterTitle,
            chunkIndex: chunkMeta.chunkIndex,
            overallChunkNumber: chunkMeta.overallChunkNumber,
            totalChunks: chunkMeta.totalChunks,
            reason: 'reasoning-overrun',
            text,
            aiResponse: error.message.substring(0, 500),
          });
        }
        return text;
      }

      lastError = error as Error;
      const isRetryableError = error instanceof Error && (
        error.message.includes('fetch') ||
        error.message.includes('network') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket') ||
        error.message.includes('timeout')
      );

      // Retry on network/connection errors, but not on other errors
      if (isRetryableError && attempt < maxRetries) {
        console.warn(`Chunk attempt ${attempt} failed (${error}), retrying in ${attempt * 2}s...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Failed to clean chunk after retries');
}

/**
 * Clean up a single chunk of text using Ollama
 */
async function cleanChunk(
  text: string,
  systemPrompt: string,
  model: string,
  jobNumCtx: number,
  jobTemperature: number,
  abortSignal?: AbortSignal,
  chunkMeta?: ChunkMeta,
  isRetry: boolean = false,
  // Edit-list / observation calls emit a tiny JSON answer regardless of input size,
  // so they pin num_predict at a fixed budget (4096) instead of the rewrite-era
  // text.length*2. Omit to keep the rewrite budget.
  numPredictOverride?: number
): Promise<string> {
  console.log('[AI-BRIDGE] cleanChunk using model:', model);

  // Use AbortController for cancellation support
  const controller = new AbortController();

  // Chain abort signals - if parent aborts, abort this request too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Stream the response so a hung server surfaces as an inactivity timeout instead of
  // hanging forever (a non-streaming request also dies at undici's 5-minute headers
  // timeout for long generations, which read as a generic "fetch failed").
  let timedOut = false;
  let inactivityTimer: NodeJS.Timeout | undefined;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OLLAMA_INACTIVITY_TIMEOUT_MS);
  };

  let cleaned: string;
  try {
    // Capability-gated: thinking models (e.g. qwen3) get think:false so the
    // generation budget goes to the answer, not a discarded chain-of-thought.
    const thinkFields = await getOllamaThinkFields(OLLAMA_BASE_URL, model);
    resetInactivityTimer();
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: text,
        system: systemPrompt,
        stream: true,
        ...thinkFields,
        options: {
          temperature: jobTemperature, // Job-level; default 0.1 (consistent), overridable via cleanupEpub options.temperature
          num_predict: (typeof numPredictOverride === 'number' && numPredictOverride > 0) ? numPredictOverride : text.length * 2, // Allow enough tokens
          // Job-level constant sized to the largest chunk (computed once in the
          // caller). Ollama fully reloads the runner on ANY num_ctx change, so a
          // per-chunk estimate churned the model in/out between chunks; a single
          // pinned value loads it once and keeps it resident for the whole book.
          num_ctx: jobNumCtx
        },
        keep_alive: '5m' // Keep model loaded for 5 minutes
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Ollama returned no response body');
    }

    let result = '';
    let buffer = '';
    let sawDone = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetInactivityTimer();
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        const data = JSON.parse(line);
        if (data.error) {
          throw new Error(`Ollama error: ${data.error}`);
        }
        if (typeof data.response === 'string') {
          result += data.response;
        }
        if (data.done) sawDone = true;
      }
    }
    if (!sawDone) {
      throw new Error('Ollama stream ended without a completion message');
    }
    cleaned = result;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Ollama timeout: no data received for ${OLLAMA_INACTIVITY_TIMEOUT_MS / 1000}s — the server may be hung`);
    }
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }

  // Separate the model's reasoning from its answer. ALL quality safeguards (the
  // [SKIP] trapdoor, truncation, copyright, splitting, registering skipped
  // chunks) are applied uniformly by applyOutputSafeguards in
  // cleanChunkWithProvider — never per provider — so every backend behaves
  // identically. An empty result here is treated as a skip there (never
  // silently kept as the original).
  return extractAnswer(cleaned, model);
}

/**
 * Pull the answer out of a hybrid-reasoning model's response.
 *
 * Two shapes are accepted, in order:
 *  1. An explicit <answer>…</answer> block (the reliable one — POSITIVE
 *     extraction). Whatever surrounds it is reasoning and is discarded.
 *  2. No answer block: strip closed <think>…</think> pairs, the historical
 *     behavior for prompts that don't ask for answer tags.
 *
 * Then the hard part. A reasoning block that never closes means the model spent
 * its whole budget thinking and NEVER PRODUCED AN ANSWER — there is no clean
 * text hiding behind it to recover. Returning the raw text here shipped cogito's
 * chain-of-thought straight into a book (observed 2026-07-23: 2 of 23 chunks, a
 * `<think>` with no `</think>`, reasoning narrated in the audiobook). So a
 * surviving `<think` is a FAILED GENERATION and must throw: cleanChunkWithProvider
 * catches it, retries, splits, and finally records a skipped chunk. Never a
 * silent fallback — the one thing we must not do is ship it.
 */
function extractAnswer(raw: string, model: string): string {
  const answers = [...raw.matchAll(/<answer>([\s\S]*?)<\/answer>/gi)];
  let text: string;
  if (answers.length === 1) {
    text = answers[0][1];
  } else if (answers.length > 1) {
    throw new Error(
      `REASONING_OVERRUN: model '${model}' returned ${answers.length} <answer> blocks (expected exactly 1)`
    );
  } else {
    // No answer block. If the prompt asked for one, an unclosed <answer> means
    // the generation died mid-answer; treat it like the truncation it is.
    if (/<answer>/i.test(raw)) {
      throw new Error(`REASONING_OVERRUN: model '${model}' opened <answer> but never closed it (truncated generation)`);
    }
    text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  }
  // Belt and braces: no reasoning may survive into the book by any route.
  if (/<\/?think\b/i.test(text)) {
    throw new Error(
      `REASONING_OVERRUN: model '${model}' emitted an unterminated <think> block — ` +
      `reasoning ran past the generation budget and no answer was produced`
    );
  }
  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit-list cleanup pass + deterministic pre-pass model calls
//
// The cleanup task (NOT simplify, NOT bilingual, NOT a custom rewrite prompt) runs
// as: deterministic pre-passes (footnote removal → hyphen joins → quote norm) →
// per-chunk edit-list model pass → guarded applier. See ai-cleanup-prepass.ts and
// AI_CLEANUP_TESTING.md §5–§7. Prose deletion is structurally impossible; every
// applied/rejected edit is logged; a bad model answer degrades to "cleaned less".
// ─────────────────────────────────────────────────────────────────────────────

/** Footnote-marker OBSERVATION prompt (param_detect.py). The model reports where
 *  markers sit; it NEVER writes a regex. Answer wrapped in <answer> tags so the
 *  shared extractAnswer() pulls it (and throws REASONING_OVERRUN on an overrun). */
const FOOTNOTE_OBSERVATION_PROMPT = `${THINKING_TRIGGER}

You ANALYZE OCR'd ebook text and report OBSERVATIONS. You never write a regex and you never rewrite text. Other code builds the pattern from your answers.

Report how footnote/reference markers appear in this chapter, if at all. Answer only from what you can SEE in the text.

Definitions:
 - "marker" = the little reference mark left inline where a footnote number was.
 - It is NOT a year, a quantity, an age, a percentage, an ordinal (54th), a scripture reference (Romans 13:), or a digit inside a word (c0nstitution).

After thinking, output ONLY this JSON object inside <answer> tags, no prose, no code fence:
<answer>
{
 "has_markers": true/false,
 "marker_type": "arabic" | "roman" | "letter" | "symbol",
 "symbol_chars": "<if marker_type is symbol, the exact characters; else \\"\\">",
 "anchors": [<which characters a marker sits IMMEDIATELY after; any of: "period","question","exclamation","closing_double_quote","closing_single_quote","comma","colon","word_character">],
 "space_between_anchor_and_marker": true/false,
 "followed_by": "whitespace" | "line_end" | "whitespace_then_capital",
 "min_value": <smallest marker value you see, as an integer>,
 "max_value": <largest marker value you see, as an integer>,
 "sequential": true/false,
 "restarts_each_chapter": true/false,
 "total_in_chapter": <exact count of markers you can find>,
 "examples": [<5 exact substrings, each including the character BEFORE the marker>],
 "confusable_numbers_present": [<3-5 exact numbers in this text that are NOT markers and must survive>]
}
</answer>`;

/** Hyphen line-break arbitration prompt: for each `word-word` pair, decide whether
 *  a line break split one word ("join") or it is a genuine compound ("hyphen"). */
function buildHyphenVerdictPrompt(pairs: string[]): string {
  return `${THINKING_TRIGGER}

Each item below is two word-parts that were separated by a hyphen at a line break in an OCR'd book. For EACH item decide:
 - "join"   = a line break split ONE word; the hyphen is not real (unbri-dled -> unbridled, recon-struct -> reconstruct).
 - "hyphen" = a genuine hyphenated compound or name; the hyphen belongs (non-Aryan, anti-Semitism, Siegmund-Schultze).

After thinking, output ONLY this JSON inside <answer> tags, one verdict per item, using the item text EXACTLY as given:
<answer>
{"verdicts": [{"pair": "unbri-dled", "verdict": "join"}, {"pair": "non-Aryan", "verdict": "hyphen"}]}
</answer>

Items:
${pairs.map(p => `- ${p}`).join('\n')}`;
}

/**
 * Dispatch one call to the configured provider and return the extracted answer
 * text (post extractAnswer — think/answer tags removed, REASONING_OVERRUN thrown
 * on an overrun). Used by the pre-pass observation calls and the edit-list chunk
 * pass. num_predict/temperature are honored only by Ollama; cloud/local use their
 * own budgets — immaterial for these small-answer calls.
 */
async function callProviderExtracted(
  inputText: string,
  systemPrompt: string,
  config: AIProviderConfig,
  numCtx: number,
  temperature: number,
  numPredict: number,
  abortSignal?: AbortSignal
): Promise<string> {
  switch (config.provider) {
    case 'ollama':
      if (!config.ollama?.model) throw new Error('Ollama model not configured');
      return cleanChunk(inputText, systemPrompt, config.ollama.model, numCtx, temperature, abortSignal, undefined, false, numPredict);
    case 'claude':
      if (!config.claude?.apiKey || !config.claude?.model) throw new Error('Claude not configured');
      return cleanChunkWithClaude(inputText, systemPrompt, config.claude.apiKey, config.claude.model, abortSignal);
    case 'openai':
      if (!config.openai?.apiKey || !config.openai?.model) throw new Error('OpenAI not configured');
      return cleanChunkWithOpenAI(inputText, systemPrompt, config.openai.apiKey, config.openai.model, abortSignal);
    case 'local':
      return cleanChunkWithLocal(inputText, systemPrompt, abortSignal);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/** Parsed result of one book-level footnote observation call, for the job report. */
export interface FootnotePrepassReport {
  status: 'applied' | 'no-markers' | 'failed' | 'no-substantial-chapter';
  reason: string;
  observation?: FootnoteObservation;
  matchCount?: number;
  derivedAnchors?: boolean;
  regexSource?: string;
  /** Chapters whose own sequence gate refused the deletion (markers kept there). */
  chapterGateSkips?: string[];
  /** Per-chapter off-chain matches spared in place (OCR-corrupt markers, intruders). */
  chapterOutliersSpared?: string[];
  /** First 600 chars of the model's raw answer when it failed to parse — diagnosability only. */
  rawAnswer?: string;
}

/** Book-level hyphen-arbitration outcome, for the job report. */
export interface HyphenPrepassReport {
  totalPairs: number;
  join: number;
  hyphen: number;
  unresolved: number;
  degradedPairs: string[];
}

/**
 * Run the footnote OBSERVATION model call on one substantial chapter, compose the
 * deletion regex in verified code, and self-check it. Returns the composed regex to
 * apply to every chapter (or null) plus a report. NEVER throws for a content-level
 * failure — a bad observation degrades to "delete nothing", recorded.
 */
async function planFootnoteRemoval(
  chapterText: string,
  config: AIProviderConfig,
  temperature: number,
  abortSignal?: AbortSignal
): Promise<{ regex: RegExp | null; report: FootnotePrepassReport }> {
  // Garbage-PDF exports put the whole book in one "chapter" (88 Reasons: 131k
  // chars) — past the num_ctx ceiling Ollama truncates silently, the
  // instructions fall out of the window, and the model summarizes the book
  // instead of emitting the JSON. Observe a bounded densest window instead; the
  // self-check below runs against the SAME window so the counts stay meaningful.
  const observedText = pickObservationWindow(chapterText);
  const numCtx = estimateNumCtxForBudget(FOOTNOTE_OBSERVATION_PROMPT, observedText, 4096,
    config.provider === 'ollama' ? config.ollama!.model : DEFAULT_MODEL);
  let answer: string;
  try {
    answer = await callProviderExtracted(observedText, FOOTNOTE_OBSERVATION_PROMPT, config, numCtx, temperature, 4096, abortSignal);
  } catch (e) {
    return { regex: null, report: { status: 'failed', reason: `observation call failed: ${(e as Error).message}` } };
  }
  const objText = firstJsonObject(answer);
  if (!objText) {
    return { regex: null, report: { status: 'failed', reason: 'no JSON object in footnote observation answer', rawAnswer: answer.slice(0, 600) } };
  }
  let obs: FootnoteObservation;
  try {
    obs = JSON.parse(objText) as FootnoteObservation;
  } catch (e) {
    return { regex: null, report: { status: 'failed', reason: `footnote observation JSON parse error: ${(e as Error).message}`, rawAnswer: answer.slice(0, 600) } };
  }
  let result = detectFootnotes(obs, observedText);
  if (!result.applied && chapterText !== observedText) {
    // Every sequence-proof path (count override, denial override) needs run
    // evidence, and the full chapter is a far richer sequence source than the
    // 12k observation window (Garbe: window's best consecutive run is 3, full
    // chapter's is 13). Pure code — no model context limit applies, and the
    // acceptance bars are unchanged; only the text the derivation walks grows.
    result = detectFootnotes(obs, chapterText);
  }
  if (!result.applied) {
    const status: FootnotePrepassReport['status'] = obs.has_markers === false ? 'no-markers' : 'failed';
    return { regex: null, report: { status, reason: result.reason, observation: obs, matchCount: result.matchCount } };
  }
  return {
    regex: result.regex,
    report: {
      status: 'applied',
      reason: result.reason,
      observation: obs,
      matchCount: result.matchCount,
      derivedAnchors: result.derivedAnchors,
      regexSource: result.regex!.source,
    },
  };
}

/**
 * Batch the unique hyphen pairs to the model (100 per call) and collect verdicts.
 * Any pair the model doesn't adjudicate (missing, unknown verdict, or a whole batch
 * that fails to parse) is left OUT of the map, so applyHyphenJoins takes the
 * conservative action and records it. Returns the verdict map + a report.
 */
async function planHyphenJoins(
  pairs: string[],
  config: AIProviderConfig,
  abortSignal?: AbortSignal
): Promise<{ verdicts: Map<string, HyphenVerdict>; report: HyphenPrepassReport }> {
  const verdicts = new Map<string, HyphenVerdict>();
  const BATCH = 100;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const prompt = buildHyphenVerdictPrompt(batch);
    // Budget scales with the batch (each verdict is small, but thinking over 100
    // items is not) so a full batch doesn't truncate into a REASONING_OVERRUN. A
    // truncated batch is still safe (its pairs stay unresolved → conservative).
    const numPredict = Math.max(4096, batch.length * 80);
    const numCtx = estimateNumCtxForBudget(prompt, 'Adjudicate every item above.', numPredict,
      config.provider === 'ollama' ? config.ollama!.model : DEFAULT_MODEL);
    let answer: string;
    try {
      // The pairs live in the system prompt; the user turn just triggers the answer.
      answer = await callProviderExtracted('Adjudicate every item above.', prompt, config, numCtx, 0.3, numPredict, abortSignal);
    } catch (e) {
      console.warn(`[AI-CLEANUP] Hyphen verdict batch ${i / BATCH} failed: ${(e as Error).message} — those pairs take the conservative action`);
      continue; // batch parse failure → all its pairs stay unresolved (conservative)
    }
    const objText = firstJsonObject(answer);
    if (!objText) { console.warn('[AI-CLEANUP] Hyphen verdict batch had no JSON — conservative'); continue; }
    let parsed: { verdicts?: Array<{ pair?: unknown; verdict?: unknown }> };
    try { parsed = JSON.parse(objText); } catch { console.warn('[AI-CLEANUP] Hyphen verdict batch JSON parse failed — conservative'); continue; }
    for (const v of parsed.verdicts || []) {
      const pair = typeof v?.pair === 'string' ? v.pair : '';
      const verdict = v?.verdict;
      if (!pair) continue;
      if (verdict === 'join' || verdict === 'hyphen') verdicts.set(pair, verdict);
      // unknown verdict string → leave unresolved (conservative + recorded downstream)
    }
  }
  let join = 0, hyphen = 0;
  for (const v of verdicts.values()) { if (v === 'join') join++; else hyphen++; }
  const unresolved = pairs.filter(p => !verdicts.has(p));
  return {
    verdicts,
    report: { totalPairs: pairs.length, join, hyphen, unresolved: unresolved.length, degradedPairs: unresolved },
  };
}

/**
 * The one edit-list cleanup pass for a single prose chunk. The chunk has already
 * been through the deterministic pre-passes (footnotes gone, hyphens joined, quotes
 * straightened). Builds the per-chunk few-shot from a fresh damage scan, calls the
 * model for an edit list, and applies it with the guarded applier.
 *
 * Failure handling (no content-correlated retries; every outcome recorded):
 *  - REASONING_OVERRUN  → keep original chunk, skippedChunk 'reasoning-overrun'.
 *  - JSON parse failure → keep original chunk, skippedChunk 'edit-parse-fail'.
 *  - network error      → retried with backoff (input-independent), else kept + 'error'.
 * The returned "cleaned" text is simply the chunk after the applied edits.
 */
async function cleanChunkEditList(
  chunkText: string,
  editListPrompt: string,
  customInstructions: string | undefined,
  config: AIProviderConfig,
  state: CleanupJobState,
  jobNumCtx: number,
  jobTemperature: number,
  maxRetries: number,
  abortSignal: AbortSignal | undefined,
  chunkMeta: ChunkMeta
): Promise<string> {
  const fewShot = buildFewShotBlock(scanDamagedWords(chunkText));
  const systemPrompt =
    editListPrompt + '\n\n' + fewShot +
    (customInstructions ? `\n\nADDITIONAL INSTRUCTIONS:\n${customInstructions}` : '');

  const recordChunkKept = (reason: SkippedChunk['reason'], aiResponse: string) => {
    state.errorFallbackCount++;
    state.skippedChunks.push({
      chapterTitle: chunkMeta.chapterTitle,
      chunkIndex: chunkMeta.chunkIndex,
      overallChunkNumber: chunkMeta.overallChunkNumber,
      totalChunks: chunkMeta.totalChunks,
      reason,
      text: chunkText,
      aiResponse: aiResponse.substring(0, 500),
    });
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (abortSignal?.aborted) throw new Error('Job cancelled');
    let answer: string;
    try {
      answer = await callProviderExtracted(chunkText, systemPrompt, config, jobNumCtx, jobTemperature, 4096, abortSignal);
    } catch (error) {
      if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error('Job cancelled');
      }
      // Reasoning overrun: no answer was produced. Content-correlated → no re-roll.
      if (error instanceof Error && error.message.includes('REASONING_OVERRUN')) {
        console.warn('[AI-CLEANUP:editlist] Reasoning overrun — keeping original chunk (no retry)');
        recordChunkKept('reasoning-overrun', error.message);
        state.editLog.push({ chapterTitle: chunkMeta.chapterTitle, overallChunkNumber: chunkMeta.overallChunkNumber, status: 'CHUNK_PARSE_FAIL', detail: 'reasoning-overrun' });
        return chunkText;
      }
      // Network/transport errors are input-independent → retry with backoff.
      const msg = error instanceof Error ? error.message : String(error);
      const retryable = /fetch|network|ECONNREFUSED|ECONNRESET|socket|timeout/i.test(msg);
      if (retryable && attempt < maxRetries) {
        console.warn(`[AI-CLEANUP:editlist] chunk attempt ${attempt} failed (${msg}), retrying in ${attempt * 2}s...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        lastError = error as Error;
        continue;
      }
      throw error;
    }

    // Parse the edit list. A parse failure is content-correlated → keep original,
    // record 'edit-parse-fail', NO retry.
    const objText = firstJsonObject(answer);
    if (!objText) {
      console.warn('[AI-CLEANUP:editlist] no JSON object in answer — keeping original chunk');
      recordChunkKept('edit-parse-fail', answer);
      state.editLog.push({ chapterTitle: chunkMeta.chapterTitle, overallChunkNumber: chunkMeta.overallChunkNumber, status: 'CHUNK_PARSE_FAIL', detail: 'no JSON object in answer' });
      return chunkText;
    }
    let parsed: { edits?: Array<{ find?: unknown; replace?: unknown }> };
    try {
      parsed = JSON.parse(objText);
    } catch (e) {
      console.warn(`[AI-CLEANUP:editlist] JSON parse failed (${(e as Error).message}) — keeping original chunk`);
      recordChunkKept('edit-parse-fail', answer);
      state.editLog.push({ chapterTitle: chunkMeta.chapterTitle, overallChunkNumber: chunkMeta.overallChunkNumber, status: 'CHUNK_PARSE_FAIL', detail: `json parse: ${(e as Error).message}` });
      return chunkText;
    }

    const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
    const { text, records } = applyEditList(chunkText, edits);
    for (const r of records) {
      state.editLog.push({
        chapterTitle: chunkMeta.chapterTitle,
        overallChunkNumber: chunkMeta.overallChunkNumber,
        status: r.status,
        find: r.find,
        replace: r.replace,
        count: r.count,
        span: r.span,
      });
    }
    return text;
  }
  throw lastError || new Error('Failed to clean chunk (edit-list) after retries');
}

/**
 * Clean up text with streaming progress updates
 */
export async function cleanupText(
  text: string,
  options: AICleanupOptions,
  chapterId: string,
  chapterTitle: string,
  model: string = DEFAULT_MODEL,
  mainWindow?: BrowserWindow | null
): Promise<CleanupResult> {
  // Check connection first
  const connection = await checkConnection();
  if (!connection.connected) {
    return { success: false, error: `Ollama not available: ${connection.error}` };
  }

  // Check if model is available
  if (!(await hasModel(model))) {
    return { success: false, error: `Model '${model}' not found. Run: ollama pull ${model}` };
  }

  // Reload prompt from disk so external changes (e.g., Syncthing pull) take effect
  // without restarting the app
  cachedPrompt = await loadPrompt();
  const systemPrompt = buildCleanupPrompt(options);

  // Split text into chunks at logical break points
  const chunks: string[] = [];

  // If text fits in one chunk, don't split
  if (text.length <= CHUNK_SIZE) {
    chunks.push(text);
  } else {
    let pos = 0;
    while (pos < text.length) {
      const targetEnd = Math.min(pos + CHUNK_SIZE, text.length);
      const end = findBestBreakPoint(text, targetEnd, pos);
      chunks.push(text.substring(pos, end));
      pos = end;
    }
  }

  const uniqueChunks = chunks;

  // Pin num_ctx once for the whole call, sized to the largest chunk, so Ollama
  // loads the model a single time instead of reloading on every chunk (any
  // num_ctx change forces a full runner reload). Every smaller chunk fits.
  const longestChunk = uniqueChunks.reduce((a, b) => (b.length > a.length ? b : a), '');
  const jobNumCtx = estimateNumCtx(systemPrompt, longestChunk, 2, model);

  // Process each chunk
  const cleanedChunks: string[] = [];
  for (let i = 0; i < uniqueChunks.length; i++) {
    // Send progress update
    if (mainWindow) {
      const progress: CleanupProgress = {
        chapterId,
        chapterTitle,
        currentChunk: i + 1,
        totalChunks: uniqueChunks.length,
        percentage: Math.round(((i + 1) / uniqueChunks.length) * 100)
      };
      mainWindow.webContents.send('ai:cleanup-progress', progress);
    }

    // Build chunk metadata for skipped chunk tracking
    const chunkMeta: ChunkMeta = {
      chapterTitle,
      chunkIndex: i,
      overallChunkNumber: i + 1,
      totalChunks: uniqueChunks.length
    };

    try {
      const cleaned = await cleanChunk(uniqueChunks[i], systemPrompt, model, jobNumCtx, 0.1, undefined, chunkMeta);
      cleanedChunks.push(cleaned);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed on chunk ${i + 1}: ${message}` };
    }
  }

  return { success: true, cleanedText: cleanedChunks.join('') };
}

/**
 * Clean up a chapter with streaming response for real-time progress
 */
export async function cleanupChapterStreaming(
  text: string,
  options: AICleanupOptions,
  model: string = DEFAULT_MODEL,
  onToken?: (token: string) => void
): Promise<CleanupResult> {
  const connection = await checkConnection();
  if (!connection.connected) {
    return { success: false, error: `Ollama not available: ${connection.error}` };
  }

  // Reload prompt from disk so external changes take effect without restart
  cachedPrompt = await loadPrompt();
  const systemPrompt = buildCleanupPrompt(options);

  try {
    // Capability-gated: thinking models (e.g. qwen3) get think:false so the
    // generation budget goes to the answer, not a discarded chain-of-thought.
    const thinkFields = await getOllamaThinkFields(OLLAMA_BASE_URL, model);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: text,
        system: systemPrompt,
        stream: true,
        ...thinkFields,
        options: {
          temperature: 0.1,
          num_predict: text.length * 2,
          // Pin to the model's ceiling (a constant per model) rather than a
          // per-call estimate: this endpoint is invoked once per chapter, and a
          // varying num_ctx would reload the runner between chapters. The ceiling
          // is already sized to fit weights + KV on the GPU.
          num_ctx: numCtxMaxForModel(model)
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.response) {
            fullResponse += data.response;
            if (onToken) {
              onToken(data.response);
            }
          }
        } catch {
          // Ignore JSON parse errors for incomplete chunks
        }
      }
    }

    return { success: true, cleanedText: fullResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB OCR Cleanup (for queue processing)
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubCleanupProgress {
  jobId: string;
  phase: 'loading' | 'processing' | 'saving' | 'complete' | 'error';
  currentChapter: number;
  totalChapters: number;
  currentChunk: number;      // Current chunk number (1-indexed, job-wide)
  totalChunks: number;       // Total chunks in entire job
  percentage: number;
  message?: string;
  error?: string;            // Error message when phase is 'error'
  outputPath?: string;  // Path to cleaned/simplified EPUB (available during processing for diff view)
  // Timing data for dynamic ETA calculation
  chunksCompletedInJob?: number;  // Cumulative chunks completed across all chapters
  totalChunksInJob?: number;      // Total chunks in entire job (same as totalChunks)
  chunkCompletedAt?: number;      // Timestamp when last chunk completed
  completedInSession?: number;    // Chunks completed in THIS session only (excludes checkpoint)
}

export interface CleanupJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalChapters: number;
  totalChunks: number;
  totalCharacters: number;
  chunksPerMinute: number;
  charactersPerMinute: number;
  model: string;
  success: boolean;
  chaptersProcessed: number;
  copyrightChunksAffected: number;
  contentSkipsAffected: number;
  markerMismatchAffected: number;
  truncatedChunksAffected: number;
  skippedChunksPath?: string;
  error?: string;
}

export interface EpubCleanupResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  chaptersProcessed?: number;
  copyrightIssuesDetected?: boolean;  // True if any chunks triggered copyright refusal
  copyrightChunksAffected?: number;   // Number of chunks that fell back to original due to copyright
  contentSkipsDetected?: boolean;     // True if AI returned [SKIP] for non-trivial content
  contentSkipsAffected?: number;      // Number of chunks where AI refused via [SKIP]
  markerMismatchDetected?: boolean;   // True if AI dropped/added [[BLOCK]] markers
  markerMismatchAffected?: number;    // Number of chunks that fell back due to marker mismatch
  truncatedDetected?: boolean;        // True if AI returned <70% output for some chunks
  truncatedAffected?: number;         // Number of chunks that fell back due to truncation
  skippedChunksPath?: string;         // Path to JSON file containing skipped chunk details
  analytics?: CleanupJobAnalytics;    // Analytics data for the job
}

/**
 * Free the cleanup model's VRAM at JOB end.
 *
 * Every chunk request carries keep_alive:'5m', which is what keeps the model hot
 * BETWEEN chunks — without it Ollama would evict and fully reload the runner on
 * every chunk. But that same window means the model squats in VRAM for 5 minutes
 * AFTER the final chunk, which is pure waste: the job is over, and a following GPU
 * phase (TTS) would otherwise wait on VRAM that nothing is using. Unloading here
 * costs nothing — the next job reloads it anyway.
 *
 * Best-effort by design: a failed unload must never fail a completed cleanup job.
 * The VRAM preflight in gpu-arbiter remains the backstop.
 */
async function releaseCleanupModel(config: AIProviderConfig): Promise<void> {
  if (config.provider !== 'ollama' || !config.ollama?.model) return;
  const model = config.ollama.model;
  try {
    const { unloadOllamaModel } = await import('./gpu-arbiter.js');
    await unloadOllamaModel(model);
    console.log(`[AI-CLEANUP] Released ${model} from VRAM (job complete — not waiting out keep_alive)`);
  } catch (err) {
    console.warn(`[AI-CLEANUP] Could not release ${model} from VRAM: ${(err as Error).message}`);
  }
}

/**
 * Process an entire EPUB through OCR cleanup.
 * Cleans all chapters and saves a modified EPUB.
 * Requires explicit AI provider configuration - no fallbacks.
 *
 * @param options Optional detailed cleanup settings
 * @param options.deletedBlockExamples User-marked deletions to use as few-shot examples
 * @param options.useDetailedCleanup Whether to enable detailed cleanup mode
 */
export async function cleanupEpub(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: EpubCleanupProgress) => void) | undefined,
  providerConfig: AIProviderConfig,
  options?: {
    deletedBlockExamples?: DeletedBlockExample[];
    useDetailedCleanup?: boolean;
    useParallel?: boolean;
    parallelWorkers?: number;
    testMode?: boolean;
    testModeChunks?: number;  // Number of chunks to process in test mode
    enableAiCleanup?: boolean;  // Standard OCR/formatting cleanup (default: true)
    simplifyForChildren?: boolean;  // Simplify for language learners
    // Selectable simplify mode. Current: 'dejargon' | 'destiffen' | 'learner'.
    // Legacy values 'learning'/'plain' from queued/resumed jobs are still accepted
    // (mapped in resolveSimplifyMode). Unknown values throw — no silent default.
    simplifyMode?: SimplifyMode | 'learning' | 'plain';
    cleanupPrompt?: string;  // Custom cleanup prompt (overrides default)
    customInstructions?: string;  // Additional instructions appended to the AI prompt
    outputDir?: string;  // Override output directory (default: same dir as input EPUB)
    chunkSize?: number;  // Override prose chunk size (chars). Default: CHUNK_SIZE (8000).
    temperature?: number;  // Override model sampling temperature. Default: 0.1 (consistent output).
  }
): Promise<EpubCleanupResult> {
  // Debug logging to trace provider selection
  const testMode = options?.testMode || false;
  const TEST_MODE_CHUNK_LIMIT = options?.testModeChunks || 5;
  // Job-scoped prose chunk size. Threaded to BOTH chunking and reassembly so their
  // recomputed chunk layouts stay identical (see rebuildChapterPreservingHeadings).
  // A positive override wins; otherwise the per-TASK default: cleanup 2000 (the
  // edit-list format validated at ~2000, ledger §7), simplify 4000 (generative — the
  // model rewrites larger spans coherently). Only the DEFAULT differs per task; an
  // explicit options.chunkSize (e.g. CLI --chunk-size) still wins. No silent mask.
  const DEFAULT_CLEANUP_CHUNK = 2000;
  const DEFAULT_SIMPLIFY_CHUNK = 4000;
  const defaultChunkSize = options?.simplifyForChildren ? DEFAULT_SIMPLIFY_CHUNK : DEFAULT_CLEANUP_CHUNK;
  const jobChunkSize = options?.chunkSize && options.chunkSize > 0 ? options.chunkSize : defaultChunkSize;
  if (options?.chunkSize) console.log(`[AI-BRIDGE] chunkSize override: ${jobChunkSize} chars`);
  else console.log(`[AI-BRIDGE] chunkSize default for ${options?.simplifyForChildren ? 'simplify' : 'cleanup'}: ${jobChunkSize} chars`);
  // Job-scoped sampling temperature. Threaded to the provider call. 0 is a valid
  // (fully-deterministic) request, so the guard accepts any finite value >= 0; only
  // an absent/NaN/negative value falls to the established 0.1 default. No silent mask.
  const jobTemperature = typeof options?.temperature === 'number' && isFinite(options.temperature) && options.temperature >= 0
    ? options.temperature : 0.1;
  if (options?.temperature !== undefined) console.log(`[AI-BRIDGE] temperature override: ${jobTemperature}`);
  console.log('[AI-BRIDGE] cleanupEpub called with:', {
    provider: providerConfig.provider,
    ollamaModel: providerConfig.ollama?.model,
    claudeModel: providerConfig.claude?.model,
    openaiModel: providerConfig.openai?.model,
    useDetailedCleanup: options?.useDetailedCleanup,
    exampleCount: options?.deletedBlockExamples?.length || 0,
    useParallel: options?.useParallel,
    parallelWorkers: options?.parallelWorkers,
    testMode
  });

  // Prevent system sleep during cleanup
  startAIPowerBlock();

  // Per-job fallback/skip accounting — owned by THIS call so it can run
  // concurrently with another cleanup job (e.g. a cloud job in the cloud lane
  // alongside a GPU/Ollama job) without cross-contaminating counters or skips.
  const jobState = newCleanupJobState();

  // providerConfig is required - no fallbacks
  const config = providerConfig;

  // Validate provider configuration
  if (config.provider === 'ollama') {
    if (!config.ollama?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'Ollama model not specified in config' };
    }
    const connection = await checkConnection();
    if (!connection.connected) {
      stopAIPowerBlock();
      return { success: false, error: `Ollama not available: ${connection.error}` };
    }
    if (!(await hasModel(config.ollama.model))) {
      stopAIPowerBlock();
      return { success: false, error: `Model '${config.ollama.model}' not found. Run: ollama pull ${config.ollama.model}` };
    }
    console.log(`[AI-BRIDGE] Running Ollama generate preflight for ${config.ollama.model}...`);
    const generateCheck = await verifyOllamaGenerate(config.ollama.model);
    if (!generateCheck.ok) {
      stopAIPowerBlock();
      return { success: false, error: `Ollama is reachable but not serving generate requests: ${generateCheck.error}` };
    }
    console.log('[AI-BRIDGE] Ollama generate preflight passed');
  } else if (config.provider === 'claude') {
    if (!config.claude?.apiKey) {
      stopAIPowerBlock();
      return { success: false, error: 'Claude API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.claude?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'Claude model not specified in config' };
    }
  } else if (config.provider === 'openai') {
    if (!config.openai?.apiKey) {
      stopAIPowerBlock();
      return { success: false, error: 'OpenAI API key not configured. Go to Settings > AI to configure.' };
    }
    if (!config.openai?.model) {
      stopAIPowerBlock();
      return { success: false, error: 'OpenAI model not specified in config' };
    }
  } else if (config.provider === 'local') {
    const { llamaBridge } = await import('./llama-bridge.js');
    const s = await llamaBridge.status();
    if (!s.binaryPresent) {
      stopAIPowerBlock();
      return { success: false, error: 'The local AI engine is not bundled in this build.' };
    }
    if (!s.activeModelDownloaded) {
      stopAIPowerBlock();
      return { success: false, error: 'No local model is downloaded. Download one in AI Setup.' };
    }
  } else {
    stopAIPowerBlock();
    return { success: false, error: `Unknown AI provider: ${config.provider}` };
  }

  // Create AbortController for this job - allows immediate cancellation
  const abortController = new AbortController();
  // Increase max listeners to avoid warnings with parallel processing
  // Each fetch call adds an abort listener, so with 5 workers * many chunks we need more
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setMaxListeners } = require('events') as { setMaxListeners?: (n: number, target: EventTarget) => void };
    if (setMaxListeners) {
      setMaxListeners(200, abortController.signal);
    }
  } catch {
    // Older Node versions may not support this - warning is harmless
  }
  activeCleanupJobs.set(jobId, { controller: abortController, provider: config.provider });
  console.log(`[AI-BRIDGE] Job ${jobId} registered for cancellation support`);

  const sendProgress = (progress: EpubCleanupProgress) => {
    // Console log for visibility in terminal
    const chunkInfo = progress.chunkCompletedAt ? ` [completed @ ${new Date(progress.chunkCompletedAt).toLocaleTimeString()}]` : '';
    console.log(`[AI-CLEANUP] [${jobId.substring(0, 8)}] ${progress.phase.toUpperCase()} - Chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.percentage}%) - ${progress.message || ''}${chunkInfo}`);

    if (onProgress) onProgress(progress);
    if (mainWindow) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        type: 'ocr-cleanup',
        phase: progress.phase,
        progress: progress.percentage,
        message: progress.message,
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks,
        currentChapter: progress.currentChapter,
        totalChapters: progress.totalChapters,
        outputPath: progress.outputPath,
        // Timing data for dynamic ETA
        chunksCompletedInJob: progress.chunksCompletedInJob,
        totalChunksInJob: progress.totalChunksInJob,
        chunkCompletedAt: progress.chunkCompletedAt
      });
    }
  };

  // Use a dedicated EpubProcessor instance for cleanup
  // This avoids conflicts with the global processor used by the UI
  let processor: InstanceType<typeof import('./epub-processor.js').EpubProcessor> | null = null;
  const modifiedChapters: Map<string, string> = new Map();

  // Pre-pass reports hoisted here so they can be persisted on BOTH the success and
  // the error path (the planning happens inside the try below).
  let footnoteReportOut: FootnotePrepassReport | undefined;
  let hyphenReportOut: HyphenPrepassReport | undefined;
  // Recompute the report dir the same way the success/skip writers do.
  const reportDir = options?.outputDir || path.dirname(epubPath);
  const persistCleanupReports = async () => {
    try {
      if (jobState.editLog.length > 0) {
        await fsPromises.writeFile(path.join(reportDir, 'edit-log.json'), JSON.stringify(jobState.editLog, null, 2), 'utf-8');
        console.log(`[AI-CLEANUP] Wrote edit-log.json (${jobState.editLog.length} edits)`);
      }
      if (footnoteReportOut || hyphenReportOut) {
        await fsPromises.writeFile(
          path.join(reportDir, 'cleanup-prepass-report.json'),
          JSON.stringify({ footnote: footnoteReportOut, hyphen: hyphenReportOut }, null, 2),
          'utf-8'
        );
        console.log('[AI-CLEANUP] Wrote cleanup-prepass-report.json');
      }
    } catch (e) {
      console.warn(`[AI-CLEANUP] Failed to persist cleanup reports: ${(e as Error).message}`);
    }
  };

  try {
    // Import epub processor class directly (not the global functions)
    const { EpubProcessor } = await import('./epub-processor.js');

    // Load the EPUB with our own processor instance
    sendProgress({
      jobId,
      phase: 'loading',
      currentChapter: 0,
      totalChapters: 0,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 0,
      message: 'Loading EPUB...'
    });

    processor = new EpubProcessor();
    await processor.open(epubPath);
    const structure = processor.getStructure();
    const chapters = structure?.chapters || [];
    const totalChapters = chapters.length;

    if (totalChapters === 0 || !structure) {
      processor.close();
      stopAIPowerBlock();
      return { success: false, error: 'No chapters found in EPUB' };
    }

    // Extract the book's language from metadata for language-specific prompts
    const bookLanguage = structure?.metadata?.language || 'en';
    console.log(`[AI-BRIDGE] Book language detected: ${bookLanguage}`);

    // Build system prompt based on processing options
    // Default: enableAiCleanup is true for backwards compatibility
    const enableAiCleanup = options?.enableAiCleanup !== false;
    const simplifyForChildren = options?.simplifyForChildren === true;
    // Resolve the wire-level mode value to a canonical SimplifyMode. Validated
    // (throws on unknown, maps legacy 'plain'/'learning' + undefined) rather than
    // a silent `|| 'learning'` default — see resolveSimplifyMode. Only meaningful
    // when simplifying, so only resolved then.
    const simplifyMode: SimplifyMode | null = simplifyForChildren
      ? resolveSimplifyMode(options?.simplifyMode ?? undefined)
      : null;

    // Explicit task flag for the chunk pipeline — decided HERE, where the
    // prompt is chosen, and threaded through cleanChunkWithProvider so the
    // simplify-specific safeguards never depend on prompt text literals.
    const task: CleanupTask = simplifyForChildren ? 'simplify' : 'cleanup';

    // Detailed cleanup (user-marked block deletions) needs a DELETING rewrite, which
    // the edit-list applier structurally forbids — so it keeps the legacy full-rewrite
    // path. Everything else in the pure-cleanup task uses the new edit-list pipeline.
    const hasDeletionExamples = !!(options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0);
    // The edit-list redesign applies to the pure cleanup task only: not simplify,
    // not a custom rewrite prompt, not detailed-cleanup deletions.
    const useEditList = task === 'cleanup' && !options?.cleanupPrompt && !hasDeletionExamples;

    let systemPrompt: string;
    let editListPrompt = '';

    // Edit-list cleanup: the model emits a JSON edit list, not rewritten text. The
    // per-chunk few-shot and customInstructions are added inside cleanChunkEditList;
    // systemPrompt here is the base (for num_ctx sizing + logging).
    if (useEditList) {
      editListPrompt = await loadEditListPrompt();
      systemPrompt = editListPrompt;
      console.log('[AI-BRIDGE] Mode: AI Cleanup (edit-list + deterministic pre-passes)');
    } else if (options?.cleanupPrompt) {
      systemPrompt = options.cleanupPrompt;
      console.log('[AI-BRIDGE] Using custom cleanup prompt');
    } else if (enableAiCleanup && simplifyForChildren) {
      // BOTH: Standard cleanup + simplification
      // Use language-specific prompt to prevent unwanted translation
      systemPrompt = getOcrCleanupSystemPrompt(bookLanguage);
      if (options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0) {
        const examplesSection = buildExamplesSection(options.deletedBlockExamples);
        systemPrompt = systemPrompt + examplesSection;
        console.log(`[AI-BRIDGE] Added ${options.deletedBlockExamples.length} deletion examples to system prompt`);
      }
      // Bolt the selected simplify mode's rewrite RULES onto the cleanup prompt.
      // We append only the rules body (not a second full prompt) so there is one
      // output/[SKIP] contract — two contracts made the model emit a stray [SKIP].
      const simplifyRules = simplifyRulesBody(await getSimplifyPrompt(simplifyMode!));
      systemPrompt =
        systemPrompt +
        '\n\nAFTER the fixes above, REWRITE the cleaned text as follows, then output ONLY the finished text.\n\n' +
        simplifyRules;
      console.log(`[AI-BRIDGE] Mode: AI Cleanup + Simplify (${simplifyMode})`);
    } else if (simplifyForChildren && !enableAiCleanup) {
      // SIMPLIFY ONLY: use the selected mode's standalone prompt (no cleanup).
      systemPrompt = await getSimplifyPrompt(simplifyMode!);
      console.log(`[AI-BRIDGE] Mode: Simplify only (${simplifyMode})`);
    } else {
      // CLEANUP ONLY: Standard cleanup without simplification
      // Use language-specific prompt to prevent unwanted translation
      systemPrompt = getOcrCleanupSystemPrompt(bookLanguage);
      if (options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0) {
        const examplesSection = buildExamplesSection(options.deletedBlockExamples);
        systemPrompt = systemPrompt + examplesSection;
        console.log(`[AI-BRIDGE] Added ${options.deletedBlockExamples.length} deletion examples to system prompt`);
      }
      console.log('[AI-BRIDGE] Mode: AI Cleanup ONLY (no simplification)');
    }

    // Append custom instructions if provided. Skipped for the edit-list path — there
    // customInstructions are appended per-chunk inside cleanChunkEditList (after the
    // few-shot block), so they don't bloat the num_ctx-sizing base prompt.
    if (options?.customInstructions && !useEditList) {
      systemPrompt += `\n\nADDITIONAL INSTRUCTIONS:\n${options.customInstructions}`;
      console.log(`[AI-BRIDGE] Appended custom instructions (${options.customInstructions.length} chars)`);
    }

    // Simplify is generative (full rewrite). Turn on cogito's in-band reasoning and
    // require the finished text inside <answer> tags, routed through extractAnswer so
    // an unclosed answer degrades to REASONING_OVERRUN (keep original + record), never
    // leaks reasoning. Centralized here so BOTH simplify-only and cleanup+simplify get
    // it (and it overrides the files' plain "output only the text" contract). Cleanup's
    // edit-list prompt already carries its own thinking trigger + answer contract.
    if (task === 'simplify') {
      systemPrompt =
        `${THINKING_TRIGGER}\n\n${systemPrompt}\n\n` +
        'OUTPUT FORMAT (this overrides any earlier instruction about how to output): ' +
        'First think through the rewrite. Then write your COMPLETE rewritten text — every ' +
        'paragraph, start to finish — inside a single <answer> ... </answer> block, and put ' +
        'nothing after </answer>. If the input is empty or unreadable, put exactly [SKIP] ' +
        'inside the answer block.';
      console.log('[AI-BRIDGE] Simplify: thinking enabled, output wrapped in <answer> tags');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deterministic pre-passes (edit-list cleanup only): footnote-marker removal
    // → line-break hyphen joins → quote normalization. Planned once per book from
    // model OBSERVATIONS (verified code composes/applies), then applied to every
    // chapter's prose via `preprocess`, which is threaded into chunkChapterProse
    // AND rebuildChapterPreservingHeadings so their chunk layouts stay identical.
    // ─────────────────────────────────────────────────────────────────────────
    let preprocessFor: ((chapterXhtml: string) => (proseText: string) => string) | undefined;
    if (useEditList) {
      // Gather across the whole book: the best OBSERVATION chapter for footnotes,
      // and every unique hyphen-split pair (hyphen arbitration). The observation
      // chapter is the one with the most deterministic digit-marker CANDIDATES —
      // observing the first chapter regardless (Killing America: an intro with no
      // markers) makes the model correctly report has_markers=false and the whole
      // book keeps its markers. Falls back to the first substantial chapter.
      const hyphenPairSet = new Set<string>();
      let footnoteChapterText: string | null = null;
      let bestCandidates = 0;
      let firstSubstantialText: string | null = null;
      for (const chapter of chapters) {
        const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
        let xhtml: string;
        try { xhtml = await processor.readFile(href); } catch { continue; }
        const text = extractChapterAsText(xhtml);
        if (!text.trim()) continue;
        for (const p of extractHyphenPairs(text)) hyphenPairSet.add(p);
        if (text.length >= 2000) {
          if (!firstSubstantialText) firstSubstantialText = text;
          const cand = scoreFootnoteCandidates(text);
          if (cand > bestCandidates) { bestCandidates = cand; footnoteChapterText = text; }
        }
      }
      if (!footnoteChapterText || bestCandidates < 3) footnoteChapterText = footnoteChapterText || firstSubstantialText;
      if (bestCandidates > 0) console.log(`[AI-CLEANUP] Footnote observation chapter picked by candidate density (${bestCandidates} candidates)`);

      // Footnote markers: one observation call on the chosen chapter.
      let footnoteRegex: RegExp | null = null;
      let footnoteObservation: FootnoteObservation | undefined;
      if (footnoteChapterText) {
        const fn = await planFootnoteRemoval(footnoteChapterText, config, 0.3, abortController.signal);
        footnoteRegex = fn.regex;
        footnoteObservation = fn.report.observation;
        footnoteReportOut = fn.report;
        console.log(`[AI-CLEANUP] Footnote pre-pass: ${fn.report.status} — ${fn.report.reason}`);
      } else {
        footnoteReportOut = { status: 'no-substantial-chapter', reason: 'no chapter with >=2000 chars of text' };
        console.log('[AI-CLEANUP] Footnote pre-pass: skipped (no substantial chapter)');
      }

      // Hyphen joins: batched arbitration over the unique pairs.
      const hyphenPairs = [...hyphenPairSet];
      let hyphenVerdicts = new Map<string, HyphenVerdict>();
      if (hyphenPairs.length > 0) {
        const hj = await planHyphenJoins(hyphenPairs, config, abortController.signal);
        hyphenVerdicts = hj.verdicts;
        hyphenReportOut = hj.report;
        console.log(`[AI-CLEANUP] Hyphen pre-pass: ${hyphenPairs.length} pairs — join=${hj.report.join} hyphen=${hj.report.hyphen} unresolved=${hj.report.unresolved}`);
      } else {
        hyphenReportOut = { totalPairs: 0, join: 0, hyphen: 0, unresolved: 0, degradedPairs: [] };
        console.log('[AI-CLEANUP] Hyphen pre-pass: no line-break hyphen splits found');
      }

      // The deterministic transform, built PER CHAPTER: the book-level self-check
      // proved the footnote regex on the observed chapter only, so every other
      // chapter must earn its deletions from its own text via chain selection
      // (selectFootnoteDeletions) — the longest ascending subsequence of matches
      // is deleted, everything off-chain (a `. 40 million` intruder, an
      // OCR-corrupted marker like Garbe's `211`) is SPARED in place. Values that
      // appear more than once among the chapter's matches are ambiguous (one may
      // be prose) and are spared entirely. The transform runs per prose SEGMENT
      // in two passes (chunker + rebuild), so it deletes by VALUE-set —
      // stateless and order-independent. Hyphen joins + quote norm apply
      // unconditionally. Skips and spared outliers go to the report once.
      const chapterGateCache = new Map<string, (proseText: string) => string>();
      preprocessFor = (chapterXhtml: string) => {
        const cached = chapterGateCache.get(chapterXhtml);
        if (cached) return cached;
        let chapterFootnoteRegex: RegExp | null = null;
        // null = delete every match (non-arabic markers carry no values to gate on)
        let allowedValues: Set<number> | null = null;
        if (footnoteRegex && footnoteObservation) {
          const chapterText = extractChapterAsText(chapterXhtml);
          const sel = selectFootnoteDeletions(chapterText, footnoteRegex, footnoteObservation);
          if (!sel.apply) {
            if (footnoteReportOut) {
              (footnoteReportOut.chapterGateSkips ??= []).push(sel.reason);
            }
            console.log(`[AI-CLEANUP] Footnote chapter gate SKIP: ${sel.reason}`);
          } else if (sel.deletions.length > 0) {
            chapterFootnoteRegex = footnoteRegex;
            if ((footnoteObservation.marker_type || 'arabic') === 'arabic') {
              const counts = new Map<number, number>();
              for (const m of chapterText.matchAll(new RegExp(footnoteRegex.source, 'g'))) {
                const v = parseInt(m[0], 10);
                counts.set(v, (counts.get(v) ?? 0) + 1);
              }
              allowedValues = new Set(sel.deletions.map(d => d.value).filter(v => counts.get(v) === 1));
            }
            if (sel.keptOutliers.length > 0) {
              const note = `spared off-chain matches: [${sel.keptOutliers.join(',')}]`;
              if (footnoteReportOut) (footnoteReportOut.chapterOutliersSpared ??= []).push(note);
              console.log(`[AI-CLEANUP] Footnote chapter: ${note}`);
            }
          }
        }
        const transform = (proseText: string): string => {
          let t = proseText;
          if (chapterFootnoteRegex) {
            const av = allowedValues;
            t = t.replace(new RegExp(chapterFootnoteRegex.source, 'g'),
              m => (av === null || av.has(parseInt(m, 10))) ? '' : m);
          }
          t = applyHyphenJoins(t, hyphenVerdicts).text;
          t = normalizeQuotes(t);
          return t;
        };
        chapterGateCache.set(chapterXhtml, transform);
        return transform;
      };
    }

    let chaptersProcessed = 0;
    let chunksCompletedInJob = 0;  // Cumulative chunk counter across all chapters
    let chunksCompletedInSession = 0;  // Chunks completed in THIS session (excludes checkpoint)
    let totalCharactersProcessed = 0;  // Track total characters for analytics
    const cleanupStartTime = Date.now();  // Track start time for analytics
    let firstChunkCompletedAt: number | null = null;  // Track first chunk time for rate calculation

    // Helper to calculate rate display string
    const getRateDisplay = (): string => {
      // Session-relative, not cumulative: firstChunkCompletedAt marks the first chunk of
      // THIS session, so the numerator must count only this session's chunks. Using the
      // cumulative chunksCompletedInJob on a continued job divides pre-resume chunks by
      // this-session elapsed → an inflated rate. -1 because firstChunkCompletedAt is set
      // after the first session chunk completes.
      if (!firstChunkCompletedAt || chunksCompletedInSession < 2) return '';
      const workSeconds = (Date.now() - firstChunkCompletedAt) / 1000;
      if (workSeconds < 10) return '';  // Need at least 10 seconds of data
      const chunksPerMinute = ((chunksCompletedInSession - 1) / workSeconds) * 60;
      return ` (${chunksPerMinute.toFixed(1)} chunks/min)`;
    };

    // Generate output path - save as cleaned.epub or simplified.epub
    // If outputDir is specified, write there; otherwise write alongside the source EPUB
    const epubDir = options?.outputDir || path.dirname(epubPath);
    if (options?.outputDir) {
      await fsPromises.mkdir(options.outputDir, { recursive: true });
    }
    const outputFilename = options?.simplifyForChildren ? 'simplified.epub' : 'cleaned.epub';
    const outputPath = path.join(epubDir, outputFilename);

    // Track which chapters have been added to diff cache (for parallel processing)
    const chaptersAddedToDiffCache = new Set<string>();

    // Track completed chapters for resume (populated from checkpoint below)
    const completedChapterIds = new Set<string>();
    let isResuming = false;

    // Check for existing checkpoint (skip for test mode — test runs are fast)
    if (!testMode) {
      const checkpoint = await loadCheckpoint(epubDir);
      if (checkpoint) {
        const currentModel = getProviderModel(config);
        const mismatches: string[] = [];
        if (checkpoint.sourceEpubPath !== epubPath) mismatches.push(`sourceEpubPath: "${checkpoint.sourceEpubPath}" vs "${epubPath}"`);
        if (checkpoint.outputFilename !== outputFilename) mismatches.push(`outputFilename: "${checkpoint.outputFilename}" vs "${outputFilename}"`);
        if (checkpoint.provider !== config.provider) mismatches.push(`provider: "${checkpoint.provider}" vs "${config.provider}"`);
        if (checkpoint.model !== currentModel) mismatches.push(`model: "${checkpoint.model}" vs "${currentModel}"`);
        if (checkpoint.simplifyForChildren !== !!options?.simplifyForChildren) mismatches.push(`simplifyForChildren: ${checkpoint.simplifyForChildren} vs ${!!options?.simplifyForChildren}`);
        if (mismatches.length > 0) {
          console.log(`[AI-CLEANUP] Checkpoint found but config changed, starting fresh. Mismatches: ${mismatches.join(', ')}`);
        }
      }
      if (checkpoint
          && checkpoint.sourceEpubPath === epubPath
          && checkpoint.outputFilename === outputFilename
          && checkpoint.provider === config.provider
          && checkpoint.model === getProviderModel(config)
          && checkpoint.simplifyForChildren === !!options?.simplifyForChildren) {
        // Valid checkpoint — check that intermediate EPUB still exists
        let intermediateExists = false;
        try {
          await fsPromises.access(outputPath);
          intermediateExists = true;
        } catch { /* doesn't exist */ }

        if (intermediateExists) {
          isResuming = true;

          // Don't load completed chapter XHTML into memory — saveModifiedEpubLocal
          // reads previously-saved chapters directly from the output EPUB on demand.
          for (const chapterId of checkpoint.completedChapters) {
            completedChapterIds.add(chapterId);
            chaptersAddedToDiffCache.add(chapterId);  // Diff cache already has these
          }

          chunksCompletedInJob = checkpoint.completedChunkCount;
          chaptersProcessed = completedChapterIds.size;

          console.log(`[AI-CLEANUP] Resuming: ${completedChapterIds.size}/${checkpoint.totalChapters} chapters already complete (${chunksCompletedInJob} chunks)`);

          sendProgress({
            jobId,
            phase: 'processing',
            currentChapter: completedChapterIds.size,
            totalChapters: chapters.length,
            currentChunk: chunksCompletedInJob,
            totalChunks: 0, // Will be updated after pre-scan
            percentage: 5,
            message: `Resuming — ${completedChapterIds.size} chapters already complete`,
            outputPath
          });
        } else {
          console.log('[AI-CLEANUP] Checkpoint found but intermediate EPUB is missing, starting fresh');
          await deleteCheckpoint(epubDir);
        }
      }
    }

    // If not resuming, start clean
    if (!isResuming) {
      // Delete any existing output EPUB to start fresh
      try {
        await fsPromises.unlink(outputPath);
      } catch {
        // File doesn't exist, that's fine
      }

      // Delete any existing skipped-chunks.json from previous runs
      const oldSkippedChunksPath = path.join(epubDir, 'skipped-chunks.json');
      try {
        await fsPromises.unlink(oldSkippedChunksPath);
        console.log('[AI-CLEANUP] Removed old skipped-chunks.json from previous run');
      } catch {
        // File doesn't exist, that's fine
      }

      // Clear any existing diff cache and start new session
      await clearDiffCache(outputPath);
      await startDiffCache(outputPath, epubPath);
    } else {
      // Resuming: the diff cache already holds the first-half chapters from the
      // prior run. Re-attach to it WITHOUT wiping (startDiffCache would truncate
      // to chapters:[], losing every chapter diffed before the interruption —
      // the cleaned text survives in the output EPUB but its diff would vanish
      // from Review Changes). resumeDiffCache preserves existing chapters and
      // appends the remaining ones as they're processed.
      await resumeDiffCache(outputPath, epubPath);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Pre-scan all chapters to count chunks (metadata only — no XHTML stored)
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`[AI-CLEANUP] Pre-scanning chapters...`);

    // Lazily populated: stores XHTML only for the current chapter being processed
    const chapterXhtmlMap: Map<string, string> = new Map();

    // Simple chunk structure - just text chunks
    interface ChunkInfo {
      text: string;  // Plain text with paragraphs separated by blank lines
    }

    // Lightweight metadata from pre-scan (no XHTML or chunk text stored)
    interface ChapterMeta {
      chapter: typeof chapters[0];
      chunkCount: number;
      href: string;  // resolved href for reading from EPUB
    }
    const chapterMetas: ChapterMeta[] = [];
    let totalChunksInJob = 0;
    let longestChunkText = ''; // largest chunk across the job — sizes jobNumCtx

    // Chunking is heading-aware and lives at module scope: chunkChapterProse
    // segments the chapter at heading boundaries and chunks ONLY the prose (see
    // segmentChapter / splitProseIntoChunks). Headings contribute no chunks and are
    // re-attached verbatim at reassembly by rebuildChapterPreservingHeadings.

    // Helper: load a chapter's XHTML and split its prose into chunks on demand
    const loadChapterChunks = async (
      proc: InstanceType<typeof import('./epub-processor.js').EpubProcessor>,
      href: string
    ): Promise<{ xhtml: string; chunks: ChunkInfo[] } | null> => {
      let xhtml: string;
      try {
        xhtml = await proc.readFile(href);
      } catch {
        return null;
      }

      const chapterText = extractChapterAsText(xhtml);
      if (!chapterText.trim()) return null;

      return { xhtml, chunks: chunkChapterProse(xhtml, jobChunkSize, preprocessFor?.(xhtml)) };
    };

    for (const chapter of chapters) {
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      let xhtml: string;
      try {
        xhtml = await processor.readFile(href);
      } catch {
        continue; // Skip chapters that can't be read
      }

      const chapterText = extractChapterAsText(xhtml);
      if (!chapterText.trim()) continue;

      // Split PROSE to count chunks (headings excluded — they are never chunked or
      // sent to the model). We also keep the single longest chunk's text so num_ctx
      // can be sized once for the whole job (see jobNumCtx below); the rest of the
      // chunk text goes out of scope, preserving the low-memory pre-scan (only ~one
      // chunk is retained, not the whole book).
      const chapterChunks = chunkChapterProse(xhtml, jobChunkSize, preprocessFor?.(xhtml));
      const chunkCount = chapterChunks.length;
      if (chunkCount > 0) {
        for (const ch of chapterChunks) {
          if (ch.text.length > longestChunkText.length) longestChunkText = ch.text;
        }
        chapterMetas.push({ chapter, chunkCount, href });
        totalChunksInJob += chunkCount;
      }
      // xhtml and chapterText go out of scope — not stored
    }

    console.log(`[AI-CLEANUP] Total chunks in job: ${totalChunksInJob} across ${chapterMetas.length} non-empty chapters`);

    // Pin num_ctx for the ENTIRE job, sized to the largest chunk. Ollama fully
    // reloads the model runner whenever num_ctx changes, so the old per-chunk
    // estimate reloaded the model in/out repeatedly (down for a chapter's short
    // tail chunk, back up for the next full chunk). One constant loads the model
    // once and keeps it resident. Every smaller chunk fits inside it, and the
    // value is already GPU-capped by estimateNumCtx (numCtxMaxForModel). For
    // non-Ollama providers num_ctx is ignored, so the model here is immaterial.
    const cleanupModel = config.provider === 'ollama' ? config.ollama!.model : DEFAULT_MODEL;
    // Edit-list chunks generate a FIXED num_predict budget (4096, mostly in-band
    // thinking) on top of prompt+input — the rewrite-era input*2 estimate would pin
    // a ~4k window and strangle the thinking into REASONING_OVERRUNs (the probes ran
    // at 16k). Budget-size it instead, with headroom for the per-chunk few-shot
    // block that cleanChunkEditList appends (not part of systemPrompt here).
    // Simplify keeps the rewrite estimate but at 3x: its output is input-sized AND
    // now carries in-band thinking on top.
    const EDITLIST_FEWSHOT_HEADROOM = ' '.repeat(2000);
    const jobNumCtx = useEditList
      ? estimateNumCtxForBudget(systemPrompt + EDITLIST_FEWSHOT_HEADROOM, longestChunkText, 4096, cleanupModel)
      : estimateNumCtx(systemPrompt, longestChunkText, task === 'simplify' ? 3 : 2, cleanupModel);
    console.log(`[AI-CLEANUP] Pinned num_ctx=${jobNumCtx} for the job (largest chunk ${longestChunkText.length} chars) — model loads once, no per-chunk reloads`);

    if (totalChunksInJob === 0) {
      processor.close();
      stopAIPowerBlock();
      return { success: false, error: 'No text content found in EPUB' };
    }

    // TEST MODE: Limit to first N chunks
    console.log('[AI-CLEANUP] Test mode check:', { testMode, optionsTestMode: options?.testMode, options: JSON.stringify(options) });
    if (testMode) {
      console.log(`[AI-CLEANUP] TEST MODE: Limiting to first ${TEST_MODE_CHUNK_LIMIT} chunks`);
      let chunksRemaining = TEST_MODE_CHUNK_LIMIT;
      const limitedMetas: typeof chapterMetas = [];

      for (const meta of chapterMetas) {
        if (chunksRemaining <= 0) break;

        if (meta.chunkCount <= chunksRemaining) {
          limitedMetas.push(meta);
          chunksRemaining -= meta.chunkCount;
        } else {
          limitedMetas.push({ ...meta, chunkCount: chunksRemaining });
          chunksRemaining = 0;
        }
      }

      chapterMetas.length = 0;
      chapterMetas.push(...limitedMetas);
      totalChunksInJob = Math.min(totalChunksInJob, TEST_MODE_CHUNK_LIMIT);
      console.log(`[AI-CLEANUP] TEST MODE: Processing ${totalChunksInJob} chunks across ${chapterMetas.length} chapters`);
    }

    // One entry point for cleaning a single chunk, so the parallel and sequential
    // loops share the branch: edit-list cleanup vs the legacy full-rewrite provider
    // path (simplify, custom prompt, detailed-cleanup deletions).
    const processOneChunk = (text: string, chunkMeta: ChunkMeta): Promise<string> =>
      useEditList
        ? cleanChunkEditList(text, editListPrompt, options?.customInstructions, config, jobState, jobNumCtx, jobTemperature, 3, abortController.signal, chunkMeta)
        : cleanChunkWithProvider(text, systemPrompt, task, config, jobState, jobNumCtx, jobTemperature, 3, abortController.signal, chunkMeta);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Process all chunks (parallel or sequential)
    // ─────────────────────────────────────────────────────────────────────────
    // Local (single llama-server) and Ollama are single-stream — never parallelize.
    const useParallel = options?.useParallel && config.provider !== 'ollama' && config.provider !== 'local';
    const workerCount = Math.min(options?.parallelWorkers || 3, totalChunksInJob);

    if (useParallel && workerCount > 1) {
      // ─────────────────────────────────────────────────────────────────────────
      // PARALLEL PROCESSING: Chunk-level parallelism for optimal load balancing
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`[AI-CLEANUP] Using PARALLEL chunk-level processing with ${workerCount} workers`);

      // Flatten all chunks into a single queue with metadata
      // For parallel, we must load all chunk text into the queue upfront
      interface ChunkWork {
        chapterId: string;
        chapterTitle: string;
        chapterIndex: number;
        chunkIndex: number;
        overallChunkNumber: number;  // 1-based overall position
        text: string;
      }

      const chunkQueue: ChunkWork[] = [];
      let overallNumber = 0;
      for (let chapterIdx = 0; chapterIdx < chapterMetas.length; chapterIdx++) {
        const meta = chapterMetas[chapterIdx];
        // Skip chapters already completed from checkpoint
        if (completedChapterIds.has(meta.chapter.id)) {
          overallNumber += meta.chunkCount;
          continue;
        }
        // Load chunks on demand for this chapter
        const loaded = await loadChapterChunks(processor, meta.href);
        if (!loaded) {
          overallNumber += meta.chunkCount;
          continue;
        }
        // In test mode, chunkCount may be limited — only take that many
        const chunksToUse = loaded.chunks.slice(0, meta.chunkCount);
        for (let chunkIdx = 0; chunkIdx < chunksToUse.length; chunkIdx++) {
          overallNumber++;
          chunkQueue.push({
            chapterId: meta.chapter.id,
            chapterTitle: meta.chapter.title,
            chapterIndex: chapterIdx,
            chunkIndex: chunkIdx,
            overallChunkNumber: overallNumber,
            text: chunksToUse[chunkIdx].text
          });
        }
        // Don't store XHTML yet — it will be loaded in trySaveChapter
      }

      console.log(`[AI-CLEANUP] Created chunk queue with ${chunkQueue.length} items`);

      // Results storage — keyed by chapter for efficient lookup and cleanup
      interface ChunkResult {
        chapterId: string;
        chunkIndex: number;
        cleanedText: string;
      }
      const resultsByChapter = new Map<string, ChunkResult[]>();
      let totalChunksCompleted = chunksCompletedInJob;  // Start from checkpoint count if resuming

      // Track chunks needed per chapter for incremental saving
      const chunksPerChapter = new Map<string, number>();
      const completedChunksPerChapter = new Map<string, number>();
      const savedChapters = new Set<string>();
      for (const meta of chapterMetas) {
        chunksPerChapter.set(meta.chapter.id, meta.chunkCount);
        if (completedChapterIds.has(meta.chapter.id)) {
          completedChunksPerChapter.set(meta.chapter.id, meta.chunkCount);
          savedChapters.add(meta.chapter.id);
        } else {
          completedChunksPerChapter.set(meta.chapter.id, 0);
        }
      }

      // Helper to try saving a completed chapter
      const trySaveChapter = async (chapterId: string) => {
        if (savedChapters.has(chapterId)) return;

        const needed = chunksPerChapter.get(chapterId) || 0;
        const completed = completedChunksPerChapter.get(chapterId) || 0;

        if (completed >= needed) {
          // All chunks for this chapter are done - collect and save
          const chapterResults = resultsByChapter.get(chapterId);
          if (!chapterResults || chapterResults.length === 0) return;

          chapterResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

          // Load XHTML on demand if not already cached
          let originalXhtml = chapterXhtmlMap.get(chapterId);
          if (!originalXhtml) {
            const meta = chapterMetas.find(m => m.chapter.id === chapterId);
            if (meta) {
              try {
                originalXhtml = await processor!.readFile(meta.href);
                chapterXhtmlMap.set(chapterId, originalXhtml);
              } catch {
                console.warn(`[AI-CLEANUP] Could not read XHTML for chapter ${chapterId}`);
                return;
              }
            }
          }

          if (originalXhtml) {
            // chapterResults is sorted by chunkIndex above, so mapping to cleanedText
            // yields the flat, in-order prose chunk list. Headings are re-attached
            // verbatim from the original XHTML by the reassembler.
            const rebuiltXhtml = rebuildChapterPreservingHeadings(
              originalXhtml,
              chapterResults.map(c => c.cleanedText),
              jobChunkSize,
              preprocessFor?.(originalXhtml)
            );
            modifiedChapters.set(chapterId, rebuiltXhtml);

            // Save to disk immediately
            try {
              await saveModifiedEpubLocal(processor!, modifiedChapters, outputPath, savedChapters);
              savedChapters.add(chapterId);
              completedChapterIds.add(chapterId);
              console.log(`[AI-CLEANUP] Saved chapter ${chapterId} (${chapterResults.length} chunks)`);

              // Free memory — chapter data is now on disk
              modifiedChapters.delete(chapterId);
              chapterXhtmlMap.delete(chapterId);
              resultsByChapter.delete(chapterId);

              // Add to diff cache if not already added
              if (!chaptersAddedToDiffCache.has(chapterId)) {
                const meta = chapterMetas.find(m => m.chapter.id === chapterId);
                const chapterTitle = meta?.chapter.title || chapterId;
                const originalText = extractChapterAsText(originalXhtml);
                const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
                await addChapterDiff(chapterId, chapterTitle, originalText, cleanedTextForDiff);
                chaptersAddedToDiffCache.add(chapterId);
              }

              // Save checkpoint (skip in test mode)
              if (!testMode) {
                await saveCheckpoint(epubDir, {
                  version: 1,
                  sourceEpubPath: epubPath,
                  outputFilename,
                  totalChapters: chapterMetas.length,
                  totalChunks: totalChunksInJob,
                  completedChapters: [...completedChapterIds],
                  completedChunkCount: totalChunksCompleted,
                  provider: config.provider,
                  model: getProviderModel(config),
                  simplifyForChildren: !!options?.simplifyForChildren,
                  updatedAt: new Date().toISOString()
                });
              }
            } catch (saveError) {
              console.error(`[AI-CLEANUP] Failed to save chapter ${chapterId}:`, saveError);
            }
          }
        }
      };

      // Helper to update progress
      const updateProgress = async (chapterId: string, chapterTitle: string) => {
        totalChunksCompleted++;
        chunksCompletedInSession++;  // session-relative — excludes checkpoint, for correct speed/ETA on resume
        completedChunksPerChapter.set(chapterId, (completedChunksPerChapter.get(chapterId) || 0) + 1);

        // Check if too many chunks have fallen back to original text
        checkFallbackThreshold(jobState);

        const percentage = Math.round((totalChunksCompleted / totalChunksInJob) * 90);
        sendProgress({
          jobId,
          phase: 'processing',
          currentChapter: 0, // Not meaningful for chunk-level
          totalChapters: chapterMetas.length,
          currentChunk: totalChunksCompleted,
          totalChunks: totalChunksInJob,
          percentage,
          message: `[${workerCount} ${workerCount === 1 ? 'worker' : 'workers'}] Chunk ${totalChunksCompleted}/${totalChunksInJob}: ${chapterTitle}`,
          outputPath,
          chunksCompletedInJob: totalChunksCompleted,
          totalChunksInJob,
          chunkCompletedAt: Date.now(),
          completedInSession: chunksCompletedInSession
        });

        // Try to save this chapter if all its chunks are complete
        await trySaveChapter(chapterId);
      };

      // Worker function - pulls chunks from shared queue
      const runWorker = async (workerId: number): Promise<void> => {
        while (true) {
          // Get next chunk from queue (atomic via shift)
          const work = chunkQueue.shift();
          if (!work) break; // Queue empty
          if (abortController.signal.aborted) break;

          try {
            const chunkMeta = {
              chapterTitle: work.chapterTitle,
              chunkIndex: work.chunkIndex,
              overallChunkNumber: work.overallChunkNumber,
              totalChunks: totalChunksInJob
            };
            const cleaned = await processOneChunk(work.text, chunkMeta);
            const result: ChunkResult = {
              chapterId: work.chapterId,
              chunkIndex: work.chunkIndex,
              cleanedText: cleaned
            };
            if (!resultsByChapter.has(work.chapterId)) {
              resultsByChapter.set(work.chapterId, []);
            }
            resultsByChapter.get(work.chapterId)!.push(result);
            await updateProgress(work.chapterId, work.chapterTitle);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Check for unrecoverable errors
            if (errorMessage.includes('credit balance') || errorMessage.includes('rate_limit') ||
                errorMessage.includes('invalid_api_key') || errorMessage.includes('401') ||
                errorMessage.includes('403') || errorMessage.includes('quota')) {
              throw error; // Re-throw to stop all workers
            }
            // For recoverable errors, keep original text — but count it toward the
            // fallback threshold (checked in updateProgress) so a dead/hung AI backend
            // aborts the job instead of silently producing an unchanged book.
            jobState.errorFallbackCount++;
            jobState.skippedChunks.push({
              chapterTitle: work.chapterTitle,
              chunkIndex: work.chunkIndex,
              overallChunkNumber: work.overallChunkNumber,
              totalChunks: totalChunksInJob,
              reason: 'error',
              text: work.text,
              aiResponse: errorMessage.substring(0, 500)
            });
            const result: ChunkResult = {
              chapterId: work.chapterId,
              chunkIndex: work.chunkIndex,
              cleanedText: work.text
            };
            if (!resultsByChapter.has(work.chapterId)) {
              resultsByChapter.set(work.chapterId, []);
            }
            resultsByChapter.get(work.chapterId)!.push(result);
            await updateProgress(work.chapterId, work.chapterTitle);
          }
        }
      };

      // Start workers
      const workers = Array(workerCount).fill(null).map((_, i) => runWorker(i));
      await Promise.all(workers);

      // Check if cancelled
      if (abortController.signal.aborted) {
        throw new Error('Job cancelled');
      }

      // Process any remaining unsaved chapters (partial chapters from stuck workers)
      let remainingCount = 0;
      for (const [chapterId, chapterResults] of resultsByChapter) {
        if (savedChapters.has(chapterId)) continue;
        remainingCount++;

        chapterResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

        // Load XHTML on demand
        let originalXhtml = chapterXhtmlMap.get(chapterId);
        if (!originalXhtml) {
          const meta = chapterMetas.find(m => m.chapter.id === chapterId);
          if (meta) {
            try {
              originalXhtml = await processor!.readFile(meta.href);
            } catch {
              console.warn(`[AI-CLEANUP] No original XHTML for chapter ${chapterId}`);
              continue;
            }
          }
        }
        if (!originalXhtml) continue;

        // chapterResults is sorted by chunkIndex above, so mapping to cleanedText
        // yields the flat, in-order prose chunk list. Headings are re-attached
        // verbatim from the original XHTML by the reassembler.
        const rebuiltXhtml = rebuildChapterPreservingHeadings(
          originalXhtml,
          chapterResults.map(c => c.cleanedText),
          jobChunkSize,
          preprocessFor?.(originalXhtml)
        );

        modifiedChapters.set(chapterId, rebuiltXhtml);

        // Add to diff cache (these chapters weren't saved incrementally)
        if (!chaptersAddedToDiffCache.has(chapterId)) {
          const meta = chapterMetas.find(m => m.chapter.id === chapterId);
          const chapterTitle = meta?.chapter.title || chapterId;
          const originalText = extractChapterAsText(originalXhtml);
          const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
          await addChapterDiff(chapterId, chapterTitle, originalText, cleanedTextForDiff);
          chaptersAddedToDiffCache.add(chapterId);
        }
      }
      chaptersProcessed = savedChapters.size + remainingCount;

      console.log(`[AI-CLEANUP] Saved ${savedChapters.size} chapters incrementally, ${remainingCount} in final pass`);

    } else {
      // ─────────────────────────────────────────────────────────────────────────
      // SEQUENTIAL PROCESSING: Original single-threaded approach
      // ─────────────────────────────────────────────────────────────────────────
      console.log('[AI-CLEANUP] Using SEQUENTIAL processing');

      for (let i = 0; i < chapterMetas.length; i++) {
        // Check for cancellation before each chapter
        if (abortController.signal.aborted) {
          console.log(`[AI-CLEANUP] Job ${jobId} cancelled before chapter ${i + 1}`);
          throw new Error('Job cancelled');
        }

        const meta = chapterMetas[i];
        const { chapter } = meta;

        // Skip already-completed chapters (from checkpoint resume)
        if (completedChapterIds.has(chapter.id)) {
          continue;
        }

        // Load chapter XHTML and chunks on demand
        const loaded = await loadChapterChunks(processor, meta.href);
        if (!loaded) continue;

        // In test mode, chunkCount may be limited
        const uniqueChunks = loaded.chunks.slice(0, meta.chunkCount);
        chapterXhtmlMap.set(chapter.id, loaded.xhtml);

        // Collect cleaned text from all chunks in this chapter
        const cleanedChunkTexts: string[] = [];

        for (let c = 0; c < uniqueChunks.length; c++) {
          // Check for cancellation before each chunk
          if (abortController.signal.aborted) {
            console.log(`[AI-CLEANUP] Job ${jobId} cancelled before chunk ${c + 1} of chapter ${i + 1}`);
            throw new Error('Job cancelled');
          }

          const chunkStartTime = Date.now();
          const currentChunkInJob = chunksCompletedInJob + 1;
          const chunkInfo = uniqueChunks[c];

          // Send progress before starting chunk
          sendProgress({
            jobId,
            phase: 'processing',
            currentChapter: i + 1,
            totalChapters: chapterMetas.length,
            currentChunk: currentChunkInJob,
            totalChunks: totalChunksInJob,
            percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
            message: `Processing chunk ${currentChunkInJob}/${totalChunksInJob}: ${chapter.title}`,
            outputPath,
            chunksCompletedInJob,
            totalChunksInJob,
            completedInSession: chunksCompletedInSession
          });

          try {
            const chunkCharCount = chunkInfo.text.length;
            totalCharactersProcessed += chunkCharCount;
            console.log(`[AI-CLEANUP] Starting chunk ${currentChunkInJob}/${totalChunksInJob} - "${chapter.title}" (${chunkCharCount} chars)`);

            const chunkMeta = {
              chapterTitle: chapter.title,
              chunkIndex: c,
              overallChunkNumber: currentChunkInJob,
              totalChunks: totalChunksInJob
            };
            const cleaned = await processOneChunk(chunkInfo.text, chunkMeta);
            const chunkDuration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            console.log(`[AI-CLEANUP] Completed chunk ${currentChunkInJob}/${totalChunksInJob} in ${chunkDuration}s (${cleaned.length} chars output)`);

            // Collect cleaned text
            cleanedChunkTexts.push(cleaned);

            // Increment counters
            chunksCompletedInJob++;
            chunksCompletedInSession++;

            // Check if too many chunks have fallen back to original text
            checkFallbackThreshold(jobState);

            // Track first chunk completion for rate calculation
            if (firstChunkCompletedAt === null) {
              firstChunkCompletedAt = Date.now();
            }

            sendProgress({
              jobId,
              phase: 'processing',
              currentChapter: i + 1,
              totalChapters: chapterMetas.length,
              currentChunk: chunksCompletedInJob,
              totalChunks: totalChunksInJob,
              percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
              message: `Chunk ${chunksCompletedInJob}/${totalChunksInJob}${getRateDisplay()}`,
              outputPath,
              chunksCompletedInJob,
              totalChunksInJob,
              chunkCompletedAt: Date.now(),
              completedInSession: chunksCompletedInSession
            });
          } catch (error) {
            const chunkDuration = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[AI-CLEANUP] Chunk ${currentChunkInJob} failed after ${chunkDuration}s:`, error);

            // Check for unrecoverable errors
            const isUnrecoverableError =
              errorMessage.includes('credit balance') ||
              errorMessage.includes('insufficient_quota') ||
              errorMessage.includes('rate_limit') ||
              errorMessage.includes('invalid_api_key') ||
              errorMessage.includes('authentication') ||
              errorMessage.includes('unauthorized') ||
              errorMessage.includes('403') ||
              errorMessage.includes('401') ||
              errorMessage.includes('billing') ||
              errorMessage.includes('quota exceeded') ||
              errorMessage.includes('model not found') ||
              errorMessage.includes('does not exist');

            if (isUnrecoverableError) {
              sendProgress({
                jobId,
                phase: 'error',
                currentChapter: i + 1,
                totalChapters: chapterMetas.length,
                currentChunk: currentChunkInJob,
                totalChunks: totalChunksInJob,
                percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
                message: `AI cleanup stopped: ${errorMessage}`,
                error: errorMessage,
                outputPath
              });
              throw new Error(`AI cleanup stopped: ${errorMessage}`);
            }

            // For recoverable errors, use original chunk text — but count it toward
            // the fallback threshold so a dead/hung AI backend aborts the job loudly
            // instead of silently producing an unchanged book.
            console.warn(`[AI-CLEANUP] Chunk ${currentChunkInJob} failed - using original text`);
            jobState.errorFallbackCount++;
            jobState.skippedChunks.push({
              chapterTitle: chapter.title,
              chunkIndex: c,
              overallChunkNumber: currentChunkInJob,
              totalChunks: totalChunksInJob,
              reason: 'error',
              text: chunkInfo.text,
              aiResponse: errorMessage.substring(0, 500)
            });
            cleanedChunkTexts.push(chunkInfo.text);
            chunksCompletedInJob++;
            chunksCompletedInSession++;
            checkFallbackThreshold(jobState);
          }
        }

        // Final rebuild for this chapter
        const originalXhtml = chapterXhtmlMap.get(chapter.id);
        if (originalXhtml && cleanedChunkTexts.length > 0) {
          // cleanedChunkTexts is the flat, in-order prose chunk list for this
          // chapter. Headings are re-attached verbatim from the original XHTML.
          const rebuiltXhtml = rebuildChapterPreservingHeadings(originalXhtml, cleanedChunkTexts, jobChunkSize, preprocessFor?.(originalXhtml));
          modifiedChapters.set(chapter.id, rebuiltXhtml);

          // Add to diff cache
          // IMPORTANT: Extract cleaned text from the rebuilt XHTML, not raw AI text.
          // This ensures diff positions match what hydration will extract from the EPUB.
          const originalText = extractChapterAsText(originalXhtml);
          const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
          await addChapterDiff(chapter.id, chapter.title, originalText, cleanedTextForDiff);
        }
        chaptersProcessed++;
        completedChapterIds.add(chapter.id);

        // Save at chapter boundary only
        try {
          await saveModifiedEpubLocal(processor, modifiedChapters, outputPath, completedChapterIds);

          // Free memory — chapter data is now on disk
          modifiedChapters.delete(chapter.id);
          chapterXhtmlMap.delete(chapter.id);

          if (global.gc) global.gc();
        } catch (saveError) {
          console.error(`Failed to save after chapter ${i + 1}:`, saveError);
        }

        // Save checkpoint (skip in test mode)
        if (!testMode) {
          await saveCheckpoint(epubDir, {
            version: 1,
            sourceEpubPath: epubPath,
            outputFilename,
            totalChapters: chapterMetas.length,
            totalChunks: totalChunksInJob,
            completedChapters: [...completedChapterIds],
            completedChunkCount: chunksCompletedInJob,
            provider: config.provider,
            model: getProviderModel(config),
            simplifyForChildren: !!options?.simplifyForChildren,
            updatedAt: new Date().toISOString()
          });
        }
      }
    } // End of else (sequential processing)

    // Final save
    sendProgress({
      jobId,
      phase: 'saving',
      currentChapter: totalChapters,
      totalChapters,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 95,
      message: 'Finalizing EPUB...',
      outputPath
    });

    await saveModifiedEpubLocal(processor, modifiedChapters, outputPath, completedChapterIds);
    processor.close();
    processor = null;

    // Embed cover from manifest if available
    if (options?.outputDir) {
      try {
        const projectDir = path.resolve(options.outputDir, '..', '..');
        const manifestPath = path.join(projectDir, 'manifest.json');
        const manifestRaw = await fsPromises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestRaw);
        if (manifest?.metadata?.coverPath) {
          // coverPath is relative to library root; project dir is inside library
          const libraryRoot = path.resolve(projectDir, '..', '..');
          const absCover = path.join(libraryRoot, manifest.metadata.coverPath);
          await fsPromises.access(absCover);
          const { embedCoverInEpub } = await import('./epub-processor.js');
          await embedCoverInEpub(outputPath, absCover);
          console.log(`[AI-BRIDGE] Embedded cover in cleanup output: ${outputPath}`);
        }
      } catch (coverErr) {
        console.warn('[AI-BRIDGE] Failed to embed cover in cleanup output:', coverErr);
      }
    }

    // Finalize diff cache (mark as complete)
    await finalizeDiffCache();

    // Delete checkpoint — cleanup is complete, no resume needed
    await deleteCheckpoint(epubDir);

    // Clean up abort controller
    activeCleanupJobs.delete(jobId);
    console.log(`[AI-BRIDGE] Job ${jobId} completed successfully, cleaned up`);

    sendProgress({
      jobId,
      phase: 'complete',
      currentChapter: totalChapters,
      totalChapters,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 100,
      message: 'OCR cleanup complete'
    });

    // Log issues if any
    if (jobState.copyrightFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Copyright issues detected: ${jobState.copyrightFallbackCount} chunks fell back to original text`);
    }
    if (jobState.skipFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Content skips detected: ${jobState.skipFallbackCount} chunks returned [SKIP] for non-trivial content`);
    }
    if (jobState.markerMismatchCount > 0) {
      console.warn(`[AI-CLEANUP] Marker mismatches detected: ${jobState.markerMismatchCount} chunks had [[BLOCK]] marker count mismatch and fell back to original text`);
    }
    if (jobState.truncatedFallbackCount > 0) {
      console.warn(`[AI-CLEANUP] Truncation issues detected: ${jobState.truncatedFallbackCount} chunks returned <70% of input length and fell back to original text`);
    }

    // Save skipped chunks to JSON file if any exist
    let skippedChunksPath: string | undefined;
    if (jobState.skippedChunks.length > 0) {
      skippedChunksPath = path.join(epubDir, 'skipped-chunks.json');
      await fsPromises.writeFile(skippedChunksPath, JSON.stringify(jobState.skippedChunks, null, 2), 'utf-8');
      console.log(`[AI-CLEANUP] Saved ${jobState.skippedChunks.length} skipped chunks to ${skippedChunksPath}`);
    }

    // Edit-list disposition log + deterministic pre-pass report, alongside skipped-chunks.json.
    await persistCleanupReports();

    stopAIPowerBlock();

    // Last chunk is done and the EPUB is written — hand the VRAM back now rather
    // than letting the model idle out its keep_alive window.
    await releaseCleanupModel(config);

    // Calculate analytics
    const cleanupEndTime = Date.now();
    const durationSeconds = Math.round((cleanupEndTime - cleanupStartTime) / 1000);
    const durationMinutes = durationSeconds / 60;
    const chunksPerMinute = durationMinutes > 0
      ? Math.round((totalChunksInJob / durationMinutes) * 10) / 10
      : 0;
    const charactersPerMinute = durationMinutes > 0
      ? Math.round(totalCharactersProcessed / durationMinutes)
      : 0;

    // Determine model name for analytics
    let modelName = 'unknown';
    if (config.provider === 'ollama' && config.ollama?.model) {
      modelName = `ollama/${config.ollama.model}`;
    } else if (config.provider === 'claude' && config.claude?.model) {
      modelName = `claude/${config.claude.model}`;
    } else if (config.provider === 'openai' && config.openai?.model) {
      modelName = `openai/${config.openai.model}`;
    }

    const analytics = {
      jobId,
      startedAt: new Date(cleanupStartTime).toISOString(),
      completedAt: new Date(cleanupEndTime).toISOString(),
      durationSeconds,
      totalChapters: chapters.length,
      totalChunks: totalChunksInJob,
      totalCharacters: totalCharactersProcessed,
      chunksPerMinute,
      charactersPerMinute,
      model: modelName,
      success: true,
      chaptersProcessed,
      copyrightChunksAffected: jobState.copyrightFallbackCount,
      contentSkipsAffected: jobState.skipFallbackCount,
      markerMismatchAffected: jobState.markerMismatchCount,
      truncatedChunksAffected: jobState.truncatedFallbackCount,
      skippedChunksPath
    };

    return {
      success: true,
      outputPath,
      chaptersProcessed,
      copyrightIssuesDetected: jobState.copyrightFallbackCount > 0,
      copyrightChunksAffected: jobState.copyrightFallbackCount,
      contentSkipsDetected: jobState.skipFallbackCount > 0,
      contentSkipsAffected: jobState.skipFallbackCount,
      markerMismatchDetected: jobState.markerMismatchCount > 0,
      markerMismatchAffected: jobState.markerMismatchCount,
      truncatedDetected: jobState.truncatedFallbackCount > 0,
      truncatedAffected: jobState.truncatedFallbackCount,
      skippedChunksPath,
      analytics
    };
  } catch (error) {
    // Clean up abort controller
    activeCleanupJobs.delete(jobId);

    // Clean up processor on error
    if (processor) {
      try {
        processor.close();
      } catch { /* ignore */ }
    }

    // Persist whatever chunks we recorded before the abort. On the TOO_MANY_FALLBACKS
    // path the success-path writer never runs, so without this the one artifact that
    // explains WHY the job failed (per-chunk reason + text) was being thrown away.
    if (jobState.skippedChunks.length > 0) {
      try {
        // epubDir is local to the try block; recompute it from in-scope params.
        const errorEpubDir = options?.outputDir || path.dirname(epubPath);
        const skippedChunksPath = path.join(errorEpubDir, 'skipped-chunks.json');
        await fsPromises.writeFile(skippedChunksPath, JSON.stringify(jobState.skippedChunks, null, 2), 'utf-8');
        console.log(`[AI-CLEANUP] Saved ${jobState.skippedChunks.length} skipped chunks (job failed) to ${skippedChunksPath}`);
      } catch (writeErr) {
        console.warn(`[AI-CLEANUP] Failed to persist skipped chunks on error: ${(writeErr as Error).message}`);
      }
    }

    // Persist the edit-list disposition log + pre-pass report on the failure path too.
    await persistCleanupReports();

    // Free the local model from VRAM immediately. The error path (e.g. the
    // fallback-threshold abort) used to leave llama-server resident until its
    // 5-minute idle timer — on a desktop-shared GPU the user wants it back now.
    if (config.provider === 'local') {
      void import('./llama-bridge.js')
        .then(({ llamaBridge }) => llamaBridge.stop())
        .catch((stopErr) => console.warn(`[AI-CLEANUP] Failed to stop local server on error: ${(stopErr as Error).message}`));
    }
    // Same for Ollama: a cancelled/failed job should not leave the model pinned
    // in VRAM for the rest of its keep_alive window.
    await releaseCleanupModel(config);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const isCancelled = message === 'Job cancelled' || abortController.signal.aborted;

    console.log(`[AI-BRIDGE] Job ${jobId} ${isCancelled ? 'cancelled' : 'failed'}: ${message}`);

    sendProgress({
      jobId,
      phase: 'error',
      currentChapter: 0,
      totalChapters: 0,
      currentChunk: 0,
      totalChunks: 0,
      percentage: 0,
      message: isCancelled ? 'Cancelled' : `Error: ${message}`,
      error: isCancelled ? 'Cancelled by user' : message
    });
    stopAIPowerBlock();
    return { success: false, error: isCancelled ? 'Cancelled by user' : message };
  }
}

/**
 * Save modified EPUB using StreamingZipWriter to avoid buffering the entire EPUB in memory.
 *
 * For each entry:
 * 1. If the chapter is in `modifiedChapters` → write the modified XHTML
 * 2. If the chapter is in `previouslySavedChapterIds` (already saved in a prior pass
 *    but evicted from modifiedChapters to save memory) → read from the existing output EPUB
 * 3. Otherwise → read from the original EPUB via processor
 */
async function saveModifiedEpubLocal(
  processor: InstanceType<typeof import('./epub-processor.js').EpubProcessor>,
  modifiedChapters: Map<string, string>,
  outputPath: string,
  previouslySavedChapterIds?: Set<string>
): Promise<void> {
  const { StreamingZipWriter, ZipReader } = await import('./epub-processor.js');

  const structure = processor.getStructure();
  if (!structure) {
    throw new Error('No EPUB structure');
  }

  // Build a lookup: entry path → chapter id (for chapters that are modified or previously saved)
  const entryToChapterId = new Map<string, string>();
  for (const chapter of structure.chapters) {
    const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
    entryToChapterId.set(href, chapter.id);
  }

  // Open the existing output EPUB for reading previously-saved chapters
  let outputReader: InstanceType<typeof import('./epub-processor.js').ZipReader> | null = null;
  if (previouslySavedChapterIds && previouslySavedChapterIds.size > 0) {
    try {
      await fsPromises.access(outputPath);
      outputReader = new ZipReader(outputPath);
      await outputReader.open();
    } catch {
      // Output EPUB doesn't exist yet — no previously saved chapters to read
      outputReader = null;
    }
  }

  const zipWriter = new StreamingZipWriter();
  await zipWriter.open();

  // Get all entries from the original EPUB
  const entries = (processor as any).zipReader?.getEntries() || [];

  for (const entryName of entries) {
    const chapterId = entryToChapterId.get(entryName);

    if (chapterId && modifiedChapters.has(chapterId)) {
      // Chapter was just modified — write the new XHTML
      const modifiedContent = modifiedChapters.get(chapterId)!;
      await zipWriter.addFile(entryName, Buffer.from(modifiedContent, 'utf8'));
    } else if (chapterId && previouslySavedChapterIds?.has(chapterId) && outputReader) {
      // Chapter was previously saved but evicted from memory — read from output EPUB
      const data = await outputReader.readEntry(entryName);
      await zipWriter.addFile(entryName, data);
    } else {
      // Copy from original EPUB as-is
      const data = await processor.readBinaryFile(entryName);
      const compress = entryName !== 'mimetype';
      await zipWriter.addFile(entryName, data, compress);
    }
  }

  // Close the output reader BEFORE finalize copies the temp file to outputPath.
  // On Windows, the file can't be overwritten while a reader has it open.
  if (outputReader) {
    outputReader.close();
    outputReader = null;
  }

  await zipWriter.finalize(outputPath);

  // Merge fragmented paragraphs (line-level blocks → sentence-aligned paragraphs)
  const { mergeEpubParagraphs } = await import('./epub-paragraph-merger.js');
  await mergeEpubParagraphs(outputPath);
}

/**
 * Replace the body content in an XHTML document while preserving the HTML structure.
 * Maps cleaned text blocks back to original block-level elements.
 * Local version for use with dedicated processor.
 */
function replaceXhtmlBodyLocal(xhtml: string, cleanedText: string): string {
  // Find the body tag
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) {
    return xhtml;
  }

  const bodyContent = bodyMatch[1];

  // Split cleaned text into blocks (separated by double newlines)
  const cleanedBlocks = cleanedText.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 0);

  if (cleanedBlocks.length === 0) {
    return xhtml;
  }

  // Find all block-level elements with text content
  // Use a non-greedy match to get individual elements
  const blockPattern = /<(p|h[1-6]|li|blockquote|figcaption)([^>]*)>([\s\S]*?)<\/\1>/gi;

  // Collect all matches with their positions
  interface BlockMatch {
    full: string;
    tag: string;
    attrs: string;
    content: string;
    startIndex: number;
    hasText: boolean;
  }

  const matches: BlockMatch[] = [];
  let match;

  while ((match = blockPattern.exec(bodyContent)) !== null) {
    // Check if this element has actual text content (not just whitespace/nested tags)
    const textContent = match[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&[^;]+;/g, ' ')
      .trim();

    matches.push({
      full: match[0],
      tag: match[1],
      attrs: match[2],
      content: match[3],
      startIndex: match.index,
      hasText: textContent.length > 0
    });
  }

  // Filter to only elements with text
  const textMatches = matches.filter(m => m.hasText);

  // If counts don't match, fall back to simple paragraph replacement
  if (textMatches.length !== cleanedBlocks.length) {
    console.warn(`[AI-BRIDGE] Block count mismatch: ${textMatches.length} HTML blocks vs ${cleanedBlocks.length} cleaned blocks. Using paragraph fallback.`);

    // Preserve chapter heading from original XHTML so TTS can detect it
    const firstHeading = textMatches.find(m => /^h[1-6]$/i.test(m.tag));
    let headingHtml = '';

    if (firstHeading) {
      const origTitle = firstHeading.content.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
      const normalizedTitle = origTitle.replace(/[.!?:;\s]+$/g, '').toLowerCase().trim();

      if (normalizedTitle) {
        // Ensure heading ends with period for TTS pause
        let headingText = origTitle.replace(/[.!?:;\s]+$/g, '').trim();
        if (!/[.!?]$/.test(headingText)) headingText += '.';
        headingHtml = `<${firstHeading.tag}${firstHeading.attrs}>${escapeXmlLocal(headingText)}</${firstHeading.tag}>`;

        // Check if AI included the title at the start of the first block — strip to avoid duplication
        const firstBlockNorm = (cleanedBlocks[0] || '').toLowerCase().trim();
        if (firstBlockNorm.startsWith(normalizedTitle)) {
          const remainder = cleanedBlocks[0].substring(normalizedTitle.length).replace(/^[.!?:;\s]+/, '').trim();
          if (remainder) {
            cleanedBlocks[0] = remainder;
          } else {
            cleanedBlocks.shift();
          }
        }
      }
    }

    // Filter out any per-block skip markers (can't map back to originals in fallback path)
    const filteredBlocks = cleanedBlocks.filter(p => !isSkipMarker(p));
    const paragraphs = filteredBlocks.map(p => `<p>${escapeXmlLocal(p)}</p>`).join('\n');
    const bodyHtml = headingHtml ? `${headingHtml}\n${paragraphs}` : paragraphs;
    return xhtml.replace(
      /<body([^>]*)>[\s\S]*<\/body>/i,
      `<body$1>\n${bodyHtml}\n</body>`
    );
  }

  // Replace each block element's content with cleaned text (work backwards to preserve indices)
  let newBodyContent = bodyContent;

  for (let i = textMatches.length - 1; i >= 0; i--) {
    const m = textMatches[i];
    let cleanedBlock = cleanedBlocks[i];

    // If AI returned a skip marker for this block, use original text
    if (isSkipMarker(cleanedBlock)) {
      cleanedBlock = m.content.replace(/<[^>]+>/g, '').trim();
    }

    // Ensure heading content ends with punctuation for TTS pause
    if (/^h[1-6]$/i.test(m.tag) && cleanedBlock) {
      const trimmed = cleanedBlock.trim();
      if (trimmed && !/[.!?]$/.test(trimmed)) {
        cleanedBlock = trimmed + '.';
      }
    }

    // Build new element preserving original tag and attributes
    const newElement = `<${m.tag}${m.attrs}>${escapeXmlLocal(cleanedBlock)}</${m.tag}>`;

    // Replace in the body content
    newBodyContent =
      newBodyContent.substring(0, m.startIndex) +
      newElement +
      newBodyContent.substring(m.startIndex + m.full.length);
  }

  // Replace body content in the original XHTML
  return xhtml.replace(
    /<body([^>]*)>[\s\S]*<\/body>/i,
    `<body$1>${newBodyContent}</body>`
  );
}

/**
 * Escape text for XML. Local version.
 */
function escapeXmlLocal(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export singleton-style interface
// ─────────────────────────────────────────────────────────────────────────────

export const aiBridge = {
  checkConnection,
  checkProviderConnection,
  getModels,
  hasModel,
  cleanupText,
  cleanupChapterStreaming,
  cleanupEpub,
  cancelCleanupJob,
  getOcrCleanupSystemPrompt,
  loadPrompt,
  savePrompt,
  reloadPrompt,
  getPromptFilePath
};

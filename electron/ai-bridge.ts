/**
 * AI Bridge — the text-cleanup door, and since 2026-09-14 it opens onto exactly
 * one place.
 *
 * Owen: *"bookforge/foundry gain a simple contract: send commands to the
 * crucible server. period. they dont have ollama fallbacks or cloud anything at
 * all."* So Ollama, Claude and OpenAI are GONE from this file — not disabled,
 * not behind a flag, deleted — and with them the credential reader they shared,
 * the two vendor REST clients and the one that talked to a local Ollama on its
 * well-known port. An app that could still reach a cloud vendor on its own
 * account would be a second place a key can live, which is the whole of what the ruling
 * removes: keys now live INSIDE the Crucible engine, which forwards to the
 * upstreams on the operator's account, and this process holds none and reads
 * none.
 *
 * Two providers remain, and only one of them is a destination:
 *
 *  - `crucible` — the one door. A named entry in the server registry, an ACT
 *    (`clean`/`translate`/`simplify`/`analysis`), and a model the SERVER chose.
 *  - `local` — the bundled llama.cpp of the LEGACY local spawn layer, which is
 *    scheduled for deletion as a whole after Owen's in-app pass (crucible
 *    `docs/PHASE15-HOST.md` §6). It is not a fallback: nothing routes to it
 *    except a caller that names it.
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import path from 'path';
import { promises as fsPromises } from 'fs';
// The Crucible SDK's error vocabulary. Imported for VALUE (instanceof), not just
// for types — translateCrucibleError is the one place those eight types are
// turned into the Error surface the rest of this file already speaks. The
// registry itself (./crucible/servers.js) is loaded lazily at call time, like
// llama-bridge, so a job that never names a Crucible never reads the registry.
import {
  CrucibleAuthError,
  CrucibleConfigError,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
  type CrucibleClient,
  type ModelInfo,
} from '@crucible/client';

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
  extractBlockTextsWithTags,
  replaceBlockTextsExact
} from './epub-processor.js';
import {
  startDiffCache,
  resumeDiffCache,
  addChapterDiff,
  finalizeDiffCache,
  clearDiffCache
} from './diff-cache.js';
// The four text acts, and the narrowing every boundary needs. A static import:
// `text-acts.ts` is pure constants and pure functions with no Electron and no
// registry behind it, so naming it here costs nothing at load.
import { isCrucibleTextAct, isUpstreamModelId, type CrucibleTextAct } from './crucible/text-acts.js';
import {
  recoverGapMarkers,
  extractStructuralMarkers,
  selectUniqueStructuralMarkers,
  applyStructuralMarkers,
  structuralMarkerRegex,
  type StructuralMarker,
  normalizeQuotes,
  extractHyphenPairs,
  applyHyphenJoins,
  createHyphenAttestation,
  addTextToHyphenAttestation,
  proveHyphenVerdict,
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
import { expandNumbersEn, expandNumbersEnDetailed } from './number-expansion.js';


// ─────────────────────────────────────────────────────────────────────────────
// Context Sizing
// ─────────────────────────────────────────────────────────────────────────────
//
// These two are MODEL-SIZE MATHS and they outlived the provider they were
// written for. Ollama took `num_ctx` per request; neither provider left does —
// a Crucible engine's context is fixed in the manifest when the model loads,
// the bundled local engine's when the server starts. What the numbers still do
// is bound the WINDOW a caller feeds a model (pickObservationWindow's densest
// span, the hyphen batches), which is a real decision with real consequences,
// so they stay, and `model` is read as a SIZE rather than as anything anybody
// will run. The Ollama reasoning below is kept verbatim because it is why the
// shape is the shape.

/**
 * Estimate the num_ctx needed for one request.
 * Without this, Ollama allocated the model's full context window (e.g. 131K for cogito)
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

/**
 * TWO PROVIDERS, one of which is on its way out.
 *
 * `crucible` is THE door for everything this app cannot do on its own CPU: a
 * named server runs the act and hands back bytes. `local` is the bundled
 * llama.cpp of the LEGACY local spawn layer — the per-engine conda envs, the
 * WSL path rewriting, the whole of it — whose deletion is scheduled separately,
 * after Owen's in-app pass (crucible `docs/PHASE15-HOST.md` §6). It is kept
 * because that layer still works and still has callers, NOT because anything
 * falls back to it: with `crucible` chosen and unreachable, a run fails by name.
 */
export type AIProvider = 'crucible' | 'local';

export interface AIProviderConfig {
  provider: AIProvider;
  /** Bundled llama.cpp (legacy). llama-bridge resolves the active model; `model` is informational. */
  local?: { model?: string };
  /**
   * A Crucible inference server (crucible `docs/PHASE15-HOST.md` §5.3).
   *
   * `server` NAMES an entry in <userData>/crucible-servers.json — never a URL,
   * never defaulted. `act` says which capability class this run is, because
   * Crucible refuses a run that lies about what it is doing. Neither is
   * guessed: see {@link crucibleConfigOf}, which refuses both by name.
   *
   * `model` is OUTPUT and nothing reads it to decide anything. The MODEL a
   * class runs on is the SERVER's decision — `crucible install` probes that
   * card and picks what fits, a per-HOST fact — so the preflight reads
   * `capability.selected` and stamps it here for the reporting sites (the
   * resume checkpoint's model string, the analytics `modelName`, the job log)
   * to name what actually ran.
   */
  crucible?: {
    server: string;
    act: CrucibleTextAct;
    model?: string;
  };
}

export interface ProviderConnectionResult {
  available: boolean;
  error?: string;
  models?: string[];
}

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup Checkpoint (resume support)
// ─────────────────────────────────────────────────────────────────────────────

// Bumped 1 → 2 for the OCR-repair / TTS-prep pass split: a v1 checkpoint's completed
// chapters already had footnote markers + curly quotes processed in the single-pass
// flow, so resuming one into the new two-pass flow would corrupt repaired.epub
// (pass 1 must NOT touch those). A version mismatch is discarded loudly.
//
// Bumped 2 → 3 for the simplify block-group pipeline: a v2 checkpoint's
// `completedChunkCount` / `totalChunks` count 8,000-char PROSE CHUNKS, and the
// block path counts BLOCK GROUPS — resuming a half-finished chunk-era simplify
// under block mode would restore a chunk count as a group count and corrupt the
// job's progress accounting (and its proportional fallback threshold) for the
// rest of the run.
const CLEANUP_CHECKPOINT_VERSION = 3;

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
    if (checkpoint.version !== CLEANUP_CHECKPOINT_VERSION) {
      console.warn(`[AI-CLEANUP] Discarding stale checkpoint (version ${checkpoint.version}, expected ${CLEANUP_CHECKPOINT_VERSION}) — starting fresh so pass-1 (OCR repair) never resumes over already-TTS-prepped chapters`);
      return null;
    }
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
  // Two servers can serve the same model id, so the checkpoint's model string
  // names the SERVER too — a resumed job must not silently continue on a
  // different host's copy. The model half is whatever the preflight stamped
  // from the server's capability record; before it has run there is nothing
  // true to say, and 'unknown' is this function's existing word for that.
  if (config.provider === 'crucible') {
    return config.crucible
      ? `${config.crucible.server}/${config.crucible.model ?? 'unknown'}`
      : 'unknown';
  }
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

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
 * run two AI jobs concurrently (a Crucible job whose class the engine forwards
 * to an upstream runs in its own `[cloud]` lane, beside a job holding a GPU
 * slot), so a single job MUST own its own counters and
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
  /**
   * How many fallbacks abort the job. Starts at MAX_FALLBACK_COUNT for every
   * path; the simplify block path raises it to a PROPORTION of the job after its
   * pre-scan, because "10 units failed" means something very different for a
   * 12-chunk job than for a 2,000-group one — an absolute 10 aborted a 308-unit
   * book at ~3% failures.
   */
  maxFallbackCount: number;
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
    maxFallbackCount: MAX_FALLBACK_COUNT,
  };
}
const CHUNK_SEARCH_WINDOW = 1000; // characters to search for logical break point
const TIMEOUT_MS = 180000; // 3 minutes per chunk
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
 *
 * The threshold is read from the JOB (state.maxFallbackCount), not the module
 * constant, so a path that knows how many units it is about to process can scale
 * it — see the simplify block path. Every other path leaves it at
 * MAX_FALLBACK_COUNT and behaves exactly as before.
 */
export function checkFallbackThreshold(state: CleanupJobState): void {
  const totalFallbacks = getTotalFallbackCount(state);
  if (totalFallbacks >= state.maxFallbackCount) {
    throw new Error(`TOO_MANY_FALLBACKS: ${totalFallbacks} chunks fell back to original text (threshold: ${state.maxFallbackCount}). Aborting cleanup to prevent poor quality output.`);
  }
}

/**
 * Is this error message one that no amount of retrying, splitting or shrinking
 * will get past — a dead API key, an exhausted quota, a model that isn't there?
 * Those must stop the JOB, loudly, rather than be absorbed as N thousand
 * "kept the original" fallbacks. Extracted verbatim from the sequential chunk
 * loop so the block path fails fast on exactly the same list.
 */
function isUnrecoverableProviderError(errorMessage: string): boolean {
  return (
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
    errorMessage.includes('does not exist')
  );
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

/** The attributes of one source element, carried through the rebuild. */
type ElementAttrs = Record<string, string>;

/**
 * An ordered piece of a chapter: a preserved heading, or a run of prose.
 *
 * A prose segment keeps the SOURCE ELEMENTS it was made of — text plus
 * attributes, in document order — and not only their joined text, because the
 * rebuild has to put the attributes back onto the paragraphs it emits. See
 * `carryAttributesOntoParagraphs` for the attribution rule.
 */
type ChapterSegment =
  | { kind: 'heading'; tag: string; text: string; attrs: ElementAttrs }
  | { kind: 'prose'; text: string; sources: Array<{ text: string; attrs: ElementAttrs }> };

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
  let prose: Array<{ text: string; attrs: ElementAttrs }> = [];

  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({
        kind: 'prose',
        text: prose.map((s) => s.text).join('\n\n'),
        sources: prose,
      });
      prose = [];
    }
  };

  for (const block of blocks) {
    if (isHeadingTag(block.tagName)) {
      flushProse();
      segments.push({
        kind: 'heading', tag: block.tagName, text: block.text, attrs: block.attrs,
      });
    } else {
      prose.push({ text: block.text, attrs: block.attrs });
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

// ─────────────────────────────────────────────────────────────────────────────
// Carrying an element's attributes across the rebuild
//
// ── The bug this exists for (Owen, 2026-08-10) ───────────────────────────────
//
// The rebuild below emits the chapter from scratch. Until this existed it emitted
// `<p>` and `<h1>` with NO ATTRIBUTES AT ALL, so every simplified chapter came
// out of the pass having lost `data-bf-cat` (what the model that read the page
// said the block was), `data-bf-user-cat` (what a PERSON said it was — the
// category door merged the same night), `data-bf-page`, and the reflow's
// `data-bf-category`/`data-bf-group`/`data-bf-blocks` provenance. The element
// identity `data-bf-uid` would have gone the same way.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// The AI is asked to clean prose, not to restructure it, so the common case is
// one cleaned paragraph per source element and the rule there is simply "the
// same attributes". The two ways it can still change the count each get a stated
// answer:
//
//   • ONE source element  → the emitted paragraph keeps that element's
//     attributes, identity and all.
//   • SEVERAL sources MERGED into one paragraph → the paragraph keeps the FIRST
//     source's attributes. The others' identities are GONE, and that is honest:
//     those elements no longer exist, so their uids should not survive onto an
//     element that is not them.
//   • ONE source SPLIT into several paragraphs → the first fragment keeps the
//     source's attributes; the rest get NONE. They are new elements, and phase 1
//     leaves them unstamped — `stampElementIdsInBookFile` gives them identities
//     the next time the project opens.
//
// ── How the source of a paragraph is decided ────────────────────────────────
//
// By its WORDS, not by its position, because a merge or a split shifts every
// position after it and a positional rule would then hand element N+1's identity
// to element N+2's text — a wrong identity, which is worse than a missing one.
//
// The segment's sources are laid end to end as one word stream, each word
// remembering which element it came from. Each emitted paragraph is looked up in
// that stream by its opening words, searching forward from where the previous
// paragraph ended, and the element the match lands in is the element it came
// from. First paragraph to land in an element takes its attributes; any later
// one landing in the same element is a split fragment and takes none.
//
// A paragraph the model rewrote past recognition finds no match; it is then
// attributed to wherever the cursor stands, which is the position it would have
// had anyway. That is an attribution heuristic over text the model changed, not
// a fallback standing in for a value that should have been known.
// ─────────────────────────────────────────────────────────────────────────────

/** How many opening words identify a paragraph in the source word stream. */
const ATTR_CARRY_PROBE_WORDS = 5;

/** A paragraph's words, lowercased and stripped of punctuation, for matching. */
function attrCarryWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Decide which source element each emitted paragraph came from, and hand back
 * the attributes it should carry — null where the paragraph is a new element.
 *
 * See the block comment above for the rule this implements.
 */
function carryAttributesOntoParagraphs(
  paragraphs: readonly string[],
  sources: ReadonlyArray<{ text: string; attrs: ElementAttrs }>,
): Array<ElementAttrs | null> {
  if (sources.length === 0) return paragraphs.map(() => null);

  // The segment's sources as one word stream, each word owned by its element.
  const srcWords: string[] = [];
  const srcOwner: number[] = [];
  sources.forEach((source, index) => {
    for (const word of attrCarryWords(source.text)) {
      srcWords.push(word);
      srcOwner.push(index);
    }
  });
  if (srcWords.length === 0) return paragraphs.map(() => null);

  /** First position at or after `from` where `probe` runs consecutively. */
  const findRun = (probe: readonly string[], from: number): number => {
    if (probe.length === 0) return -1;
    for (let at = from; at + probe.length <= srcWords.length; at++) {
      let ok = true;
      for (let k = 0; k < probe.length; k++) {
        if (srcWords[at + k] !== probe[k]) { ok = false; break; }
      }
      if (ok) return at;
    }
    return -1;
  };

  const carried: Array<ElementAttrs | null> = [];
  const taken = new Set<number>();
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const words = attrCarryWords(paragraph);
    const probe = words.slice(0, Math.min(ATTR_CARRY_PROBE_WORDS, words.length));
    const found = findRun(probe, cursor);
    const at = Math.min(found >= 0 ? found : cursor, srcWords.length - 1);
    const owner = srcOwner[at];
    carried.push(taken.has(owner) ? null : sources[owner].attrs);
    taken.add(owner);
    cursor = Math.min(at + Math.max(words.length, 1), srcWords.length);
  }
  return carried;
}

/** `data-bf-uid="ab12cd34" data-bf-cat="body"` — or '' for an element with none. */
function serializeAttrs(attrs: ElementAttrs | null): string {
  if (attrs === null) return '';
  return Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeXmlLocal(value)}"`)
    .join('');
}

/**
 * Rebuild a chapter's XHTML from the model's cleaned prose chunks, re-attaching
 * EVERY original heading verbatim (tag + level + text + ATTRIBUTES) in document
 * order.
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
export function rebuildChapterPreservingHeadings(originalXhtml: string, cleanedChunkTexts: string[], chunkSize: number = CHUNK_SIZE, preprocess?: (proseText: string) => string): string {
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
        // A heading is one source element rebuilt as one element: it keeps its
        // own attributes exactly.
        bodyParts.push(
          `<${seg.tag}${serializeAttrs(seg.attrs)}>${escapeXmlLocal(headingText)}</${seg.tag}>`);
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

    // Each emitted paragraph carries the attributes of the element its text came
    // from — see `carryAttributesOntoParagraphs` for the rule and why it is
    // decided by words rather than by position.
    const kept = paragraphs.filter((p) => p.trim().length > 0);
    const attrs = carryAttributesOntoParagraphs(kept, seg.sources);
    kept.forEach((p, i) => {
      bodyParts.push(`<p${serializeAttrs(attrs[i])}>${escapeXmlLocal(p)}</p>`);
    });
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
 * Both providers (the bundled local llama.cpp, and a Crucible server) route
 * their cleaned output through this one function from cleanChunkWithProvider,
 * so the quality checks and skipped-chunk accounting are identical no matter
 * which backend ran — when there were four providers each carried its own copy
 * and the local path had NONE, which is how a model that returned empty/short
 * output silently produced hard errors instead of a graceful, recorded
 * fallback.
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

// TTS number normalization: the model reads printed numbers as spoken words and
// answers with the same JSON edit list. Same build copy step as the others.
const NUMBER_NORMALIZE_PROMPT_FILE_PATH =
  path.join(__dirname, 'prompts', 'tts-number-normalize.txt');

let cachedEditListPrompt: string | null = null;
/** Load (and cache) the edit-list cleanup prompt. Throws if missing — required. */
async function loadEditListPrompt(): Promise<string> {
  if (cachedEditListPrompt) return cachedEditListPrompt;
  cachedEditListPrompt = (await fsPromises.readFile(EDITLIST_PROMPT_FILE_PATH, 'utf-8')).trim();
  return cachedEditListPrompt;
}

let cachedNumberNormalizePrompt: string | null = null;
/**
 * Load (and cache) the TTS number-normalization prompt. Throws if missing.
 *
 * Loaded HERE rather than inside the normalizer so the one module that knows
 * where this build keeps its prompts is the one that keeps saying so. The
 * normalizer takes the loaded string as an argument, which is also what lets a
 * test drive it with a prompt of its own.
 */
export async function loadNumberNormalizePrompt(): Promise<string> {
  if (cachedNumberNormalizePrompt) return cachedNumberNormalizePrompt;
  cachedNumberNormalizePrompt =
    (await fsPromises.readFile(NUMBER_NORMALIZE_PROMPT_FILE_PATH, 'utf-8')).trim();
  return cachedNumberNormalizePrompt;
}

/**
 * The wider instruction the NARRATION TEXT PASS asks every block against.
 *
 * Owen, 2026-09-04: *"send every single block through to be sure. I suspect
 * deterministic decisions on this aren't the right way to do it. Let the model
 * decide what should be updated."* So the pass no longer selects by digit: every
 * block goes, and the question it is asked is wider than numbers — abbreviations,
 * all-caps runs, bracketed apparatus, spaced hyphens, roman numerals, footnote
 * markers, and whatever digits the rules declined.
 *
 * COMPOSED, not rewritten. The number half IS
 * `electron/prompts/tts-number-normalize.txt` — the file the orpheus-finetune
 * side vendors byte-for-byte — with the additional classes appended after it.
 * A second copy of the number instructions would be a second thing to keep true,
 * and the corpora would eventually be built against one and the renders against
 * the other.
 */
const NARRATION_TEXT_PROMPT_FILE_PATH =
  path.join(__dirname, 'prompts', 'tts-narration-text.txt');

let cachedNarrationTextPrompt: string | null = null;
export async function loadNarrationTextPrompt(): Promise<string> {
  if (cachedNarrationTextPrompt) return cachedNarrationTextPrompt;
  const numbers = await loadNumberNormalizePrompt();
  const wider = (await fsPromises.readFile(NARRATION_TEXT_PROMPT_FILE_PATH, 'utf-8')).trim();
  cachedNarrationTextPrompt = `${numbers}\n\n${wider}`;
  return cachedNarrationTextPrompt;
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
// Simplify block groups
//
// The simplify-ONLY pass does not chunk prose. It sends the model small GROUPS
// of consecutive body-text BLOCKS (paragraphs), tagged `<block id="N">`, and
// writes each answer back onto the block it came from, 1:1. Nothing is
// re-segmented, so the chapter's element enumeration, its headings and its
// attributes (data-bf-uid …) survive the pass by construction.
//
// It replaces the 8,000-char chunk pipeline for this path because that pipeline
// died on its own edges: a title-page line like "BLACK SUN" became a chunk whose
// num_predict was `text.length * 2` (18 tokens) while the simplify prompt turns
// the model's in-band reasoning ON — a guaranteed REASONING_OVERRUN, repeated
// once per heading-shaped chunk until the absolute 10-fallback threshold aborted
// a 308-unit book at ~3% failures.
//
// Everything in this section is a pure function over strings so it is testable
// without a model (tools/test-simplify-blocks.js); the one model call sits behind
// an injected `call` in simplifyBlockGroup, further down.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Most blocks in one group call. Big enough that a run of dialogue — where every
 * `"No," she said.` is its own <p> — travels as one exchange the model can hear,
 * small enough that the id set stays trivially checkable.
 */
export const MAX_BLOCKS_PER_GROUP = 8;

/** Most characters of block text in one group call (a single longer block goes alone). */
export const GROUP_CHAR_CAP = 4000;

/**
 * A group is only worth a model call at this combined length. The decision is per
 * GROUP, never per block: a short line inside a paragraph run must be simplified
 * WITH its context, and only a group that is short in TOTAL — a title page's
 * "BLACK SUN" + author + subtitle, an orphan line stranded between two headings —
 * has nothing for the model to do. Those are kept verbatim, uncalled.
 */
export const MIN_GROUP_SEND_CHARS = 120;

/**
 * The 40% acceptance gate only means something above this input length. Forty
 * percent of `"No," she said.` is six characters, so the gate on a tiny line
 * measures nothing and would reject legitimate short rewrites; those blocks are
 * validated structurally instead (the tag came back, with text in it).
 */
export const GATE_MIN_INPUT_CHARS = 50;

/**
 * num_predict floor for a block call. The simplify prompt enables in-band
 * reasoning, so the generation budget must cover thinking + the rewrite, not
 * just the rewrite: the chunk-era `text.length * 2` starved short inputs of
 * thinking budget and turned every one of them into a REASONING_OVERRUN.
 */
export const SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR = 4096;

/** A block's rewrite is rejected below this fraction of its input length. */
const SIMPLIFY_BLOCK_ACCEPT_RATIO = 0.4;

/** One block of a chapter, with its position in that chapter's block list. */
export interface SimplifyBlockRef {
  /** Index into the chapter's `extractBlockTextsWithTags` array — the writer's index. */
  index: number;
  text: string;
}

/** A run of consecutive non-heading blocks, and whether it earns a model call. */
export interface SimplifyBlockGroup {
  blocks: SimplifyBlockRef[];
  /** Combined length of the member texts. */
  chars: number;
  /** chars >= MIN_GROUP_SEND_CHARS — an unsent group is kept verbatim. */
  send: boolean;
}

/** Headings are the one categorical exclusion: never sent, never rewritten. */
export function isSimplifyHeadingBlock(block: { tagName: string }): boolean {
  return /^h[1-6]$/.test(block.tagName.toLowerCase());
}

/**
 * Pack a chapter's blocks into groups.
 *
 * Groups are runs of CONSECUTIVE non-heading blocks, greedily filled to
 * MAX_BLOCKS_PER_GROUP blocks / GROUP_CHAR_CAP characters. A heading terminates
 * the run, so a group never spans one and the model never sees two unrelated
 * stretches of the chapter as a single input.
 *
 * Short blocks are members like any other. A line of dialogue is its own <p> in
 * fiction, and it has to be simplified alongside the paragraph it answers — a
 * per-block length filter would have stranded exactly the lines that need their
 * context most. What the length decides is only whether the GROUP is worth a
 * call at all (`send`).
 *
 * A single block longer than the char cap forms a group by itself. Blocks are
 * NEVER split: one block in, one block out is the entire contract that lets the
 * answer be written back without guessing.
 */
export function groupSimplifyBlocks(
  blocks: Array<{ text: string; tagName: string }>
): SimplifyBlockGroup[] {
  const groups: SimplifyBlockGroup[] = [];
  let current: SimplifyBlockRef[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      groups.push({ blocks: current, chars: currentChars, send: currentChars >= MIN_GROUP_SEND_CHARS });
    }
    current = [];
    currentChars = 0;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (isSimplifyHeadingBlock(block)) {
      flush();
      continue;
    }
    const wouldOverflow =
      current.length >= MAX_BLOCKS_PER_GROUP ||
      (current.length > 0 && currentChars + block.text.length > GROUP_CHAR_CAP);
    if (wouldOverflow) flush();
    current.push({ index: i, text: block.text });
    currentChars += block.text.length;
  }
  flush();

  return groups;
}

/**
 * Serialize block texts as the model's user turn. Ids are 1-based WITHIN the
 * call, not chapter-wide — the model never has to reason about a numbering it
 * cannot see the start of, and a single-block degrade call is `id="1"` too.
 */
export function serializeBlocksForModel(texts: string[]): string {
  return texts.map((t, i) => `<block id="${i + 1}">\n${t}\n</block>`).join('\n\n');
}

/**
 * The output-format section appended to the simplify system prompt on the block
 * path. Replaces the prose-era "write your complete rewritten text" contract —
 * on this path the answer's SHAPE is the thing that makes it writable back.
 */
export function simplifyBlockOutputFormat(): string {
  return (
    'OUTPUT FORMAT (this overrides any earlier instruction about how to output): ' +
    'The text is provided as numbered blocks, each written as <block id="N">…</block>. ' +
    'Rewrite each block according to the rules above. First think through the rewrite. ' +
    'Then output, inside a single <answer> ... </answer> block and nothing after it, one ' +
    '<block id="N">rewritten text</block> for EVERY input block — the same ids, in the same ' +
    'order, with no text of your own between or around them. Never merge two blocks into one, ' +
    'never split a block into two, never add a block and never drop a block. If a block needs ' +
    'no change, or cannot be improved, return it unchanged inside its own tags.'
  );
}

/**
 * Parse the model's answer into exactly `expectedCount` block texts.
 *
 * Every deviation THROWS `MALFORMED_BLOCK_ANSWER` — a missing id, a duplicate, an
 * id that was never sent, or any non-whitespace prose outside the block tags.
 * There is no partial credit and no repair: an answer whose shape we cannot trust
 * cannot be aligned onto the source blocks, and guessing an alignment is exactly
 * the class of bug this whole path exists to remove. The caller degrades to
 * single-block calls, and finally to keeping the original text.
 *
 * `answer` is the text INSIDE <answer>…</answer> — run it through extractAnswer
 * first so REASONING_OVERRUN keeps its meaning.
 */
export function parseBlockAnswer(answer: string, expectedCount: number): string[] {
  const re = /<block\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/block\s*>/gi;
  const seen = new Map<number, string>();
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(answer)) !== null) {
    // Anything but whitespace between the tags is the model narrating, which
    // means it did not follow the contract — reject the whole answer.
    if (answer.slice(lastEnd, match.index).trim().length > 0) {
      throw new Error(
        `MALFORMED_BLOCK_ANSWER: non-whitespace text outside the block tags ` +
        `(before block ${match[1]})`
      );
    }
    lastEnd = match.index + match[0].length;

    const id = parseInt(match[1], 10);
    if (seen.has(id)) {
      throw new Error(`MALFORMED_BLOCK_ANSWER: duplicate block id ${id}`);
    }
    if (id < 1 || id > expectedCount) {
      throw new Error(
        `MALFORMED_BLOCK_ANSWER: block id ${id} was never sent (expected 1..${expectedCount})`
      );
    }
    seen.set(id, match[2].trim());
  }

  if (answer.slice(lastEnd).trim().length > 0) {
    throw new Error('MALFORMED_BLOCK_ANSWER: non-whitespace text after the last block tag');
  }
  if (seen.size !== expectedCount) {
    const missing: number[] = [];
    for (let id = 1; id <= expectedCount; id++) if (!seen.has(id)) missing.push(id);
    throw new Error(
      `MALFORMED_BLOCK_ANSWER: expected ${expectedCount} blocks, got ${seen.size}` +
      (missing.length > 0 ? ` (missing id${missing.length > 1 ? 's' : ''} ${missing.join(', ')})` : '')
    );
  }

  const texts: string[] = [];
  for (let id = 1; id <= expectedCount; id++) texts.push(seen.get(id)!);
  return texts;
}

/** What a per-block acceptance decision came to, and why. */
export type BlockVerdict =
  | { accept: true; text: string }
  | { accept: false; reason: 'skip-marker' }
  | { accept: false; reason: 'empty' }
  | { accept: false; reason: 'acceptance-gate'; detail: string }
  | { accept: false; reason: 'repetition'; detail: string };

/**
 * Decide whether ONE returned block may replace its source block. Every "no"
 * keeps the original text; they differ in whether they cost a fallback counter.
 *
 * Free (the model answered, the answer is just not a replacement):
 *  - it echoed `[SKIP]`, i.e. declined this block — the same reading the prose
 *    path has always given a skip marker;
 *  - it returned a SHORT block's tag with nothing in it. Below
 *    GATE_MIN_INPUT_CHARS that structural check is the only check there is, and
 *    an empty answer for a line of dialogue is the model saying nothing rather
 *    than losing something.
 *
 * Counted (the answer would damage the book):
 *  - catastrophic loss on a block of GATE_MIN_INPUT_CHARS or more: under 40% of
 *    the input's length (an empty answer included — for a real paragraph that is
 *    the most complete loss there is). Simplification legitimately shortens and
 *    merges sentences, so the gate is loose; below it the block's content is
 *    gone. Blocks shorter than that are NOT length-gated at all — 40% of
 *    `"No," she said.` is six characters, a threshold that measures nothing and
 *    would reject perfectly good short rewrites;
 *  - a repetition loop. A loop produces MORE text, so no length gate can see it,
 *    and shipping one puts a sentence in the book a hundred times. Content-
 *    correlated, so like the group-level failures it is not re-rolled.
 */
export function judgeBlockRewrite(original: string, returned: string): BlockVerdict {
  const trimmed = returned.trim();
  // Prefix match against ALL the skip markers, exactly like checkAIOutput on the
  // prose path: a model that writes "[SKIP] nothing to do" is still declining,
  // and an equality check would have let that string through the gate and INTO
  // the book as the block's text.
  if (SKIP_MARKERS.some(m => trimmed === m || trimmed.startsWith(m))) {
    return { accept: false, reason: 'skip-marker' };
  }
  if (original.length >= GATE_MIN_INPUT_CHARS) {
    // Long enough for the length gate to mean something. An EMPTY answer lands
    // here too, and rightly counts: for a real paragraph it is the most complete
    // loss there is.
    if (trimmed.length < original.length * SIMPLIFY_BLOCK_ACCEPT_RATIO) {
      return {
        accept: false,
        reason: 'acceptance-gate',
        detail: `${trimmed.length} chars vs ${original.length} input (<${Math.round(SIMPLIFY_BLOCK_ACCEPT_RATIO * 100)}%)`,
      };
    }
  } else if (trimmed.length === 0) {
    // Structural validation only: the tag came back, but with nothing in it.
    return { accept: false, reason: 'empty' };
  }
  const rep = detectRepetition(trimmed);
  if (rep.repeated) {
    return { accept: false, reason: 'repetition', detail: rep.detail ?? 'repetition detected' };
  }
  return { accept: true, text: trimmed };
}

/**
 * num_predict for one block call, from the serialized payload it will send.
 * Floor first, then scale — see SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR.
 */
export function simplifyBlockNumPredict(payload: string): number {
  return Math.max(SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR, payload.length * 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Connection Checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check connection for an AI provider. Two of them exist.
 *
 * The `default` arm is not defensive padding: this is reached from IPC, so a
 * renderer built before the cloud providers were deleted can still ask for
 * `claude`, and what it must get back is a SENTENCE naming what it asked for
 * — not a crash in the main process and not a silent "unavailable" that reads
 * as an outage. TypeScript narrows `provider` to `never` there, which is the
 * point: the only way to arrive is from outside the type system.
 */
export async function checkProviderConnection(
  provider: AIProvider,
  // Which REGISTERED Crucible server to test. Only the `crucible` provider has
  // one, and it has no default — the app's IPC handler never passes it, which is
  // exactly why asking for `crucible` without it is refused by name below rather
  // than answered about some other machine.
  crucibleServer?: string,
): Promise<ProviderConnectionResult> {
  switch (provider) {
    case 'local':
      return checkLocalConnection();
    case 'crucible':
      return checkCrucibleConnection(crucibleServer);
    default:
      return {
        available: false,
        error: `unknown_ai_provider: "${String(provider)}" is not an AI provider this app has. `
          + 'Ollama, Claude and OpenAI were removed on 2026-09-14 — BookForge sends commands to a '
          + 'Crucible server and holds no cloud credentials of its own; the engine forwards to an '
          + 'upstream on the operator\'s account. The two providers are "crucible" and the legacy '
          + '"local" engine.',
      };
  }
}

/**
 * Check one Crucible server: `ping()` says something is there and speaks the
 * protocol (it is the unauthenticated route, so it separates "wrong address"
 * from "wrong token"), then `models()` proves the bearer token AND lists what
 * could be talked to. The `models` a caller gets back are the RESIDENT ones —
 * an installed-but-not-loaded model is not something a cleanup run may use, and
 * reporting it as available would be a promise this provider then refuses to
 * keep.
 */
async function checkCrucibleConnection(server?: string): Promise<ProviderConnectionResult> {
  if (!server) {
    return {
      available: false,
      error: 'crucible_server_not_named: provider "crucible" needs the name of a registered server '
        + '(bookforge-tts --crucible-list). There is no default server.',
    };
  }
  try {
    const client = await crucibleClient(server);
    await client.ping();
    const rows = await client.models();
    return { available: true, models: rows.filter((m) => m.resident).map((m) => m.id) };
  } catch (err) {
    const translated = translateCrucibleError(err, server);
    // The SDK's eight types (translateCrucibleError returns a NEW Error for each
    // and the original for anything else), plus the registry's own named
    // refusals — an unknown server name is a refusal, not an outage. Anything
    // else keeps its stack: a connection test does not answer "unavailable" to a
    // programming error.
    if (translated !== err) return { available: false, error: (translated as Error).message };
    if (err instanceof Error && err.name === 'CrucibleRegistryError') {
      return { available: false, error: err.message };
    }
    throw err;
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
 * The app is quitting: bring down every model an active AI job is holding ON
 * THIS MACHINE.
 *
 * Which, since the cloud and Ollama providers left, means exactly one thing —
 * the bundled llama-server. A `crucible` job holds nothing here: the model is
 * on somebody else's card and that server owns when it comes off, so abandoning
 * the socket IS the whole of the release and there is nothing for this function
 * to evict.
 *
 * What it covers that a finished or cancelled job cannot (cancelCleanupJob) is
 * the app dying MID-JOB, with a local server resident and several GB of a dead
 * app's model squatting in VRAM (Owen, 2026-08-12).
 *
 * Best-effort by design — every step is bounded and failure only means the
 * server's own idle timer is the backstop, exactly as it is for a hard SIGKILL,
 * which no in-process code can ever cover.
 */
export async function releaseActiveAiJobsForShutdown(): Promise<void> {
  if (activeCleanupJobs.size === 0) return;
  const jobs = [...activeCleanupJobs.entries()];
  activeCleanupJobs.clear();

  const releases: Promise<void>[] = [];
  for (const [jobId, job] of jobs) {
    console.log(`[AI-BRIDGE] Shutdown: aborting job ${jobId} and releasing its model`);
    job.controller.abort();
    if (job.provider === 'local') {
      releases.push(
        import('./llama-bridge.js')
          .then(({ llamaBridge }) => llamaBridge.stop())
          .catch((err) => console.warn(`[AI-BRIDGE] Shutdown: failed to stop local server: ${(err as Error).message}`))
      );
    }
  }
  await Promise.all(releases);
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
 * Which of the two cleanup passes to run. They are independent products, not
 * degrees of one setting:
 *   'ocr'  — pass 1 only. The per-chunk model pass that fixes scanner damage.
 *            Final artifact is repaired.epub: faithful text, every footnote marker
 *            and curly quote still in place. What reading/translation/training want.
 *   'tts'  — pass 2 only. Deterministic, no per-chunk model calls: footnote-marker
 *            removal, quote normalization, number expansion. Seconds, not hours.
 *            Final artifact is cleaned.epub.
 *   'both' — pass 1 then pass 2. repaired.epub AND cleaned.epub.
 */
export type CleanupStages = 'ocr' | 'tts' | 'both';
export const CLEANUP_STAGES: readonly CleanupStages[] = ['ocr', 'tts', 'both'];

// ─────────────────────────────────────────────────────────────────────────────
// Crucible — a cleanup pass on somebody else's GPU
// ─────────────────────────────────────────────────────────────────────────────
//
// Crucible (crucible docs/DESIGN.md, docs/PHASE2-LLM.md) is one inference server
// for all of Owen's apps: it runs models and returns bytes, and never knows what
// a cleanup pass is. This provider is BookForge's consumer of its `llm` job type
// — the Mac Studio's GPU, or the PC's WSL2 server, reached over HTTP by exactly
// one code path.
//
// Two rules it does not bend, both from PHASE2-LLM.md section 7:
//   1. The model must ALREADY be resident. A cleanup run never loads one — that
//      is the operator's job (`--crucible-load`), because a load evicts whatever
//      else is resident and takes minutes, and neither belongs inside a book.
//   2. Nothing is defaulted. `server` names a registry entry and `act` names one
//      of the four capability classes; a config missing either is refused by
//      name.
//
// And one thing that is NO LONGER the config's to say, since PHASE15 §5.3: the
// MODEL. `crucible install` probes the card on each host and picks the largest
// candidate that fits, so a 24 GB box serves `translate` with a 4-bit 27B and a
// 12 GB box does not serve it at all — a per-HOST fact. An id chosen here would
// be a second opinion about a decision that already has an owner, so the
// preflight READS it from `GET /v1/capability` and stamps it onto the config for
// reporting.

// This client's name in the Crucible server's log and User-Agent used to be a
// const here. It is `CRUCIBLE_CLIENT_NAME` in ./crucible/servers.ts now, because
// the Servers settings row calls the same servers and a second spelling would be
// a second app in their logs (crucible docs/ARCHITECTURE.md, R1).

/**
 * The `crucible` provider's config, or a refusal naming the missing half.
 *
 * Neither field is guessable — a server name is whatever this machine called
 * the entry, and only the caller knows whether this run is a clean or a
 * simplify — so neither is defaulted. A caller that reaches here with one
 * missing has a bug, and gets a message that says which.
 *
 * The ACT is refused as hard as the server, and for a sharper reason than
 * tidiness: Crucible rejects an act name it does not know (`400 unknown_act`),
 * and the act travels into the server's own bench display, so a run that
 * guessed would either be refused or be confidently mislabelled. Owen ruled
 * that out by name — *"they can't lie to the user and say a translate job is
 * running when it's actually a simplify job"*.
 *
 * `model` is NOT read here. It is the server's decision and an OUTPUT of the
 * preflight — see the section header.
 */
function crucibleConfigOf(config: AIProviderConfig): { server: string; act: CrucibleTextAct } {
  const server = config.crucible?.server;
  const act = config.crucible?.act;
  if (!server) {
    throw new Error('crucible_server_not_named: provider "crucible" needs crucible.server — the '
      + 'name of an entry in the server registry (bookforge-tts --crucible-list)');
  }
  if (!isCrucibleTextAct(act)) {
    throw new Error('crucible_act_not_named: provider "crucible" needs crucible.act — one of '
      + `clean, translate, simplify, analysis (got ${act === undefined ? 'nothing' : JSON.stringify(act)}). `
      + 'The act says which capability class this run is; the server refuses a name it does not '
      + 'know and shows the one it is given, so it is never guessed.');
  }
  return { server, act };
}

/**
 * The three things one chat needs, or a refusal naming what is missing.
 *
 * The model half is not read from the caller's intent — it is read from what
 * {@link stampCrucibleModelForRun} wrote there, which is what the server's own
 * capability record said. So a config that arrives here unstamped means the
 * run reached a chat before it asked the server anything, and that is a bug in
 * this app's order of operations rather than anything the operator can fix: it
 * is named as such and never papered over with an id guessed here, which would
 * be the second opinion §5.3 removed.
 */
function crucibleRunTargetOf(
  config: AIProviderConfig,
): { server: string; act: CrucibleTextAct; model: string } {
  const { server, act } = crucibleConfigOf(config);
  const model = config.crucible?.model;
  if (model === undefined || model === '') {
    throw new Error('crucible_model_not_stamped: the run reached a chat on crucible '
      + `"${server}" before anything read that server's capability record, so nothing knows `
      + `which model serves the "${act}" class there. The model is the SERVER's decision `
      + '(GET /v1/capability), stamped onto the config once at the start of the run; a chat '
      + 'never picks one.');
  }
  return { server, act, model };
}

/**
 * THE MODEL THIS ACT RUNS ON, READ FROM THE SERVER THAT WILL RUN IT — once.
 *
 * crucible `docs/PHASE15-HOST.md` §5.3: *"The cleanup/OCR/translation/simplify/
 * analysis doors send `capability.selected` as the model to the registry's
 * server and nothing else."* `crucible install` probes that host's card and
 * picks the largest candidate that fits, so the answer is a per-HOST fact and
 * the app's only honest move is to ask. `modelFromCapability` is the pure half
 * of that (it refuses three different ways, each naming what a person would do
 * about it) and lives in `text-venue.ts` so a keeper can drive all three with
 * no network; this is the READ plus the stamp.
 *
 * ── WHY IT IS HERE AND NOT IN THE PREFLIGHT ────────────────────────────────
 *
 * The preflight is inside {@link cleanupEpubRun}, and the LEASE that wraps that
 * run needs the model id to say what it is holding. Resolving it in both places
 * would be two reads of one record with nothing comparing them — the shape
 * crucible `docs/ARCHITECTURE.md` R1 exists to stop. So the read happens once,
 * at the outermost door, and the preflight reads back what it stamped (through
 * {@link crucibleRunTargetOf}, which refuses by name if this never ran) and
 * spends its own round trip on the question this one does not answer: whether
 * that model is RESIDENT.
 *
 * The stamp is a read, not a decision — exactly what `config.crucible.model` is
 * documented to be. Nothing branches on it; the reporting sites name it.
 */
async function stampCrucibleModelForRun(
  config: AIProviderConfig,
): Promise<{ server: string; act: CrucibleTextAct; model: string }> {
  const { server, act } = crucibleConfigOf(config);
  /*
   * THE READ AND THE STAMP ARE `crucibleActModel`'S, not this file's.
   *
   * `text-ai.ts`'s `callCrucible` needs exactly the same answer, and two
   * copies of "read the capability record, pick the row, write the id down"
   * would be two chances to disagree about what a simplify runs on — the
   * shape crucible `docs/ARCHITECTURE.md` R1 exists to stop. So it lives once,
   * beside the pure `modelFromCapability` it wraps, and this function is the
   * cleanup run's call to it plus the pair the lease and the preflight read
   * back.
   */
  const { crucibleActModel } = await import('./crucible/text-venue.js');
  const block = { server, act, ...(config.crucible?.model === undefined ? {} : { model: config.crucible.model }) };
  const model = await crucibleActModel(block);
  config.crucible = { server, act, model };
  return { server, act, model };
}

/**
 * A client bound to a registered Crucible server.
 *
 * The registry module is imported lazily (the llama-bridge pattern) because it
 * resolves `<userData>` through Electron's `app`, and because a job using any
 * other provider has no business reading a file full of bearer tokens.
 */
async function crucibleClient(server: string): Promise<CrucibleClient> {
  const { crucibleClientFor, CRUCIBLE_CLIENT_NAME } = await import('./crucible/servers.js');
  return crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
}

/**
 * One SDK failure, rendered as the Error surface every other provider throws.
 *
 * cleanChunkWithProvider's machinery reads MESSAGES: an abort is
 * `error.name === 'AbortError'`, a retryable transport failure is a message
 * carrying `network`/`socket`/`timeout`/`fetch`, and anything else is fatal for
 * the chunk. The SDK instead throws one TYPE per failure. This is the single
 * place those two vocabularies meet, so that the retry / timeout / abort
 * machinery keyed on those messages applies to a Crucible failure at all —
 * `fetch` supplies "fetch failed" of its own accord for a transport failure,
 * and `CrucibleUnreachable` is the same news wearing a type.
 *
 * An abort is deliberately NOT translated: the SDK throws the DOM `AbortError`
 * straight through, and that is the name the caller already checks for.
 * Anything that is not one of the SDK's eight types is returned UNCHANGED — an
 * unexpected exception keeps its stack rather than becoming a message.
 */
function translateCrucibleError(err: unknown, server: string): unknown {
  const at = `crucible "${server}"`;
  if (err instanceof CrucibleUnreachable) {
    // "network" is the token the retry machinery keys on, so a server that is
    // down is retried as any other transport failure is.
    return new Error(`${at} network failure: ${err.message}`);
  }
  if (err instanceof CrucibleRefused && err.code === 'model_not_resident') {
    return new Error(`crucible_model_not_resident: ${at} is not serving "${err.serverMessage}". `
      + `Load it first — bookforge-tts --crucible-load --server ${server} --model <id> — a cleanup `
      + 'run never loads a model behind your back.');
  }
  if (err instanceof CrucibleAuthError) {
    return new Error(`${at} refused the token (${err.code}): ${err.serverMessage}. Re-add the `
      + 'server with the token `crucible token --show` prints on that host.');
  }
  if (err instanceof CrucibleVersionError) {
    return new Error(`${at} speaks API version ${err.serverApiVersion}, this client speaks `
      + `${err.clientApiVersion} (${err.code}): ${err.serverMessage}. One of the two must be updated.`);
  }
  if (err instanceof CrucibleRefused) {
    return new Error(`${at} refused the request (${err.status} ${err.code}): ${err.serverMessage}`);
  }
  if (err instanceof CrucibleServerError) {
    return new Error(`${at} failed the request (${err.status} ${err.code}): ${err.serverMessage}. `
      + 'The server broke; its own log says why.');
  }
  if (err instanceof CrucibleNotACrucible) {
    return new Error(`${at} answered /v1/ping but is not a crucible: ${err.body}. Check the url.`);
  }
  if (err instanceof CrucibleProtocolError) {
    return new Error(`${at} sent something API v1 does not describe: ${err.detail}. The server and `
      + 'this client disagree about the protocol.');
  }
  if (err instanceof CrucibleConfigError) {
    return new Error(`${at}: the client was built wrong — ${err.message}`);
  }
  return err;
}

/**
 * The `/v1/models` rows for one server, as the Error surface.
 * Used by the once-per-job residency check and by the connection test.
 */
async function crucibleModelRows(server: string): Promise<ModelInfo[]> {
  const client = await crucibleClient(server);
  try {
    return await client.models();
  } catch (err) {
    throw translateCrucibleError(err, server);
  }
}

/**
 * The ONE residency check a cleanup job makes — at the start, not per chunk.
 *
 * Per-chunk it would be a `/v1/models` round trip for every 2,000 characters of
 * a book, and it would answer a question that cannot change underneath a running
 * job without the operator doing something deliberate elsewhere. At job start it
 * is what turns "the 47th chunk failed" into "this job cannot run", before a
 * single chunk is sent.
 *
 * Refuses by name: `crucible_unknown_model` when the host has no manifest for
 * that id, `crucible_model_not_resident` when it has one and nothing is serving
 * it. Never loads it — see the section header.
 */
async function assertCrucibleModelResident(server: string, model: string): Promise<void> {
  /*
   * AN UPSTREAM MODEL IS NEVER RESIDENT, and that is not a failure to check.
   *
   * crucible `docs/PHASE15-HOST.md` §3.4 says it in the server's own refusal:
   * *"an upstream model is never resident; send the chat."* `GET /v1/models`
   * lists what this host has MANIFESTS for, so `anthropic/claude-sonnet-5` is
   * not in it and never will be — asking would refuse `crucible_unknown_model`
   * and tell somebody to `--crucible-load` a thing that cannot be loaded.
   *
   * Same discriminator as the lease guard, through the same function, for the
   * same reason: two readings of "what does an upstream model id look like"
   * would be two chances to disagree.
   */
  if (isUpstreamModelId(model)) return;
  const rows = await crucibleModelRows(server);
  const row = rows.find((m) => m.id === model);
  if (!row) {
    const known = rows.map((m) => m.id).join(', ');
    throw new Error(`crucible_unknown_model: crucible "${server}" has no model "${model}" `
      + `(${rows.length === 0 ? 'it advertises none' : `known: ${known}`})`);
  }
  if (!row.resident) {
    const resident = rows.filter((m) => m.resident).map((m) => m.id);
    throw new Error(`crucible_model_not_resident: "${model}" is not resident on crucible `
      + `"${server}" (${resident.length > 0 ? `resident: ${resident.join(', ')}` : 'nothing is resident'}). `
      + `Load it first: bookforge-tts --crucible-load --server ${server} --model ${model}`);
  }
}

/**
 * Clean up a chunk of text on a Crucible server.
 *
 * It feeds the same safeguards every chunk in this file feeds, so it keeps the
 * same 3-minute per-chunk timeout, the same chained abort, the same
 * `max(4096, len*2)` token budget, the same temperature, the same
 * empty-answer → `[SKIP]` trapdoor and the same extractAnswer tail. Three
 * things are its own, each required by what is on the other end:
 *
 *  - `thinking: false`. Qwen3.5 and its kind emit `reasoning` first and
 *    `content` after, so a bounded budget can be spent ENTIRELY on reasoning and
 *    return a message with no content at all. A cleanup pass wants the answer.
 *  - `finishReason === 'length'` routes through the unified `[SKIP]` split: a
 *    truncated chunk is not text to ship, whatever produced it.
 *  - `maxTokensOverride`. The rewrite-era `max(4096, len*2)` estimate is the
 *    DEFAULT, not the rule: an edit-list or observation call emits a small JSON
 *    answer whose size has nothing to do with the input's, and its caller has
 *    already sized the budget (EDITLIST_NUM_PREDICT). Measured 2026-09-12:
 *    without it, 2 of 9 edit-list chunks on a 19 KB EPUB hit the 4096 ceiling,
 *    and each cost 142 s in the resulting [SKIP] split — against 1.2-1.6 s for
 *    a chunk that fitted.
 */
/**
 * ONE COMPLETION AGAINST A CRUCIBLE SERVER — the transport, and nothing about
 * what the answer is for.
 *
 * Extracted from `cleanChunkWithCrucible` when the SECOND and THIRD acts needed
 * it (translation and analysis, 2026-09-14, rollout item A3). Three copies of a
 * timeout, an abort chain and an error translation is three places for a
 * refusal to stop naming itself (crucible `docs/ARCHITECTURE.md` R1), and the
 * error translation in particular is load-bearing: `translateCrucibleError`
 * turns the SDK's exceptions into the named codes every surface reads
 * (`crucible_model_not_resident`, `crucible_model_leased`, …).
 *
 * What it does NOT decide: the temperature, the budget, what an empty answer
 * means, or whether a `length` finish is a retry — those belong to the act, and
 * a shared default for them would be the shared default that made the cleanup
 * pass truncate. Every field is the caller's.
 *
 * `thinking: false` IS here, because it is a fact about the SERVER's models
 * rather than about any act: Qwen3.5 and its kind emit `reasoning` first and
 * `content` after, so a bounded budget can be spent entirely on reasoning and
 * return a message with no content at all. No BookForge act wants that.
 */
export async function crucibleChatOnce(options: {
  server: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** For the timeout sentence — "for a 4,812-char chunk". */
  sizeChars: number;
  signal?: AbortSignal;
}): Promise<{ content: string; finishReason?: string }> {
  const { server, model } = options;
  const controller = new AbortController();
  // Whose abort it was. The SDK throws the DOM AbortError for both, and the
  // caller reads an AbortError as "the job was cancelled" — true when the USER
  // cancelled, a lie when this timer fired. So the timeout is named in the
  // message instead, and retried like any other transport stall rather than
  // ending the chunk.
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);

  // Chain abort signals - if parent aborts, abort this request too
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const client = await crucibleClient(server);
    try {
      const answer = await client.chat({
        model,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        thinking: false,
        signal: controller.signal,
      });
      return { content: answer.content, finishReason: answer.finishReason };
    } catch (err) {
      if (timedOut) {
        throw new Error(`Crucible timeout: no answer from "${server}" within ${TIMEOUT_MS / 1000}s `
          + `for a ${options.sizeChars}-char chunk. The model may be running away on this chunk — `
          + 'its engine log on that host says how many tokens it produced.');
      }
      throw translateCrucibleError(err, server);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cleanChunkWithCrucible(
  text: string,
  systemPrompt: string,
  server: string,
  model: string,
  abortSignal?: AbortSignal,
  maxTokensOverride?: number
): Promise<string> {
  const answer = await crucibleChatOnce({
    server,
    model,
    system: systemPrompt,
    user: text,
    temperature: 0.1,
    maxTokens: maxTokensOverride ?? Math.max(4096, text.length * 2),
    sizeChars: text.length,
    ...(abortSignal === undefined ? {} : { signal: abortSignal }),
  });

  // Never `content || text`. An empty/refusal answer must go through the
  // [SKIP] trapdoor (split → retry → register a skipped chunk), not silently
  // return the original as a clean "0 changes" success. See no-fallbacks rule.
  const extracted: string = answer.content;
  if (!extracted.trim()) {
    console.warn(`[Crucible] Empty response (finish_reason: ${answer.finishReason}) for ${text.length}-char chunk — routing through [SKIP] handling`);
  }
  const cleaned = extracted.trim() ? extracted : '[SKIP]';

  if (answer.finishReason === 'length') {
    console.warn(`[Crucible] hit the token budget (finish_reason: length) for ${text.length}-char chunk — routing through unified [SKIP] split`);
    return '[SKIP]';
  }

  // Separate answer from any reasoning/answer-tag wrapper: an answer-tag prompt
  // (edit-list, simplify) must not leak its tags, and an unclosed answer throws
  // REASONING_OVERRUN.
  return extractAnswer(cleaned, model);
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
  // An unterminated <think> is a failed generation, not text to ship. See
  // extractAnswer().
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
          case 'crucible': {
            // The model was read from the server's capability record and
            // residency proven once, at job start (cleanupEpub's preflight).
            // This only reads back what that stamped, refusing by name rather
            // than defaulting.
            const { server, model } = crucibleRunTargetOf(config);
            return cleanChunkWithCrucible(inputText, systemPrompt, server, model, abortSignal);
          }
          case 'local':
            return cleanChunkWithLocal(inputText, systemPrompt, abortSignal);
          default:
            throw new Error(`unknown_ai_provider: ${String(config.provider)}`);
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
 *
 * EXPORTED because the TTS number normalizer's runner reaches a Crucible
 * directly now that the named Ollama edit-list door is gone, and an answer that
 * arrived over that door has exactly the same two shapes and the same
 * unterminated-`<think>` failure as one that arrived over this file's. A second
 * copy of this reader is a second place the reasoning leak can come back.
 */
export function extractAnswer(raw: string, model: string): string {
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

/**
 * num_predict for one edit-list chunk call — almost all of it in-band thinking, the
 * edit-list JSON itself is tiny. 4096 truncated ~0.8% of normal-sized chunks (1400–1700
 * chars) into a REASONING_OVERRUN, i.e. a skipped chunk. Used in BOTH places that must
 * agree: the call itself and the job's num_ctx sizing (a window smaller than the budget
 * clips the generation), which is why it is one constant.
 */
const EDITLIST_NUM_PREDICT = 6144;

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
 * pass. `numCtx` is honoured by nobody left — the Crucible engine's context is
 * fixed at load and the bundled local engine's at startup — and it is kept on
 * the signature because the callers that compute it are the same callers that
 * compute `numPredict`, which IS honoured and matters. See the crucible arm.
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
    case 'crucible': {
      // `numCtx` IS ignored — the Crucible engine's context is the manifest's
      // `context_default`, fixed when the model was loaded, and nothing here can
      // change it. `numPredict` is NOT: this door's callers are the edit-list and
      // observation passes, whose small JSON answer has nothing to do with the
      // input's size and whose budget they have already computed. Dropping it is
      // what made 2 of 9 chunks truncate at 4096 and cost 142 s apiece.
      const { server, model } = crucibleRunTargetOf(config);
      return cleanChunkWithCrucible(inputText, systemPrompt, server, model, abortSignal, numPredict);
    }
    case 'local':
      return cleanChunkWithLocal(inputText, systemPrompt, abortSignal);
    default:
      throw new Error(`unknown_ai_provider: ${String(config.provider)}`);
  }
}

/** Parsed result of one book-level footnote observation call, for the job report. */
export interface FootnotePrepassReport {
  status: 'applied' | 'no-markers' | 'failed' | 'no-substantial-chapter' | 'not-needed';
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
  /** join/hyphen counts over the MERGED map (corpus-proven + model-adjudicated). */
  join: number;
  hyphen: number;
  unresolved: number;
  degradedPairs: string[];
  /** Decided by corpus attestation alone — never sent to the model. */
  provenJoin: number;
  provenHyphen: number;
  /** Unproven pairs the model actually returned a usable verdict for. */
  modelAdjudicated: number;
}

/** The footnote-removal plan derived in pass 1 and applied deterministically in
 *  pass 2 (TTS prep). Persisted so pass 2 is reproducible from the report alone. */
export interface FootnotePlanReport {
  regexSource: string;
  flags: string;
  observation: FootnoteObservation;
}

/** Pass-2 (TTS prep) outcome: per-chapter footnote/quote/number transforms. */
export interface TtsPrepReport {
  chaptersTransformed: number;
  totalFootnoteDeletions: number;
  totalFootnoteSpared: number;
  totalQuoteNorm: number;
  totalNumbersExpanded: number;
  /**
   * Numbers left as digits because they stood in footnote-marker position — i.e.
   * reference markers the footnote pass did NOT remove. The honest miss count:
   * expanding these would have hidden them inside the prose as words.
   */
  totalMarkerShapedLeft: number;
  /** Markers recovered from sequence gaps that the composed regex could not match. */
  totalFootnoteRecovered: number;
  /** Markers removed on the ORIGINAL EPUB's own <sup> markup — proof, not inference. */
  totalFootnoteStructural: number;
  /** Structural markers rejected: context ambiguous, or the expected digits were absent. */
  structuralAmbiguous?: number;
  structuralNotFound?: number;
  chapters: Array<{
    id: string;
    title: string;
    footnoteDeletions: string[];       // marker text actually removed
    footnoteSpared: number[];          // off-chain values left in place
    footnoteGateSkipReason?: string;   // set when the chain gate refused this chapter
    footnoteRecovered?: number[];      // values recovered from sequence gaps
    quoteNorm: number;
    numbersExpanded: number;
    markerShapedLeft?: number;         // un-removed markers left as digits here
  }>;
  numberSamples: string[];             // "50,000 → fifty thousand" samples for eyeballing
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
  // DEFAULT_MODEL is the SIZE the ceiling is derived from, not a model anything
  // will run: `numCtx` reaches no provider that still exists (see
  // callProviderExtracted). It is computed because the window it bounds is real.
  const numCtx = estimateNumCtxForBudget(FOOTNOTE_OBSERVATION_PROMPT, observedText, 4096, DEFAULT_MODEL);
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
 * Batch the UNPROVEN hyphen pairs to the model (100 per call) and collect verdicts.
 * Any pair the model doesn't adjudicate (missing, unknown verdict, or a whole batch
 * that fails to parse) is left OUT of the map, so applyHyphenJoins takes the
 * conservative action and records it. Returns the verdict map + the pairs it left
 * unresolved; the caller merges these with the corpus-proven verdicts and builds the
 * report from the MERGED map (this function can't see the proven half).
 */
async function planHyphenJoins(
  pairs: string[],
  config: AIProviderConfig,
  abortSignal?: AbortSignal,
  onBatch?: (done: number, total: number) => void
): Promise<{ verdicts: Map<string, HyphenVerdict>; unresolved: string[] }> {
  const verdicts = new Map<string, HyphenVerdict>();
  const BATCH = 100;
  const totalBatches = Math.ceil(pairs.length / BATCH);
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const prompt = buildHyphenVerdictPrompt(batch);
    // Budget scales with the batch (each verdict is small, but thinking over 100
    // items is not) so a full batch doesn't truncate into a REASONING_OVERRUN. A
    // truncated batch is still safe (its pairs stay unresolved → conservative).
    const numPredict = Math.max(4096, batch.length * 80);
    // DEFAULT_MODEL only sizes the ceiling — see the footnote observation pass.
    const numCtx = estimateNumCtxForBudget(prompt, 'Adjudicate every item above.', numPredict, DEFAULT_MODEL);
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
    onBatch?.(Math.floor(i / BATCH) + 1, totalBatches);
  }
  return { verdicts, unresolved: pairs.filter(p => !verdicts.has(p)) };
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
      answer = await callProviderExtracted(chunkText, systemPrompt, config, jobNumCtx, jobTemperature, EDITLIST_NUM_PREDICT, abortSignal);
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

// ─────────────────────────────────────────────────────────────────────────────
// Simplify block groups — the model call and the degrade ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One model call for the block path: system prompt + serialized blocks in, the
 * extracted <answer> body out. Injected so simplifyBlockGroup is testable
 * against scripted answers; in production it is bound to callProviderExtracted,
 * NOT to cleanChunkWithProvider.
 *
 * (cleanChunkWithProvider's output safeguards are wrong for this path by
 * construction: on a suspicious answer they cut the INPUT in half at a prose
 * break point and re-send each half, which would slice a serialized
 * `<block id="2">` down the middle. The block path's safeguards are the strict
 * parse, the per-block verdict and the degrade-to-singles ladder below — the
 * same shape the edit-list pass uses, and for the same reason.)
 */
export type SimplifyBlockCall = (payload: string, numPredict: number) => Promise<string>;

/**
 * Bind a SimplifyBlockCall to the configured provider.
 *
 * Only transport failures are retried, with the same backoff the edit-list pass
 * uses (they are input-independent, so a re-roll is a real second chance). A
 * REASONING_OVERRUN propagates untouched — the ladder in simplifyBlockGroup owns
 * that decision.
 */
export function makeSimplifyBlockCall(
  systemPrompt: string,
  config: AIProviderConfig,
  jobNumCtx: number,
  jobTemperature: number,
  maxRetries: number,
  abortSignal: AbortSignal | undefined
): SimplifyBlockCall {
  return async (payload: string, numPredict: number): Promise<string> => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (abortSignal?.aborted) throw new Error('Job cancelled');
      try {
        return await callProviderExtracted(payload, systemPrompt, config, jobNumCtx, jobTemperature, numPredict, abortSignal);
      } catch (error) {
        if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new Error('Job cancelled');
        }
        const msg = error instanceof Error ? error.message : String(error);
        const retryable = /fetch|network|ECONNREFUSED|ECONNRESET|socket|timeout/i.test(msg);
        if (retryable && attempt < maxRetries) {
          console.warn(`[AI-SIMPLIFY] block call attempt ${attempt} failed (${msg}), retrying in ${attempt * 2}s...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          lastError = error as Error;
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('Failed to complete block call after retries');
  };
}

/** Identifies a group inside the job, for skipped-chunk records. */
export interface SimplifyGroupMeta {
  chapterTitle: string;
  /** 1-based job-wide group number — the "Chunk N/M" the UI shows. */
  overallChunkNumber: number;
  /** Total groups in the job. */
  totalChunks: number;
}

/**
 * Simplify ONE group of blocks, returning the final text for each member block —
 * the model's rewrite where it was accepted, the ORIGINAL text where it was not.
 * The return array is always exactly as long as `group.blocks`.
 *
 * The ladder, in order:
 *
 *  1. One call for the whole group. If it comes back well-formed, each block is
 *     judged on its own (judgeBlockRewrite): one bad block costs one block, not
 *     the group.
 *  2. A REASONING_OVERRUN or a malformed answer is CONTENT-CORRELATED — re-rolling
 *     the same call at the same settings just burns another 60-90s reproducing
 *     it. So the group is not retried; it degrades to one call per block, which
 *     is a genuinely different call (a shorter input thinks for less long).
 *     A group of one has nowhere to degrade to, so it goes straight to step 3.
 *  3. A single-block call that overruns, comes back malformed, fails its verdict
 *     or errors out keeps the ORIGINAL block, records a skipped chunk with the
 *     fitting reason, and increments the matching counter — once per failed
 *     BLOCK, never once per group.
 *
 * Transport errors are retried with backoff inside the call (input-independent);
 * this function never re-rolls for content.
 */
export async function simplifyBlockGroup(
  group: SimplifyBlockGroup,
  call: SimplifyBlockCall,
  state: CleanupJobState,
  meta: SimplifyGroupMeta
): Promise<string[]> {
  const originals = group.blocks.map(b => b.text);

  const recordBlockKept = (
    memberIdx: number,
    reason: SkippedChunk['reason'],
    aiResponse: string
  ) => {
    state.skippedChunks.push({
      chapterTitle: meta.chapterTitle,
      // The block's own index within its chapter — the thing a reader of
      // skipped-chunks.json needs in order to find it in the book.
      chunkIndex: group.blocks[memberIdx].index,
      overallChunkNumber: meta.overallChunkNumber,
      totalChunks: meta.totalChunks,
      reason,
      text: originals[memberIdx],
      aiResponse: aiResponse.substring(0, 500),
    });
  };

  /** Apply a well-formed answer's blocks to `into`, judging each one. */
  const applyVerdicts = (returned: string[], memberIdxs: number[], into: string[]) => {
    for (let k = 0; k < memberIdxs.length; k++) {
      const memberIdx = memberIdxs[k];
      const verdict = judgeBlockRewrite(originals[memberIdx], returned[k]);
      if (verdict.accept) {
        into[memberIdx] = verdict.text;
        continue;
      }
      if (verdict.reason === 'skip-marker' || verdict.reason === 'empty') {
        // The model declined this block, or said nothing for it. An answer, not
        // a failure — the original stands and no counter moves.
        console.log(`[AI-SIMPLIFY] Block ${group.blocks[memberIdx].index} returned ${verdict.reason === 'empty' ? 'an empty block' : '[SKIP]'} — keeping original`);
        continue;
      }
      if (verdict.reason === 'acceptance-gate') {
        console.warn(`[AI-SIMPLIFY] Block ${group.blocks[memberIdx].index} acceptance-gate: ${verdict.detail} — keeping original`);
        state.truncatedFallbackCount++;
      } else {
        console.warn(`[AI-SIMPLIFY] Block ${group.blocks[memberIdx].index} repetition: ${verdict.detail} — keeping original`);
        state.repetitionFallbackCount++;
      }
      recordBlockKept(memberIdx, verdict.reason, returned[k]);
    }
  };

  // Start from the originals: every slot already holds the answer we ship if the
  // model gives us nothing usable for it. Nothing here can lose a block's text.
  const finals = [...originals];

  // ── Step 1: one call for the whole group ───────────────────────────────────
  if (group.blocks.length > 1) {
    const payload = serializeBlocksForModel(originals);
    try {
      const answer = await call(payload, simplifyBlockNumPredict(payload));
      const returned = parseBlockAnswer(answer, originals.length);
      applyVerdicts(returned, originals.map((_, i) => i), finals);
      return finals;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Cancellation and dead-account errors are not something a smaller call
      // survives — they must reach the driver, which stops the job.
      if (msg === 'Job cancelled' || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (isUnrecoverableProviderError(msg)) throw error;
      console.warn(
        `[AI-SIMPLIFY] Group of ${group.blocks.length} failed (${msg.split('\n')[0]}) — degrading to single-block calls`
      );
    }
  }

  // ── Steps 2-3: one call per member block ───────────────────────────────────
  for (let i = 0; i < group.blocks.length; i++) {
    const payload = serializeBlocksForModel([originals[i]]);
    try {
      const answer = await call(payload, simplifyBlockNumPredict(payload));
      const returned = parseBlockAnswer(answer, 1);
      applyVerdicts(returned, [i], finals);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'Job cancelled' || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (isUnrecoverableProviderError(msg)) throw error;
      // Overrun, malformed answer, or a transport error the call already retried
      // to exhaustion: keep this block, record it, count it. One block, one
      // increment — never a whole group's worth.
      const reason: SkippedChunk['reason'] = msg.includes('REASONING_OVERRUN') ? 'reasoning-overrun' : 'error';
      console.warn(`[AI-SIMPLIFY] Block ${group.blocks[i].index} kept (${reason}): ${msg.split('\n')[0]}`);
      state.errorFallbackCount++;
      recordBlockKept(i, reason, msg);
    }
  }

  return finals;
}

/** A chapter's blocks, the groups packed out of them, and the ones worth a call. */
export interface ChapterBlockPlan {
  blocks: Array<{ text: string; tagName: string; attrs: Record<string, string> }>;
  /** Every group, sendable or not. */
  groups: SimplifyBlockGroup[];
  /**
   * The subset with `send` — the chapter's actual WORK, and therefore the unit
   * the job counts, checkpoints, limits in test mode and shows as "Chunk N/M".
   * A group under MIN_GROUP_SEND_CHARS is not a unit of work: nothing is sent,
   * nothing is written, and counting it would make a title-page chapter look
   * like progress.
   */
  sendable: SimplifyBlockGroup[];
}

/**
 * Read a chapter's blocks and pack them into groups. The block list is THE
 * source of both identity and ordering (extractBlockTextsWithTags), and the
 * writer walks the same selector with the same filter, so `blocks[i]` and the
 * writer's element i are the same element by construction.
 */
export function planChapterBlockGroups(xhtml: string): ChapterBlockPlan {
  const blocks = extractBlockTextsWithTags(xhtml);
  const groups = groupSimplifyBlocks(blocks);
  return { blocks, groups, sendable: groups.filter(g => g.send) };
}

/**
 * Simplify one chapter, group by group, and return the rebuilt XHTML.
 *
 * The writer is handed one entry per block: `null` for every block this pass did
 * not change — headings, the members of a group too short to be worth a call,
 * groups test mode cut off, and blocks whose rewrite was rejected — and the
 * rewritten string for the rest. `null` is not "the original text" written back;
 * it is NOT WRITING, which is why a heading comes out of this pass
 * byte-identical and an untouched paragraph keeps its inline <em>/<a>/<sup>.
 *
 * Progress and cancellation are the caller's: `beforeGroup` runs before each
 * group (throw from it to cancel), `afterGroup` after each one (throw from it —
 * as checkFallbackThreshold does — to abort the job).
 */
export async function simplifyChapterBlocks(opts: {
  xhtml: string;
  plan: ChapterBlockPlan;
  /**
   * Groups to process — a prefix of `plan.sendable` (test mode trims it). Every
   * one of them IS sent; an unsent group never reaches this function, so a
   * progress tick here always means a model call happened.
   */
  groups: SimplifyBlockGroup[];
  chapterTitle: string;
  call: SimplifyBlockCall;
  state: CleanupJobState;
  /** 1-based job-wide number of this chapter's first group. */
  firstGroupNumber: number;
  totalGroupsInJob: number;
  beforeGroup?: (groupNumber: number, charCount: number) => void | Promise<void>;
  afterGroup?: (groupNumber: number, charCount: number) => void | Promise<void>;
}): Promise<string> {
  const { xhtml, plan, groups, chapterTitle, call, state, firstGroupNumber, totalGroupsInJob } = opts;

  // One slot per block, all null: anything we never touch is never written.
  const texts: Array<string | null> = new Array(plan.blocks.length).fill(null);

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (!group.send) {
      // The caller filtered wrong. Sending it anyway would burn a call on three
      // words AND make the job's unit count disagree with the pre-scan's.
      throw new Error(
        `simplifyChapterBlocks: was handed an unsendable group (${group.chars} chars, under ${MIN_GROUP_SEND_CHARS}) — pass plan.sendable`
      );
    }
    const groupNumber = firstGroupNumber + g;
    const charCount = group.chars;

    if (opts.beforeGroup) await opts.beforeGroup(groupNumber, charCount);

    const finals = await simplifyBlockGroup(group, call, state, {
      chapterTitle,
      overallChunkNumber: groupNumber,
      totalChunks: totalGroupsInJob,
    });
    if (finals.length !== group.blocks.length) {
      // simplifyBlockGroup's contract, asserted rather than assumed: a short
      // array here would silently shift every later block's text.
      throw new Error(
        `simplifyChapterBlocks: group ${groupNumber} returned ${finals.length} texts for ${group.blocks.length} blocks`
      );
    }
    for (let k = 0; k < group.blocks.length; k++) {
      const ref = group.blocks[k];
      // A block whose rewrite was rejected comes back as its own original text;
      // leaving it null writes nothing at all, which is the truer expression of
      // "this pass did not change this block" (and keeps its inline markup).
      texts[ref.index] = finals[k] === ref.text ? null : finals[k];
    }

    if (opts.afterGroup) await opts.afterGroup(groupNumber, charCount);
  }

  return replaceBlockTextsExact(xhtml, texts);
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB OCR Cleanup (for queue processing)
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubCleanupProgress {
  jobId: string;
  phase: 'loading' | 'analyzing' | 'processing' | 'saving' | 'complete' | 'error';
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
 * Free the cleanup model's VRAM at JOB end — and since 2026-09-14 there is
 * nothing here for this file to free.
 *
 * It used to evict the Ollama model a finished job had left resident on THIS
 * machine's card, so a following TTS phase did not wait out a 5-minute
 * keep_alive on VRAM nothing was using. With the Ollama provider deleted, an
 * Ollama the user runs here is no longer anything an AI cleanup put there, so
 * evicting it is not this file's call to make. That eviction belongs to the
 * LEGACY TTS SPAWN PATH, which already does it for its own reasons and by its
 * own name — `parallel-tts-bridge.ts` calls `unloadOllamaModels()` before it
 * takes the card — and it goes when that layer goes (PHASE15 §6).
 *
 * Crucible is deliberately NOT unloaded either, and the symmetry is the point:
 * a cleanup run does not load a model on someone else's server, so it does not
 * unload one. Residency there is the operator's decision, and what keeps a
 * model on the card for the duration of a run is the LEASE (see cleanupEpub),
 * not anything this function could do. An unload behind the operator's back
 * would evict the model their next run is about to use, on a machine this job
 * does not own (`--crucible-unload` is the door).
 *
 * So the function is kept as the named place that answer lives, and it does
 * nothing.
 */
async function releaseCleanupModel(_config: AIProviderConfig): Promise<void> {
  return;
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
/**
 * ── ONE LEASE FOR A CLEANUP RUN ON A CRUCIBLE ──────────────────────────────
 *
 * Owen, 2026-09-14: *"Models should always be unloaded when we're done with
 * them. Every time."* A Crucible now unloads the resident model the moment
 * nothing holds it — no job on the lane, no lease, no streaming session, no chat
 * in flight (crucible `docs/PHASE7-LANES.md` §5.3).
 *
 * A cleanup run is the shape that ruling is dangerous for. It reaches the server
 * as HUNDREDS OF CHAT COMPLETIONS, one per chunk, and a chat deliberately holds
 * nothing there: between chunk 46 and chunk 47 the server is idle by every
 * measure it publishes, so it would unload a 19 GB model and reload it for the
 * next chunk. The lease is this app saying the one fact only it has — *I intend
 * more requests on this model* — and it is taken ONCE for the whole run, because
 * one per chunk would be the reload wearing a different hat.
 *
 * It is taken here, outside {@link cleanupEpubRun}, so that the release is in a
 * `finally` that every one of that function's exits passes through: the four
 * success returns, the refusals, the cancel, and the failure path. The run's own
 * body is unchanged and knows nothing about it.
 *
 * **Only the `crucible` provider leases, and only when a model will be called.**
 * The bundled local engine is this machine's own and holds its own card until
 * its idle timer or `cancelCleanupJob` stops it, so there is nobody to tell.
 * And a TTS-prep run with structural footnote proof makes no model calls at all
 * (`noModelNeeded`), so leasing for it would hold somebody's card for a run that
 * never speaks to them — which is why that fact is decided HERE and handed down
 * rather than recomputed inside.
 */
export async function cleanupEpub(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: EpubCleanupProgress) => void) | undefined,
  providerConfig: AIProviderConfig,
  options?: CleanupEpubOptions,
): Promise<EpubCleanupResult> {
  // Does the archived original carry <sup> footnote markup we can delete from
  // directly? Asked before anything is validated or leased, because the answer
  // decides whether this job needs a model AT ALL.
  const archiveHasProof = !!options?.structuralSourceEpub
    && await archiveHasStructuralMarkers(options.structuralSourceEpub);

  // A TTS-prep-only run over a book with structural proof never contacts the
  // CLEANUP PROVIDER: pass 1 does not run, and the one provider call pass 2 used to
  // need (the footnote observation) is gone. Pass 2 may still load the bundled
  // markers it can prove from markup, and nothing else — no model at all. Validating a provider this job will
  // never use turns an offline job into one that fails whenever the engine is
  // down — which is exactly what happened. Conditions mirror the edit-list path so a custom
  // prompt, detailed deletions or simplify still preflight normally.
  const noModelNeeded = archiveHasProof
    && options?.cleanupStages === 'tts'
    && !options?.simplifyForChildren
    && !options?.cleanupPrompt
    && !(options?.useDetailedCleanup && options?.deletedBlockExamples && options.deletedBlockExamples.length > 0);
  if (noModelNeeded) {
    console.log('[AI-BRIDGE] TTS prep with structural footnote proof — no model calls in this job, skipping provider preflight');
  }

  const run = (): Promise<EpubCleanupResult> =>
    cleanupEpubRun(epubPath, jobId, mainWindow, onProgress, providerConfig, options, noModelNeeded);

  if (providerConfig.provider !== 'crucible' || noModelNeeded) return run();

  // The server and the act by name, then the model READ from that server's
  // capability record, all BEFORE the lease — a lease has to say which model it
  // holds, and this app is not the thing that decides which one that is. Every
  // refusal on this road (`crucible_server_not_named`, `crucible_act_not_named`,
  // `crucible_capability_undecided`, `crucible_capability_disabled`,
  // `crucible_capability_no_model`) throws a message carrying its own code, and
  // this door reports it as a result rather than throwing where every caller
  // expects one. See stampCrucibleModelForRun.
  let named: { server: string; act: CrucibleTextAct; model: string };
  try {
    named = await stampCrucibleModelForRun(providerConfig);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  /*
   * AN UPSTREAM-ROUTED RUN TAKES NO LEASE, and the server would refuse one.
   *
   * crucible `docs/PHASE15-HOST.md` §3.4: a chat whose model is
   * `<upstream>/<model>` is forwarded to that service on the operator's
   * account — "no lease, no lane, the settlement untouched (nothing was on the
   * card)" — and `POST /v1/models/{id}/lease` naming one is refused
   * `lease_not_needed` with the sentence "an upstream model is never resident;
   * send the chat". So taking one here would be this app asking for a refusal
   * and then reporting it as a failure to clean a book.
   *
   * The discriminator is the contract's own and not a second opinion: a local
   * model id never contains a slash, checked where ids are minted
   * (`manifest_model_id_slash`). It is read through `isUpstreamModelId` so the
   * queue's lane decision and this one cannot come to disagree about what an
   * upstream model looks like.
   */
  if (isUpstreamModelId(named.model)) {
    console.log(`[AI-CLEANUP] ${named.server} forwards ${named.act} to ${named.model} — no lease, `
      + 'nothing of ours is on that card.');
    return run();
  }

  const { withCrucibleLease, CrucibleLeased } = await import('./crucible/lease.js');
  try {
    return await withCrucibleLease(
      {
        server: named.server,
        // `model` — a cleanup run's resident thing is the LLM on the card. The
        // kind is stated rather than assumed because a voice and an aligner
        // become leasable next (see CrucibleLeaseKind).
        kind: 'model',
        id: named.model,
        /*
         * The act the CALLER named, which is what goes on the bench beside the
         * card and into `X-Crucible-Act`. It is no longer hardcoded `clean`:
         * the act is a field on the config now, so a simplify run that says
         * `simplify` leases and labels itself `simplify`, and the capability
         * class the model was chosen from is the same one the lease records.
         * One name, read from one place — the lie Owen ruled out ("they can't
         * lie to the user and say a translate job is running when it's actually
         * a simplify job") has nowhere left to enter.
         */
        act: named.act,
        onLog: (line) => console.log(`[AI-CLEANUP] ${line}`),
      },
      run,
    );
  } catch (err) {
    // A 409 `leased` is a WAIT, not a crash: another client has said it is
    // mid-run on that model. Reported with the holder's own line, the way every
    // other refusal on this path is — the message carries a machine-readable code
    // at its head.
    if (err instanceof CrucibleLeased) {
      return {
        success: false,
        error: `crucible_model_leased: crucible "${named.server}" holds "${named.model}" for another `
          + `run — ${err.leasedLine}, until at least ${err.expiresAt}. Nothing here waits it out or `
          + 'cleans the book somewhere else; run it again when that run is done, or point this job '
          + 'at another server.',
      };
    }
    /*
     * Every other failure of the TAKE — unreachable, wrong token, a model that
     * went between the preflight and the lease — is REPORTED, not thrown, because
     * that is how this function reports and `cleanupEpubRun` itself never throws
     * past its own catch. A throw here would reach callers that have only ever
     * had to read a result. `translateCrucibleError` keeps the server's own code
     * at the head of the sentence.
     */
    const translated = translateCrucibleError(err, named.server);
    if (translated instanceof Error) return { success: false, error: translated.message };
    throw translated;
  }
}

/** Everything {@link cleanupEpub} takes beyond the five it must have. */
type CleanupEpubOptions = {
    deletedBlockExamples?: DeletedBlockExample[];
    useDetailedCleanup?: boolean;
    useParallel?: boolean;
    parallelWorkers?: number;
    testMode?: boolean;
    testModeChunks?: number;  // Number of chunks to process in test mode
    enableAiCleanup?: boolean;  // Standard OCR/formatting cleanup (default: true)
    // Which cleanup stages to run. REQUIRED whenever the edit-list path is taken;
    // there is no default, because the wrong answers are expensive in opposite
    // directions (a full model pass wasted on a born-digital EPUB, or scanner damage
    // left in a scan). See CleanupStages.
    cleanupStages?: CleanupStages;
    /**
     * The project's ARCHIVED ORIGINAL epub, when it has one. Read-only, and only in
     * pass 2: it still carries the publisher's <sup> footnote markup that
     * exported.epub flattened into bare digits, so it is the proof that lets the
     * TTS-prep pass delete markers instead of inferring them. Absent (PDF-derived
     * projects, or no archive) simply means the inferred pipeline runs as before.
     */
    structuralSourceEpub?: string;
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
};

/**
 * The cleanup run itself, unchanged. Called only by {@link cleanupEpub}, which
 * is the door that holds the Crucible lease around it.
 *
 * `noModelNeeded` arrives rather than being worked out here: it is the fact that
 * decides whether this run speaks to a model at all, and the lease has to know it
 * BEFORE the run starts. One owner, one answer.
 */
async function cleanupEpubRun(
  epubPath: string,
  jobId: string,
  mainWindow: BrowserWindow | null | undefined,
  onProgress: ((progress: EpubCleanupProgress) => void) | undefined,
  providerConfig: AIProviderConfig,
  options: CleanupEpubOptions | undefined,
  noModelNeeded: boolean,
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
    localModel: providerConfig.local?.model,
    crucibleServer: providerConfig.crucible?.server,
    crucibleAct: providerConfig.crucible?.act,
    crucibleModel: providerConfig.crucible?.model,
    useDetailedCleanup: options?.useDetailedCleanup,
    exampleCount: options?.deletedBlockExamples?.length || 0,
    useParallel: options?.useParallel,
    parallelWorkers: options?.parallelWorkers,
    testMode
  });

  // Prevent system sleep during cleanup
  startAIPowerBlock();

  // Per-job fallback/skip accounting — owned by THIS call so it can run
  // concurrently with another cleanup job (e.g. one whose class the engine
  // forwards to an upstream, in the `[cloud]` lane, beside one on a GPU slot)
  // without cross-contaminating counters or skips.
  const jobState = newCleanupJobState();

  // providerConfig is required - no fallbacks
  const config = providerConfig;

  // `noModelNeeded` — whether this job speaks to a model at all — is decided by
  // `cleanupEpub` above and handed down, because the Crucible lease has to know
  // it before this run begins. See that function's header.

  // Validate provider configuration
  if (noModelNeeded) {
    // nothing to validate — no provider will be contacted
  } else if (config.provider === 'crucible') {
    // The server, the act and the model the SERVER chose — read and stamped by
    // `cleanupEpub` before it took the lease, because a lease has to name what
    // it holds. This reads that back (refusing by name if it somehow did not
    // happen) and then spends the ONE residency round trip this job makes.
    // Failing here costs a second and names the fix; failing at chunk 47 costs an
    // hour and names nothing. A refusal is returned, not thrown, because that is
    // how this function reports — the message carries the machine-readable code
    // (crucible_model_not_resident, …) at its head.
    let crucible: { server: string; act: CrucibleTextAct; model: string };
    try {
      crucible = crucibleRunTargetOf(config);
    } catch (err) {
      stopAIPowerBlock();
      return { success: false, error: (err as Error).message };
    }
    try {
      await assertCrucibleModelResident(crucible.server, crucible.model);
    } catch (err) {
      stopAIPowerBlock();
      // The registry's refusals (unknown server), this file's named refusals and
      // the SDK's translated ones all arrive as Errors carrying their own cause.
      // Anything that is not an Error is not a refusal — it keeps its stack.
      if (!(err instanceof Error)) throw err;
      return { success: false, error: err.message };
    }
    console.log(`[AI-BRIDGE] Crucible preflight passed — "${crucible.server}" serves the ${crucible.act} `
      + `class with ${crucible.model}, and it is resident`);
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
    return { success: false, error: `unknown_ai_provider: ${String(config.provider)}` };
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
  activeCleanupJobs.set(jobId, {
    controller: abortController,
    provider: config.provider,
  });
  console.log(`[AI-BRIDGE] Job ${jobId} registered for cancellation support`);

  const sendProgress = (progress: EpubCleanupProgress) => {
    // Console log for visibility in terminal
    const chunkInfo = progress.chunkCompletedAt ? ` [completed @ ${new Date(progress.chunkCompletedAt).toLocaleTimeString()}]` : '';
    console.log(`[AI-CLEANUP] [${jobId.substring(0, 8)}] ${progress.phase.toUpperCase()} - Chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.percentage}%) - ${progress.message || ''}${chunkInfo}`);

    if (onProgress) onProgress(progress);
    // Main hears it too: the simplify PASS is scheduled by the queue engine in
    // this process, and a webContents.send cannot be heard here. Same channel,
    // same payload, so the renderer is unaffected. See electron/bridge-events.ts.
    publishBridgeEvent('queue:progress', {
      jobId,
      phase: progress.phase,
      progress: progress.percentage,
      message: progress.message,
      currentChunk: progress.currentChunk,
      totalChunks: progress.totalChunks,
      currentChapter: progress.currentChapter,
      totalChapters: progress.totalChapters,
      outputPath: progress.outputPath,
      chunksCompletedInJob: progress.chunksCompletedInJob,
      totalChunksInJob: progress.totalChunksInJob,
      chunkCompletedAt: progress.chunkCompletedAt,
    });
    if (mainWindow) {
      mainWindow.webContents.send('queue:progress', {
        jobId,
        // No `type`: the row is found by jobId, and cleanupEpub runs for two job
        // types (the simplify pass and bilingual-cleanup). Naming one of them
        // here would be a label that is wrong half the time.
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
  // The footnote plan derived in pass 1, persisted so pass 2 (TTS prep) is
  // reproducible from the report; and the pass-2 outcome itself (set after pass 2).
  let footnotePlanOut: FootnotePlanReport | undefined;
  let ttsPrepReportOut: TtsPrepReport | undefined;
  // Recompute the report dir the same way the success/skip writers do.
  const reportDir = options?.outputDir || path.dirname(epubPath);
  const persistCleanupReports = async () => {
    try {
      if (jobState.editLog.length > 0) {
        await fsPromises.writeFile(path.join(reportDir, 'edit-log.json'), JSON.stringify(jobState.editLog, null, 2), 'utf-8');
        console.log(`[AI-CLEANUP] Wrote edit-log.json (${jobState.editLog.length} edits)`);
      }
      if (footnoteReportOut || hyphenReportOut || footnotePlanOut || ttsPrepReportOut) {
        await fsPromises.writeFile(
          path.join(reportDir, 'cleanup-prepass-report.json'),
          JSON.stringify({ footnote: footnoteReportOut, hyphen: hyphenReportOut, footnotePlan: footnotePlanOut, ttsPrep: ttsPrepReportOut }, null, 2),
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

    // SIMPLIFY-ONLY runs the block-group pipeline instead of prose chunking:
    // groups of up to MAX_BLOCKS_PER_GROUP consecutive body blocks, tagged and
    // validated per block, written back 1:1. The LEGACY combined cleanup+simplify
    // mode keeps the chunk pipeline (its prompt does two jobs at once and its
    // output is a rewritten chunk, not a block list), as do plain cleanup,
    // translate and bilingual.
    const simplifyBlockMode = simplifyForChildren && !enableAiCleanup;
    if (simplifyBlockMode) console.log('[AI-BRIDGE] Simplify: BLOCK-GROUP mode (1:1 block rewrites, no prose chunking)');

    // Detailed cleanup (user-marked block deletions) needs a DELETING rewrite, which
    // the edit-list applier structurally forbids — so it keeps the legacy full-rewrite
    // path. Everything else in the pure-cleanup task uses the new edit-list pipeline.
    const hasDeletionExamples = !!(options?.useDetailedCleanup && options.deletedBlockExamples && options.deletedBlockExamples.length > 0);
    // The edit-list redesign applies to the pure cleanup task only: not simplify,
    // not a custom rewrite prompt, not detailed-cleanup deletions.
    const useEditList = task === 'cleanup' && !options?.cleanupPrompt && !hasDeletionExamples;

    // OCR repair (pass 1) and TTS prep (pass 2) are separate jobs the user chooses
    // between, not one indivisible step. The caller MUST state which it wants — no
    // default — so a UI or CLI that forgets to send it fails loudly instead of
    // silently spending hours of model time repairing scanner damage an EPUB never had.
    if (useEditList && !CLEANUP_STAGES.includes(options?.cleanupStages as CleanupStages)) {
      throw new Error(
        `cleanupEpub: options.cleanupStages is required for the edit-list cleanup path — ` +
        `one of ${CLEANUP_STAGES.join(' | ')} (got ${JSON.stringify(options?.cleanupStages)}). ` +
        `'ocr' = repair scanner damage only (writes repaired.epub); 'tts' = footnote/quote/number ` +
        `prep only (writes cleaned.epub); 'both' = repair then prep.`
      );
    }
    const stages: CleanupStages | null = useEditList ? options!.cleanupStages! : null;
    const runOcrRepair = stages === 'ocr' || stages === 'both';
    const runTtsPrep = stages === 'tts' || stages === 'both';

    // Footnote-marker removal in TTS prep is PROOF-ONLY (Aug 2026): it deletes the
    // markers the source EPUB's own <sup> markup names, and nothing else. The 0.6B
    // model that used to infer them from prose shape is retired, and BookForge no
    // longer runs a footnote model itself — that work is the foundry `footnotes`
    // pass, which runs foundry-footnotes-v1-4b over the whole book. So this stage
    // needs no model, no download and no preflight, and it never guesses.

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
      // The block path asks for a tagged block list instead of a slab of prose —
      // the answer's SHAPE is what makes it writable back onto the source
      // elements without re-segmenting anything.
      systemPrompt =
        `${THINKING_TRIGGER}\n\n${systemPrompt}\n\n` +
        (simplifyBlockMode
          ? simplifyBlockOutputFormat()
          : 'OUTPUT FORMAT (this overrides any earlier instruction about how to output): ' +
            'First think through the rewrite. Then write your COMPLETE rewritten text — every ' +
            'paragraph, start to finish — inside a single <answer> ... </answer> block, and put ' +
            'nothing after </answer>. If the input is empty or unreadable, put exactly [SKIP] ' +
            'inside the answer block.');
      console.log(`[AI-BRIDGE] Simplify: thinking enabled, output wrapped in <answer> tags (${simplifyBlockMode ? 'block list' : 'prose'})`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PASS 1 planning (edit-list cleanup only) — OCR repair. The pre-model
    // `preprocess` for pass 1 does LINE-BREAK HYPHEN JOINS ONLY (those ARE OCR
    // repair). Footnote-marker removal and quote normalization are DEFERRED to
    // pass 2 (TTS prep) so the model sees, and never touches, footnote reference
    // numbers and un-normalized curly quotes. The footnote plan is still DERIVED
    // here (the model is already loaded) but only recorded; pass 2 applies it.
    // With OCR repair OFF the hyphen half is skipped entirely (line-break
    // hyphenation is a scanner artifact); only the footnote observation runs,
    // because pass 2 needs its plan whether or not pass 1 does.
    // `preprocess` is threaded identically into chunkChapterProse AND
    // rebuildChapterPreservingHeadings so their chunk layouts stay identical.
    // ─────────────────────────────────────────────────────────────────────────
    let preprocessFor: ((chapterXhtml: string) => (proseText: string) => string) | undefined;
    let footnotePlan: { regex: RegExp; observation: FootnoteObservation } | null = null;
    if (useEditList) {
      // Gather across the whole book: the best OBSERVATION chapter for footnotes,
      // and every unique hyphen-split pair (hyphen arbitration). The observation
      // chapter is the one with the most deterministic digit-marker CANDIDATES —
      // observing the first chapter regardless (Killing America: an intro with no
      // markers) makes the model correctly report has_markers=false and the whole
      // book keeps its markers. Falls back to the first substantial chapter.
      const hyphenPairSet = new Set<string>();
      // Corpus attestation for the hyphen PROOF, accumulated on the same single pass
      // over the book that collects the pairs (no second read).
      const hyphenAtt = createHyphenAttestation();
      for (const chapter of chapters) {
        const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
        let xhtml: string;
        try { xhtml = await processor.readFile(href); } catch { continue; }
        const text = extractChapterAsText(xhtml);
        if (!text.trim()) continue;
        if (runOcrRepair) {
          for (const p of extractHyphenPairs(text)) hyphenPairSet.add(p);
          addTextToHyphenAttestation(hyphenAtt, text);
        }
        // PARKED: picking an observation chapter by digit-marker candidate density.
        // Only the (now parked) observation call below consumed it.
        // if (text.length >= 2000) {
        //   if (!firstSubstantialText) firstSubstantialText = text;
        //   const cand = scoreFootnoteCandidates(text);
        //   if (cand > bestCandidates) { bestCandidates = cand; footnoteChapterText = text; }
        // }
      }

      // ── PARKED: the footnote OBSERVATION model call ──────────────────────────
      // This asked the cleanup provider to describe a book's marker convention
      // (arabic/symbol, spacing, what follows) so pass 2 could compose a regex from
      // it. Pass 2 no longer composes a pattern at all: it deletes only the markers
      // the source EPUB's own <sup> markup proves — see the matching PARKED block in
      // ttsPrepChapter, which is where the plan was applied. There is nothing left to
      // consume a plan, so the call is pure cost.
      //
      // WHAT WOULD JUSTIFY REVIVING IT: only reviving the shape-based path it feeds.
      // Uncomment this, the candidate-density scan above, and the ttsPrepChapter
      // block together — one without the others is a plan nobody applies.
      //
      // let footnoteRegex: RegExp | null = null;
      // let footnoteObservation: FootnoteObservation | undefined;
      // const structuralAvailable = runTtsPrep && archiveHasProof;
      // if (!runTtsPrep) { … } else if (structuralAvailable) { … }
      // else if (footnoteChapterText) {
      //   sendProgress({ jobId, phase: 'analyzing', currentChapter: 0, totalChapters: chapters.length, currentChunk: 0, totalChunks: 0, percentage: 0, message: 'Analyzing footnote markers…' });
      //   const fn = await planFootnoteRemoval(footnoteChapterText, config, 0.3, abortController.signal);
      //   footnoteRegex = fn.regex;
      //   footnoteObservation = fn.report.observation;
      //   footnoteReportOut = fn.report;
      //   if (footnoteRegex && footnoteObservation) {
      //     footnotePlan = { regex: footnoteRegex, observation: footnoteObservation };
      //     footnotePlanOut = { regexSource: footnoteRegex.source, flags: footnoteRegex.flags, observation: footnoteObservation };
      //   }
      //   console.log(`[AI-CLEANUP] Footnote pre-pass: ${fn.report.status} — ${fn.report.reason}`);
      // } else { … }
      footnoteReportOut = runTtsPrep
        ? {
            status: 'not-needed',
            reason: 'pass 2 removes only the footnote markers the source EPUB\'s own <sup> '
              + 'markup proves — no book-wide observation is derived and no marker is inferred '
              + '(see cleanup-prepass-report.json → ttsPrep). Markers a book does not mark up '
              + 'are the foundry `footnotes` pass\'s job.',
          }
        : { status: 'not-needed', reason: 'OCR repair only — no TTS-prep pass to remove footnote markers' };
      console.log(`[AI-CLEANUP] Footnote pre-pass: skipped (${runTtsPrep ? 'pass 2 removes structurally-proven markers only' : 'OCR repair only'})`);

      // Hyphen joins: CORPUS PROOF first (deterministic, overrides the model — the
      // model votes 'hyphen' on obvious OCR splits like `ques-tion`), model
      // arbitration only for the pairs the book itself cannot settle. OCR repair
      // only: a line-break hyphen split is scanner damage, so with pass 1 off no
      // pairs were collected and there is nothing to arbitrate.
      const hyphenVerdicts = new Map<string, HyphenVerdict>();
      if (runOcrRepair) {
        const hyphenPairs = [...hyphenPairSet];
        const unprovenPairs: string[] = [];
        let provenJoin = 0, provenHyphen = 0;
        for (const pair of hyphenPairs) {
          // extractHyphenPairs keys are `${alpha}-${alpha}` — exactly one hyphen. A
          // malformed key would silently mis-prove, so it must break the run.
          const parts = pair.split('-');
          if (parts.length !== 2) throw new Error(`Malformed hyphen pair key from extractHyphenPairs: ${pair}`);
          const proven = proveHyphenVerdict(parts[0], parts[1], hyphenAtt);
          if (!proven) { unprovenPairs.push(pair); continue; }
          hyphenVerdicts.set(pair, proven);
          if (proven === 'join') provenJoin++; else provenHyphen++;
        }
        let modelDegraded: string[] = [];
        if (unprovenPairs.length > 0) {
          const hj = await planHyphenJoins(unprovenPairs, config, abortController.signal,
            (done, total) => sendProgress({ jobId, phase: 'analyzing', currentChapter: 0, totalChapters: chapters.length, currentChunk: done, totalChunks: total, percentage: 0, message: `Resolving hyphenation — batch ${done}/${total}` }));
          for (const [pair, verdict] of hj.verdicts) hyphenVerdicts.set(pair, verdict);
          modelDegraded = hj.unresolved;
        }
        // Report from the MERGED map, over the unique pairs only (the model can echo a
        // pair we never asked about; such a key never matches any split).
        let mergedJoin = 0, mergedHyphen = 0;
        for (const pair of hyphenPairs) {
          const verdict = hyphenVerdicts.get(pair);
          if (verdict === 'join') mergedJoin++;
          else if (verdict === 'hyphen') mergedHyphen++;
        }
        hyphenReportOut = {
          totalPairs: hyphenPairs.length,
          join: mergedJoin,
          hyphen: mergedHyphen,
          unresolved: modelDegraded.length,
          degradedPairs: modelDegraded,
          provenJoin,
          provenHyphen,
          modelAdjudicated: unprovenPairs.length - modelDegraded.length,
        };
        if (hyphenPairs.length === 0) {
          console.log('[AI-CLEANUP] Hyphen pre-pass: no line-break hyphen splits found');
        } else {
          console.log(`[AI-CLEANUP] Hyphen pre-pass: ${hyphenPairs.length} pairs — proven join=${provenJoin} hyphen=${provenHyphen} | model join=${mergedJoin - provenJoin} hyphen=${mergedHyphen - provenHyphen} unresolved=${modelDegraded.length}`);
        }
      } else {
        console.log('[AI-CLEANUP] Hyphen pre-pass: skipped (OCR repair off)');
      }

      // Pass-1 (OCR repair) preprocess = LINE-BREAK HYPHEN JOINS ONLY, applied
      // unconditionally to every prose segment. Footnote-marker removal and quote
      // normalization are NOT here — they run in pass 2 (see ttsPrepChapter), where
      // the deferred footnotePlan is applied with the same chain-selection machinery
      // (selectFootnoteDeletions → allowedValues) that used to live in this closure.
      // Chapter-independent, so the chapterXhtml argument is unused; keeping the
      // signature identical still threads it into both chunkChapterProse and
      // rebuildChapterPreservingHeadings so their chunk layouts stay identical.
      if (runOcrRepair) {
        preprocessFor = (_chapterXhtml: string) => (proseText: string) => applyHyphenJoins(proseText, hyphenVerdicts).text;
      }
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
    // Edit-list cleanup runs in two passes: pass 1 (OCR repair) writes repaired.epub
    // (this outputPath, what the checkpoint + pass-1 diff cache track); pass 2 (TTS
    // prep) turns that into cleaned.epub below. With OCR repair OFF there is no pass 1,
    // so there is no repaired.epub and the job's only output is cleaned.epub. Simplify
    // and the legacy full-rewrite cleanup path (custom prompt / detailed deletions) are
    // single-pass and write their final artifact directly, unchanged.
    const outputFilename = options?.simplifyForChildren ? 'simplified.epub' : (runOcrRepair ? 'repaired.epub' : 'cleaned.epub');
    // 'ocr' stops after pass 1, so repaired.epub IS the deliverable, not an intermediate.
    const outputPath = path.join(epubDir, outputFilename);

    // ─────────────────────────────────────────────────────────────────────────
    // TTS-PREP-ONLY JOB (edit-list cleanup with OCR repair turned off).
    // With pass 1 off the whole job is pass 2 run straight over the source EPUB:
    // footnote-marker removal, quote normalization, number expansion. Minutes at
    // most — no model runs in it at all, only deterministic transforms over the
    // markup's own markers. There is no chunk loop, so no
    // checkpoint and no pass-1 diff cache; cleaned.diff.json
    // is still the original → cleaned diff the editor reads.
    // ─────────────────────────────────────────────────────────────────────────
    if (stages === 'tts') {
      // Without pass 1 the source EPUB is read directly and cleaned.epub is written
      // directly, so picking cleaned.epub AS the source aims both at one file — and
      // the writer would overwrite a path two open ZipReaders still hold. Reachable
      // in one click (the wizard offers "AI Cleaned" as a cleanup source, and the app
      // pins the output dir to stages/01-cleanup), so it must fail with a message
      // that says what to pick instead, not a Windows EPERM.
      const samePath = (a: string, b: string) => {
        const [ra, rb] = [path.resolve(a), path.resolve(b)];
        return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
      };
      if (samePath(epubPath, outputPath)) {
        throw new Error(
          `TTS prep would overwrite its own source (${outputPath}). Pick a different source ` +
          'EPUB — Original or Exported — or turn OCR repair on so pass 1 writes repaired.epub first.'
        );
      }

      // A repaired.epub left by an EARLIER OCR-repair run is not an input to this
      // job and must not survive it — the Versions tab would otherwise offer a stale
      // artifact that disagrees with the cleaned.epub written below. Same for the
      // pass-1 checkpoint and the previous run's skipped-chunks report.
      //
      // UNLESS it is the source: re-running TTS prep over the already-repaired text
      // is the whole point of offering "OCR-Repaired" in the source picker, and
      // deleting the file we are about to read would turn that into an ENOENT.
      const stalePass1 = path.join(epubDir, 'repaired.epub');
      if (!samePath(epubPath, stalePass1)) {
        try { await fsPromises.unlink(stalePass1); } catch { /* not present */ }
        await clearDiffCache(stalePass1);
      }
      await deleteCheckpoint(epubDir);
      try { await fsPromises.unlink(path.join(epubDir, 'skipped-chunks.json')); } catch { /* not present */ }

      sendProgress({
        jobId, phase: 'saving', currentChapter: 0, totalChapters,
        currentChunk: 0, totalChunks: 0, percentage: 50,
        message: 'TTS prep: footnotes, quotes, numbers...'
      });

      const ttsPrep = await runTtsPrepPass(
        epubPath, epubPath, outputPath, footnotePlan, jobChunkSize, options?.structuralSourceEpub,
        (chapter, chapters, done, total) => sendProgress({
          jobId, phase: 'analyzing', currentChapter: chapter, totalChapters: chapters,
          currentChunk: done, totalChunks: total,
          percentage: chapters > 0 ? Math.round((chapter - 1) / chapters * 100) : 0,
          message: `Finding footnote markers — chapter ${chapter}/${chapters}`
        }),
        abortController.signal
      );
      ttsPrepReportOut = ttsPrep.report;
      console.log(
        `[AI-CLEANUP] TTS prep only (OCR repair off): ${ttsPrep.report.chaptersTransformed} chapters — ` +
        `${ttsPrep.report.totalFootnoteDeletions} footnote markers removed, ` +
        `${ttsPrep.report.totalQuoteNorm} quote glyphs normalized, ` +
        `${ttsPrep.report.totalNumbersExpanded} numbers expanded → cleaned.epub` +
        (ttsPrep.report.totalMarkerShapedLeft
          ? ` | WARNING: ${ttsPrep.report.totalMarkerShapedLeft} reference-marker-shaped numbers were NOT removed (left as digits, see cleanup-prepass-report.json)`
          : '')
      );

      processor.close();
      activeCleanupJobs.delete(jobId);
      await persistCleanupReports();
      stopAIPowerBlock();
      // The footnote observation call loaded the model; hand the VRAM back rather
      // than letting it idle out its keep_alive window. Skipped when structural
      // proof meant no model was ever loaded — there is nothing to release, and
      // asking a wedged provider to unload would only log a confusing warning.
      if (!noModelNeeded) await releaseCleanupModel(config);

      sendProgress({
        jobId, phase: 'complete', currentChapter: totalChapters, totalChapters,
        currentChunk: 0, totalChunks: 0, percentage: 100,
        message: 'TTS prep complete'
      });

      const durationSeconds = Math.round((Date.now() - cleanupStartTime) / 1000);
      return {
        success: true,
        outputPath,
        chaptersProcessed: ttsPrep.report.chaptersTransformed,
        copyrightIssuesDetected: false,
        copyrightChunksAffected: 0,
        contentSkipsDetected: false,
        contentSkipsAffected: 0,
        markerMismatchDetected: false,
        markerMismatchAffected: 0,
        truncatedDetected: false,
        truncatedAffected: 0,
        analytics: {
          jobId,
          startedAt: new Date(cleanupStartTime).toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds,
          totalChapters,
          // No model chunks were processed — this pass is deterministic.
          totalChunks: 0,
          totalCharacters: 0,
          chunksPerMinute: 0,
          charactersPerMinute: 0,
          model: 'none (deterministic TTS prep)',
          success: true,
          chaptersProcessed: ttsPrep.report.chaptersTransformed,
          copyrightChunksAffected: 0,
          contentSkipsAffected: 0,
          markerMismatchAffected: 0,
          truncatedChunksAffected: 0
        }
      };
    }

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

      // Edit-list path: also clear a stale pass-2 artifact (cleaned.epub +
      // cleaned.diff.json) from a prior run so a failure during pass 1 can never
      // leave a cleaned.epub that disagrees with the repaired.epub being rebuilt.
      if (runOcrRepair) {
        const stalePath = path.join(epubDir, 'cleaned.epub');
        try { await fsPromises.unlink(stalePath); } catch { /* not present */ }
        await clearDiffCache(stalePath);
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

    /**
     * Block-path counterpart of loadChapterChunks: the chapter's blocks plus the
     * groups packed out of them. `jobChunkSize` is a chunk-era knob and has NO
     * effect here — group size is MAX_BLOCKS_PER_GROUP / GROUP_CHAR_CAP, because
     * a group is a whole number of blocks, never a character budget cut through
     * one. `plan.sendable` is the work; `plan.groups` is every run, including the
     * short ones that are kept verbatim.
     */
    const loadChapterBlockGroups = async (
      proc: InstanceType<typeof import('./epub-processor.js').EpubProcessor>,
      href: string
    ): Promise<{ xhtml: string; plan: ChapterBlockPlan } | null> => {
      let xhtml: string;
      try {
        xhtml = await proc.readFile(href);
      } catch {
        return null;
      }
      const chapterText = extractChapterAsText(xhtml);
      if (!chapterText.trim()) return null;
      return { xhtml, plan: planChapterBlockGroups(xhtml) };
    };

    sendProgress({ jobId, phase: 'analyzing', currentChapter: 0, totalChapters: chapters.length, currentChunk: 0, totalChunks: 0, percentage: 0, message: 'Scanning chapters…' });
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

      if (simplifyBlockMode) {
        // Count SENDABLE groups. Headings form no group at all, and a group whose
        // whole text is a title page's three short lines is kept verbatim without
        // a call — so such a chapter contributes zero units, instead of one doomed
        // chunk per line. The largest group's SERIALIZED payload is what sizes
        // num_ctx: the tags are part of what the model has to read.
        const { sendable } = planChapterBlockGroups(xhtml);
        if (sendable.length > 0) {
          for (const group of sendable) {
            const payload = serializeBlocksForModel(group.blocks.map(b => b.text));
            if (payload.length > longestChunkText.length) longestChunkText = payload;
          }
          chapterMetas.push({ chapter, chunkCount: sendable.length, href });
          totalChunksInJob += sendable.length;
        }
        continue;
      }

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

    console.log(`[AI-CLEANUP] Total ${simplifyBlockMode ? 'block groups' : 'chunks'} in job: ${totalChunksInJob} across ${chapterMetas.length} non-empty chapters`);

    // Pin num_ctx for the ENTIRE job, sized to the largest chunk: one constant,
    // computed once, every smaller chunk fitting inside it, GPU-capped by
    // estimateNumCtx (numCtxMaxForModel). NEITHER remaining provider reads it —
    // a Crucible engine's context is fixed in the manifest at load and the
    // bundled local engine's at startup — so DEFAULT_MODEL here is a SIZE the
    // ceiling is derived from and not a model anything runs. The number is still
    // computed because the chunk layout that depends on it is real.
    const cleanupModel = DEFAULT_MODEL;
    // Edit-list chunks generate a FIXED num_predict budget (EDITLIST_NUM_PREDICT,
    // mostly in-band thinking) on top of prompt+input — the rewrite-era input*2
    // estimate would pin a ~4k window and strangle the thinking into
    // REASONING_OVERRUNs (the probes ran at 16k). Budget-size it instead, with
    // headroom for the per-chunk few-shot block that cleanChunkEditList appends (not
    // part of systemPrompt here). MUST use the same constant as the call itself.
    // Simplify keeps the rewrite estimate but at 3x: its output is input-sized AND
    // now carries in-band thinking on top.
    // Block groups also generate against a FLOORED budget (thinking + the rewrite,
    // never below SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR), so they need the same
    // budget-sized window as the edit-list path: sized to the LARGEST group's
    // payload and ITS num_predict, so the window is never smaller than the budget
    // it must hold.
    const EDITLIST_FEWSHOT_HEADROOM = ' '.repeat(2000);
    const jobNumCtx = useEditList
      ? estimateNumCtxForBudget(systemPrompt + EDITLIST_FEWSHOT_HEADROOM, longestChunkText, EDITLIST_NUM_PREDICT, cleanupModel)
      : simplifyBlockMode
        ? estimateNumCtxForBudget(systemPrompt, longestChunkText, simplifyBlockNumPredict(longestChunkText), cleanupModel)
        : estimateNumCtx(systemPrompt, longestChunkText, task === 'simplify' ? 3 : 2, cleanupModel);
    console.log(`[AI-CLEANUP] Pinned num_ctx=${jobNumCtx} for the job (largest ${simplifyBlockMode ? 'group payload' : 'chunk'} ${longestChunkText.length} chars) — model loads once, no per-chunk reloads`);

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

    // Scale the abort threshold to the job. An absolute 10 is a sane floor for a
    // 20-chunk job and nonsense for a 300-group one: it aborted a 308-unit book
    // at ~3% fallbacks. 5% (never below 10) still stops a job whose model has
    // genuinely stopped working, without killing one that lost a few paragraphs.
    // Every other path keeps the flat MAX_FALLBACK_COUNT it was written against.
    if (simplifyBlockMode) {
      jobState.maxFallbackCount = Math.max(MAX_FALLBACK_COUNT, Math.ceil(totalChunksInJob * 0.05));
      console.log(`[AI-CLEANUP] Fallback abort threshold: ${jobState.maxFallbackCount} of ${totalChunksInJob} block groups (5%, floor ${MAX_FALLBACK_COUNT})`);
    }

    // One entry point for cleaning a single chunk, so the parallel and sequential
    // loops share the branch: edit-list cleanup vs the legacy full-rewrite provider
    // path (simplify, custom prompt, detailed-cleanup deletions).
    const processOneChunk = (text: string, chunkMeta: ChunkMeta): Promise<string> =>
      useEditList
        ? cleanChunkEditList(text, editListPrompt, options?.customInstructions, config, jobState, jobNumCtx, jobTemperature, 3, abortController.signal, chunkMeta)
        : cleanChunkWithProvider(text, systemPrompt, task, config, jobState, jobNumCtx, jobTemperature, 3, abortController.signal, chunkMeta);

    // The block path's single model seam (unused off that path). Bound once so
    // every group and every degraded single-block call in the job shares the
    // pinned window, the temperature and the abort signal.
    const simplifyBlockCall = makeSimplifyBlockCall(systemPrompt, config, jobNumCtx, jobTemperature, 3, abortController.signal);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Process all chunks (parallel or sequential)
    // ─────────────────────────────────────────────────────────────────────────
    // BOTH remaining providers are single-stream, so this gate is currently
    // never open, and the test is written per-provider rather than collapsed to
    // `false` because the reason is a property of each one and not of the loop.
    // Local is a single llama-server. Crucible serves ONE resident model from one
    // engine process (PHASE2-LLM.md section 3), so N workers would not be N GPUs;
    // they would be N requests queued at the same engine, with N times the peak KV
    // — and where its engine forwards the class to an upstream instead, the
    // concurrency that would buy anything belongs to the ENGINE's own fan-out,
    // not to N sockets opened from here.
    // The block path is sequential-only regardless: the parallel loop is built on
    // prose chunks and finishes chapters with rebuildChapterPreservingHeadings, so
    // letting a simplify job in there would quietly put it back on the chunk
    // pipeline. Parallel block mode is future work, not a silent fallback.
    const useParallel = options?.useParallel && config.provider !== 'local' && config.provider !== 'crucible' && !simplifyBlockMode;
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
                  version: CLEANUP_CHECKPOINT_VERSION,
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

      /**
       * Persist everything a finished chapter owes: the output EPUB, the freed
       * memory, and the resume checkpoint. Shared verbatim by the chunk path and
       * the block path so a job resumed from either lands in the same state.
       */
      const saveChapterBoundary = async (chapterIndex: number, chapterId: string): Promise<void> => {
        // Save at chapter boundary only
        try {
          await saveModifiedEpubLocal(processor!, modifiedChapters, outputPath, completedChapterIds);

          // Free memory — chapter data is now on disk
          modifiedChapters.delete(chapterId);
          chapterXhtmlMap.delete(chapterId);

          if (global.gc) global.gc();
        } catch (saveError) {
          console.error(`Failed to save after chapter ${chapterIndex + 1}:`, saveError);
        }

        // Save checkpoint (skip in test mode)
        if (!testMode) {
          await saveCheckpoint(epubDir, {
            version: CLEANUP_CHECKPOINT_VERSION,
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
      };

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

        // ── Block path: groups of blocks, written back 1:1 ───────────────────
        if (simplifyBlockMode) {
          const loadedBlocks = await loadChapterBlockGroups(processor, meta.href);
          if (!loadedBlocks) continue;

          // In test mode, chunkCount (= sendable-group count) may be limited.
          // Groups the limit cuts off — and the short ones that were never
          // sendable — are simply never sent, and their blocks stay null in the
          // writer: untouched, not "processed and unchanged".
          const chapterGroups = loadedBlocks.plan.sendable.slice(0, meta.chunkCount);
          chapterXhtmlMap.set(chapter.id, loadedBlocks.xhtml);

          let groupStartTime = 0;
          let rebuiltXhtml: string;
          try {
            rebuiltXhtml = await simplifyChapterBlocks({
              xhtml: loadedBlocks.xhtml,
              plan: loadedBlocks.plan,
              groups: chapterGroups,
              chapterTitle: chapter.title,
              call: simplifyBlockCall,
              state: jobState,
              firstGroupNumber: chunksCompletedInJob + 1,
              totalGroupsInJob: totalChunksInJob,
              beforeGroup: (groupNumber, charCount) => {
                if (abortController.signal.aborted) {
                  console.log(`[AI-CLEANUP] Job ${jobId} cancelled before group ${groupNumber} of chapter ${i + 1}`);
                  throw new Error('Job cancelled');
                }
                groupStartTime = Date.now();
                totalCharactersProcessed += charCount;
                console.log(`[AI-CLEANUP] Starting group ${groupNumber}/${totalChunksInJob} - "${chapter.title}" (${charCount} chars)`);
                sendProgress({
                  jobId,
                  phase: 'processing',
                  currentChapter: i + 1,
                  totalChapters: chapterMetas.length,
                  currentChunk: groupNumber,
                  totalChunks: totalChunksInJob,
                  percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
                  message: `Processing chunk ${groupNumber}/${totalChunksInJob}: ${chapter.title}`,
                  outputPath,
                  chunksCompletedInJob,
                  totalChunksInJob,
                  completedInSession: chunksCompletedInSession
                });
              },
              afterGroup: (groupNumber) => {
                const groupDuration = ((Date.now() - groupStartTime) / 1000).toFixed(1);
                console.log(`[AI-CLEANUP] Completed group ${groupNumber}/${totalChunksInJob} in ${groupDuration}s`);
                chunksCompletedInJob++;
                chunksCompletedInSession++;
                // Throws TOO_MANY_FALLBACKS once the (proportional) threshold is hit.
                checkFallbackThreshold(jobState);
                if (firstChunkCompletedAt === null) firstChunkCompletedAt = Date.now();
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
              },
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Per-BLOCK failures were already absorbed and recorded inside
            // simplifyBlockGroup. Anything that reaches here is fatal by design —
            // a dead account, a cancellation, the fallback threshold, or a
            // block-count disagreement between extractor and writer — and none of
            // those may degrade into "ship the chapter unchanged and carry on".
            if (isUnrecoverableProviderError(errorMessage)) {
              sendProgress({
                jobId,
                phase: 'error',
                currentChapter: i + 1,
                totalChapters: chapterMetas.length,
                currentChunk: chunksCompletedInJob,
                totalChunks: totalChunksInJob,
                percentage: Math.round((chunksCompletedInJob / totalChunksInJob) * 90),
                message: `AI cleanup stopped: ${errorMessage}`,
                error: errorMessage,
                outputPath
              });
              throw new Error(`AI cleanup stopped: ${errorMessage}`);
            }
            throw error;
          }

          modifiedChapters.set(chapter.id, rebuiltXhtml);

          // Same diff-cache contract as the chunk path: diff what the EPUB will
          // actually hold, not the raw model text.
          const originalText = extractChapterAsText(loadedBlocks.xhtml);
          const cleanedTextForDiff = extractChapterAsText(rebuiltXhtml);
          await addChapterDiff(chapter.id, chapter.title, originalText, cleanedTextForDiff);

          chaptersProcessed++;
          completedChapterIds.add(chapter.id);
          await saveChapterBoundary(i, chapter.id);
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
            const isUnrecoverableError = isUnrecoverableProviderError(errorMessage);

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

        await saveChapterBoundary(i, chapter.id);
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

    // Finalize diff cache (mark as complete). For the edit-list path this is the
    // pass-1 diff (original → repaired.epub, i.e. repaired.diff.json).
    await finalizeDiffCache();

    // ─────────────────────────────────────────────────────────────────────────
    // PASS 2 — TTS prep (edit-list path only). Per prose segment: footnote-marker
    // removal (the source EPUB's own <sup> markup, where it has it) →
    // quote normalization → number expansion, over the pass-1 repaired.epub.
    // The cleanup PROVIDER is not contacted here. Produces cleaned.epub and
    // cleaned.diff.json (a diff vs the ORIGINAL source EPUB). Always runs fresh
    // after pass 1; the pass-1-only checkpoint is deleted after this succeeds.
    // ─────────────────────────────────────────────────────────────────────────
    let finalOutputPath = outputPath;
    if (runTtsPrep) {
      sendProgress({
        jobId,
        phase: 'saving',
        currentChapter: totalChapters,
        totalChapters,
        currentChunk: 0,
        totalChunks: 0,
        percentage: 97,
        message: 'TTS prep: footnotes, quotes, numbers...',
        outputPath
      });
      const cleanedPath = path.join(epubDir, 'cleaned.epub');
      const ttsPrep = await runTtsPrepPass(
        epubPath, outputPath, cleanedPath, footnotePlan, jobChunkSize, options?.structuralSourceEpub,
        (chapter, chapters, done, total) => sendProgress({
          jobId, phase: 'analyzing', currentChapter: chapter, totalChapters: chapters,
          currentChunk: done, totalChunks: total, percentage: 97,
          message: `Finding footnote markers — chapter ${chapter}/${chapters}`,
          outputPath
        }),
        abortController.signal
      );
      ttsPrepReportOut = ttsPrep.report;
      finalOutputPath = cleanedPath;
      console.log(
        `[AI-CLEANUP] Pass 2 (TTS prep): ${ttsPrep.report.chaptersTransformed} chapters — ` +
        `${ttsPrep.report.totalFootnoteDeletions} footnote markers removed, ` +
        `${ttsPrep.report.totalQuoteNorm} quote glyphs normalized, ` +
        `${ttsPrep.report.totalNumbersExpanded} numbers expanded → cleaned.epub` +
        (ttsPrep.report.totalMarkerShapedLeft
          ? ` | WARNING: ${ttsPrep.report.totalMarkerShapedLeft} reference-marker-shaped numbers were NOT removed (left as digits, see cleanup-prepass-report.json)`
          : '')
      );
    }

    // Delete checkpoint — BOTH passes complete, no resume needed
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

    // Determine model name for analytics. 'unknown' stands where nothing in this
    // process can name the weights truthfully — the legacy local engine, whose
    // active model llama-bridge resolves and whose `local.model` is
    // informational — and it is left as that rather than filled with a guess.
    let modelName = 'unknown';
    if (config.provider === 'crucible' && config.crucible?.model) {
      // The SERVER is part of the identity: the same model id on the Mac and in
      // WSL2 is two different machines, and a chars/min figure that did not say
      // which one would be unreadable next to the other.
      modelName = `crucible/${config.crucible.server}/${config.crucible.model}`;
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
      // The FINAL artifact: cleaned.epub for the edit-list two-pass path, or the
      // single-pass output (simplified.epub / cleaned.epub) otherwise.
      outputPath: finalOutputPath,
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
    // The job-end model release, on the failure path as on the success one.
    // It does nothing now — see releaseCleanupModel for why the eviction it used
    // to do is not this file's any more — and it is still called from both, so
    // the day something IS owed at job end there is one place it goes.
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

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 — TTS prep. Footnote-marker removal → quote normalization → number
// expansion, per prose SEGMENT, preserving headings/markup. Only the first of the
// three removes only what the EPUB's own markup proves — nothing is inferred, and no
// model runs; the rest is deterministic too.
// ─────────────────────────────────────────────────────────────────────────────

/** Count the typographic quote/apostrophe/ellipsis glyphs normalizeQuotes replaces. */
function countTypographicGlyphs(text: string): number {
  const m = text.match(/[“”„«»‘’‚…]/g);
  return m ? m.length : 0;
}

export interface TtsPrepChapterStats {
  footnoteDeletions: string[];       // marker text actually removed (arabic "12" or symbol glyph)
  footnoteSpared: number[];          // off-chain values left in place (chain selection)
  footnoteGateSkipReason?: string;   // set when the chapter's chain gate refused deletion
  quoteNormCount: number;            // typographic glyphs normalized
  numbersExpanded: number;
  markerShapedLeft: number;          // marker-position numbers left as digits
  footnoteRecovered: number[];       // gap-recovered marker values (sequence-proven)
  footnoteStructural: number;        // markers proven by the original EPUB's markup
  numberSamples: string[];           // "from → to" samples for eyeballing
}

export interface TtsPrepChapterResult {
  /** Chapter text with footnote markers removed but quotes/numbers untouched. */
  footnoteOnlyText?: string;
  /** Where the footnote removals came from, for the Review Changes label. */
  footnoteSource?: 'archive' | 'inferred';
  xhtml: string;
  stats: TtsPrepChapterStats;
  /** False when the chapter carries no prose (heading-only / non-text) — then the
   *  input XHTML is returned untouched so its markup (images etc.) survives. */
  transformed: boolean;
}

/**
 * TTS prep for ONE chapter. Segment-walks the chapter (same machinery
 * pass 1 uses), transforming ONLY prose text: footnote-marker removal, then quote
 * normalization, then English number expansion. Headings pass through verbatim
 * (re-normalized idempotently by rebuildChapterPreservingHeadings). Pure — no fs, no
 * model — so it is unit-testable.
 *
 * Footnote markers arrive here already DECIDED, never inferred on the spot: either as
 * `structural` markers read off the publisher's own <sup> markup. A book that does not
 * mark its markers up gets none removed here — that is the foundry `footnotes` pass's
 * job, not this one's guess.
 */
export function ttsPrepChapter(
  chapterXhtml: string,
  chunkSize: number,
  footnotePlan: { regex: RegExp; observation: FootnoteObservation } | null,
  structural?: StructuralMarker[]
): TtsPrepChapterResult {
  const zeroStats = (): TtsPrepChapterStats => ({
    footnoteDeletions: [], footnoteSpared: [], footnoteRecovered: [], footnoteStructural: 0, quoteNormCount: 0, numbersExpanded: 0, markerShapedLeft: 0, numberSamples: [],
  });

  // ── PARKED: the inferred (shape-based) footnote machinery ──────────────────
  // Superseded by structural proof + the foundry `footnotes` pass. Kept, not deleted,
  // because it is the only path that needs no download and no GPU, and reviving it
  // is a matter of uncommenting these three blocks plus the observation call in
  // cleanupEpub's pass-1 planning.
  //
  // WHY IT WAS PARKED: it reconstructs a NUMERIC reference chain from shape alone,
  // and the markers real scans actually carry are overwhelmingly not numbers — the
  // labelled corpus removes `*`, `”`, `’`, `°`, `?`, `!`, `>`, `®` and `§` far more
  // often than a digit. Everything downstream of that assumption (the sequence gate,
  // the chain selection, the gap recovery) could therefore only ever address a
  // minority of the problem, at the price of guessing at genuine numbers in prose.
  //
  // WHAT WOULD JUSTIFY REVIVING IT: a need to strip markers from books that carry no
  // <sup> markup without invoking foundry at all. That would be a real reason; "the
  // foundry pass is another step" is not, and a silent fallback to shape-guessing
  // would be worse than a clear failure.
  //
  // let chapterFootnoteRegex: RegExp | null = null;
  // // null = delete every match (non-arabic markers carry no values to gate on).
  // let allowedValues: Set<number> | null = null;
  // // Gap recovery: markers the plan's regex cannot see, proven by this chapter's own
  // // numbering (see recoverGapMarkers). Applied with a deliberately loose pattern that
  // // is safe ONLY because the value set is restricted to chapter-unique gap fillers.
  // let recoveryRegex: RegExp | null = null;
  // let recoveredValues: Set<number> = new Set();

  const stats = zeroStats();
  // Structural markers are proof read off the publisher's own markup, so where they
  // exist they REPLACE the model outright. Proof beats inference: a book that tells
  // us where its markers are should never have a model guess at them.
  const useStructural = !!structural && structural.length > 0;
  if (useStructural) {
    stats.footnoteStructural = structural!.length;
  }
  // } else if (footnotePlan) {
  //   const chapterText = extractChapterAsText(chapterXhtml);
  //   const sel = selectFootnoteDeletions(chapterText, footnotePlan.regex, footnotePlan.observation);
  //   if (!sel.apply) {
  //     stats.footnoteGateSkipReason = sel.reason;
  //   } else if (sel.deletions.length > 0) {
  //     chapterFootnoteRegex = footnotePlan.regex;
  //     if ((footnotePlan.observation.marker_type || 'arabic') === 'arabic') {
  //       const counts = new Map<number, number>();
  //       for (const m of chapterText.matchAll(new RegExp(footnotePlan.regex.source, 'g'))) {
  //         const v = parseInt(m[0], 10);
  //         counts.set(v, (counts.get(v) ?? 0) + 1);
  //       }
  //       allowedValues = new Set(sel.deletions.map(d => d.value).filter(v => counts.get(v) === 1));
  //       const rec = recoverGapMarkers(chapterText, sel, footnotePlan.observation);
  //       if (rec.values.length > 0) {
  //         recoveredValues = new Set(rec.values);
  //         recoveryRegex = new RegExp(rec.looseSource, 'g');
  //       }
  //     }
  //     stats.footnoteSpared = [...sel.keptOutliers];
  //   }
  // }

  // Footnote-marker removal alone. Split out from the full transform so pass 2 can
  // produce the INTERMEDIATE chapter text — original with markers gone, quotes and
  // numbers untouched. Review Changes needs it: a marker sitting right after a curly
  // quote is removed at the same spot the quote is straightened, and a raw
  // original-vs-final diff collapses the two into one `”12` -> `"` edit that reads as
  // a quote change. Diffing against this intermediate is what tells the two apart.
  //
  // Order-independent and idempotent — which it must be, because this closure runs
  // several times over the same segments while the chunk layout is computed.
  const removeFootnotes = (proseText: string): string => {
    let t = proseText;
    if (useStructural) {
      t = applyStructuralMarkers(t, structural!).text;
    }
    // if (chapterFootnoteRegex) {
    //   const av = allowedValues;
    //   t = t.replace(new RegExp(chapterFootnoteRegex.source, 'g'), m => (av === null || av.has(parseInt(m, 10))) ? '' : m);
    // }
    // if (recoveryRegex) {
    //   t = t.replace(new RegExp(recoveryRegex.source, 'g'), m => recoveredValues.has(parseInt(m.trim(), 10)) ? '' : m);
    // }
    return t;
  };

  // The stateless, order-independent prose transform (deletes by value-set), applied
  // per prose segment in BOTH the chunk walk and the rebuild count recompute.
  const transform = (proseText: string): string => {
    let t = removeFootnotes(proseText);
    t = normalizeQuotes(t);
    t = expandNumbersEn(t);
    return t;
  };

  // Only transform chapters with prose (mirrors pass-1 chapterMetas selection). A
  // heading-only or non-text chapter has zero prose chunks — pass it through so
  // rebuildChapterPreservingHeadings never wipes its non-prose markup.
  const proseChunks = chunkChapterProse(chapterXhtml, chunkSize, transform);
  if (proseChunks.length === 0) return { xhtml: chapterXhtml, stats: zeroStats(), transformed: false };

  const xhtml = rebuildChapterPreservingHeadings(chapterXhtml, proseChunks.map(c => c.text), chunkSize, transform);

  // The same chapter with ONLY the footnote markers removed, built through the same
  // chunk+rebuild path so its text lines up with the final one character for
  // character apart from the quote/number edits. Handed to the diff cache for
  // attribution; never written to disk.
  const footnoteOnlyChunks = chunkChapterProse(chapterXhtml, chunkSize, removeFootnotes);
  const footnoteOnlyText = extractChapterAsText(
    rebuildChapterPreservingHeadings(chapterXhtml, footnoteOnlyChunks.map(c => c.text), chunkSize, removeFootnotes)
  );

  // Stats: ONE deterministic walk over the prose segments in transform order (the
  // transform closure above runs multiple times for chunk layout, so counting there
  // would double-count).
  for (const seg of segmentChapter(chapterXhtml)) {
    if (seg.kind !== 'prose') continue;
    let t = seg.text;
    if (useStructural) {
      const sr = applyStructuralMarkers(t, structural!);
      for (const v of sr.removed) stats.footnoteDeletions.push(v);
      t = sr.text;
    }
    // if (chapterFootnoteRegex) {
    //   const av = allowedValues;
    //   t = t.replace(new RegExp(chapterFootnoteRegex.source, 'g'), m => {
    //     if (av === null || av.has(parseInt(m, 10))) { stats.footnoteDeletions.push(m); return ''; }
    //     return m;
    //   });
    // }
    // if (recoveryRegex) {
    //   t = t.replace(new RegExp(recoveryRegex.source, 'g'), m => {
    //     if (!recoveredValues.has(parseInt(m.trim(), 10))) return m;
    //     stats.footnoteDeletions.push(m);
    //     stats.footnoteRecovered.push(parseInt(m.trim(), 10));
    //     return '';
    //   });
    // }
    stats.quoteNormCount += countTypographicGlyphs(t);
    t = normalizeQuotes(t);
    const det = expandNumbersEnDetailed(t);
    stats.numbersExpanded += det.expansions.length;
    stats.markerShapedLeft += det.markerShaped.length;
    for (const e of det.expansions) {
      if (stats.numberSamples.length < 12) stats.numberSamples.push(`${e.from} → ${e.to}`);
    }
  }

  return { xhtml, stats, transformed: true, footnoteOnlyText, footnoteSource: useStructural ? 'archive' : 'inferred' };
}

/**
 * Cheap pre-check: does this EPUB contain any digits-only <sup> footnote markup?
 *
 * Used to decide whether the footnote OBSERVATION model call is needed at all. It
 * only has to answer "is there proof to be had", not extract it — pass 2 does the
 * real extraction and validation. Never throws: an unreadable or missing archive
 * just means "no proof", and the inferred pipeline runs as it always did.
 */
async function archiveHasStructuralMarkers(epubPath: string): Promise<boolean> {
  try {
    const { EpubProcessor } = await import('./epub-processor.js');
    const proc = new EpubProcessor();
    await proc.open(epubPath);
    const s = proc.getStructure();
    try {
      if (!s) return false;
      for (const ch of s.chapters) {
        const href = s.rootPath ? `${s.rootPath}/${ch.href}` : ch.href;
        let xhtml: string;
        try { xhtml = await proc.readFile(href); } catch { continue; }
        if (extractStructuralMarkers(xhtml).length > 0) return true;
      }
      return false;
    } finally {
      proc.close();
    }
  } catch (e) {
    console.warn(`[AI-CLEANUP] Could not check the archived original for <sup> markers (${(e as Error).message})`);
    return false;
  }
}

/** True when the XHTML has a <body> element (a chapter we can rebuild). */
function hasBodyElement(xhtml: string): boolean {
  return /<body([^>]*)>[\s\S]*<\/body>/i.test(xhtml);
}

/**
 * Run the whole TTS-prep pass over a pass-1 repaired.epub, producing cleaned.epub +
 * cleaned.diff.json. cleaned.diff.json is a diff vs the ORIGINAL source EPUB (the
 * editor UI reads it as "changes vs original"): pass-1 model repairs are already
 * baked into repaired.epub, so comparing the ORIGINAL chapter text against the
 * pass-2 output captures BOTH passes in one diff — the same original→X process the
 * diff cache runs for pass 1, just with X = cleaned.
 */
async function runTtsPrepPass(
  originalEpubPath: string,
  repairedEpubPath: string,
  cleanedEpubPath: string,
  footnotePlan: { regex: RegExp; observation: FootnoteObservation } | null,
  chunkSize: number,
  structuralSourceEpub: string | undefined,
  onFootnoteProgress?: (chapter: number, chapters: number, done: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ report: TtsPrepReport }> {
  const { EpubProcessor } = await import('./epub-processor.js');
  const originalProc = new EpubProcessor();
  await originalProc.open(originalEpubPath);
  const repairedProc = new EpubProcessor();
  await repairedProc.open(repairedEpubPath);

  const structure = repairedProc.getStructure();
  if (!structure) throw new Error('[AI-CLEANUP] TTS prep: repaired.epub has no structure');
  const origStructure = originalProc.getStructure();

  // Fresh diff cache session for cleaned.epub (original → cleaned).
  await clearDiffCache(cleanedEpubPath);
  await startDiffCache(cleanedEpubPath, originalEpubPath);

  // ── Structural footnote plan (proof) ────────────────────────────────────
  // The archived ORIGINAL still carries the publisher's <sup> markup that
  // exported.epub flattened into bare digits. Read the markers back off it, then
  // keep only the ones whose context appears exactly once in THIS book's working
  // text and is followed by the expected digits. Book-wide uniqueness is what makes
  // a context safe to apply inside any single chapter.
  let structuralAll: StructuralMarker[] = [];
  let structuralAmbiguous = 0, structuralNotFound = 0;
  if (structuralSourceEpub) {
    try {
      const origProc = new EpubProcessor();
      await origProc.open(structuralSourceEpub);
      const os = origProc.getStructure();
      const raw: StructuralMarker[] = [];
      if (os) {
        for (const ch of os.chapters) {
          const href = os.rootPath ? `${os.rootPath}/${ch.href}` : ch.href;
          let xhtml: string;
          try { xhtml = await origProc.readFile(href); } catch { continue; }
          raw.push(...extractStructuralMarkers(xhtml));
        }
      }
      origProc.close();
      if (raw.length > 0) {
        // The working book's full text, as pass 2 will see it before any edit.
        const bookParts: string[] = [];
        for (const chapter of structure.chapters) {
          const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
          try { bookParts.push(extractChapterAsText(await repairedProc.readFile(href))); } catch { /* skip */ }
        }
        const sel = selectUniqueStructuralMarkers(raw, bookParts.join('\n'));
        structuralAll = sel.kept;
        structuralAmbiguous = sel.ambiguous;
        structuralNotFound = sel.notFound;
        console.log(
          `[AI-CLEANUP] Structural footnote markers from the original EPUB: ${raw.length} found, ` +
          `${sel.kept.length} proven unique (ambiguous ${sel.ambiguous}, not found ${sel.notFound}) — ` +
          `these REPLACE the inferred footnote machinery`
        );
      } else {
        console.log('[AI-CLEANUP] Original EPUB carries no <sup> footnote markup — using the inferred pipeline');
      }
    } catch (e) {
      // Structural evidence is a bonus, never a requirement: a missing or unreadable
      // archive must not fail a cleanup that the inferred pipeline can still do.
      console.warn(`[AI-CLEANUP] Structural marker extraction failed (${(e as Error).message}) — falling back to the inferred pipeline`);
    }
  }

  const cleanedChapters = new Map<string, string>();
  const report: TtsPrepReport = {
    chaptersTransformed: 0, totalFootnoteDeletions: 0, totalFootnoteSpared: 0,
    totalQuoteNorm: 0, totalNumbersExpanded: 0, totalMarkerShapedLeft: 0, totalFootnoteRecovered: 0, totalFootnoteStructural: 0, chapters: [], numberSamples: [],
  };

  try {
    let chapterIndex = 0;
    for (const chapter of structure.chapters) {
      chapterIndex++;
      const href = structure.rootPath ? `${structure.rootPath}/${chapter.href}` : chapter.href;
      // repaired.epub was written from this same structure moments ago — an
      // unreadable chapter means the pass-1 output is corrupt. Fail loudly.
      const repairedXhtml = await repairedProc.readFile(href);
      if (!hasBodyElement(repairedXhtml)) continue;

      // Only the markers whose context actually occurs in THIS chapter are handed
      // down, so a chapter never scans the whole book's marker list.
      const chapterPlain = structuralAll.length > 0 ? extractChapterAsText(repairedXhtml) : '';
      const chapterStructural = structuralAll.filter(m => structuralMarkerRegex(m).test(chapterPlain));

      // No model call: a chapter whose markup does not name its markers has none
      // removed here. Proof only — see ttsPrepChapter.
      onFootnoteProgress?.(chapterIndex, structure.chapters.length, 1, 1);

      const { xhtml: cleanedXhtml, stats, transformed, footnoteOnlyText, footnoteSource } = ttsPrepChapter(
        repairedXhtml, chunkSize, footnotePlan,
        chapterStructural.length > 0 ? chapterStructural : undefined
      );
      if (!transformed) continue; // heading-only / non-text chapter — copied through verbatim
      cleanedChapters.set(chapter.id, cleanedXhtml);

      // Diff base = the ORIGINAL chapter text (cleaned.diff.json is original → cleaned).
      // The original and repaired EPUBs share one structure, so a chapter present in
      // repaired but unreadable in the original means the inputs are inconsistent —
      // fail loudly rather than record a fabricated everything-added diff.
      const origHref = origStructure?.rootPath ? `${origStructure.rootPath}/${chapter.href}` : chapter.href;
      const originalText = extractChapterAsText(await originalProc.readFile(origHref));
      await addChapterDiff(
        chapter.id, chapter.title, originalText, extractChapterAsText(cleanedXhtml),
        footnoteOnlyText, footnoteSource,
      );

      report.chaptersTransformed++;
      report.totalFootnoteDeletions += stats.footnoteDeletions.length;
      report.totalFootnoteSpared += stats.footnoteSpared.length;
      report.totalQuoteNorm += stats.quoteNormCount;
      report.totalNumbersExpanded += stats.numbersExpanded;
      report.totalMarkerShapedLeft += stats.markerShapedLeft;
      report.totalFootnoteRecovered += stats.footnoteRecovered.length;
      report.totalFootnoteStructural += stats.footnoteStructural;
      if (stats.footnoteDeletions.length || stats.footnoteSpared.length || stats.quoteNormCount || stats.numbersExpanded || stats.markerShapedLeft || stats.footnoteGateSkipReason) {
        report.chapters.push({
          id: chapter.id, title: chapter.title,
          footnoteDeletions: stats.footnoteDeletions, footnoteSpared: stats.footnoteSpared,
          footnoteGateSkipReason: stats.footnoteGateSkipReason,
          quoteNorm: stats.quoteNormCount, numbersExpanded: stats.numbersExpanded,
          markerShapedLeft: stats.markerShapedLeft || undefined,
          footnoteRecovered: stats.footnoteRecovered.length ? stats.footnoteRecovered : undefined,
        });
      }
      for (const s of stats.numberSamples) { if (report.numberSamples.length < 40) report.numberSamples.push(s); }
    }

    // Write cleaned.epub from the repaired processor so every non-chapter entry
    // (cover, css, opf, nav) carries forward, then finalize the original→cleaned diff.
    await saveModifiedEpubLocal(repairedProc, cleanedChapters, cleanedEpubPath);
    await finalizeDiffCache();
    if (structuralAll.length > 0) {
      report.structuralAmbiguous = structuralAmbiguous;
      report.structuralNotFound = structuralNotFound;
    }
  } finally {
    originalProc.close();
    repairedProc.close();
  }

  return { report };
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
  const { StreamingZipWriter } = await import('./epub-processor.js');
  const { openEpubSource } = await import('./epub-container.js');

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
  let outputReader: import('./epub-container.js').EpubSource | null = null;
  if (previouslySavedChapterIds && previouslySavedChapterIds.size > 0) {
    try {
      await fsPromises.access(outputPath);
      outputReader = await openEpubSource(outputPath);
    } catch {
      // Output EPUB doesn't exist yet — no previously saved chapters to read
      outputReader = null;
    }
  }

  const zipWriter = new StreamingZipWriter();
  await zipWriter.open();

  // Get all entries from the original EPUB
  const entries = processor.entryNames();

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

  // The reader of `outputPath` is released BEFORE the writer lands on it.
  //
  // This is the ZIP's constraint, and it is kept here because the writer is a
  // StreamingZipWriter: `finalize` renames a complete archive onto `outputPath`,
  // and Windows refuses that rename while any descriptor is still open on the
  // target. The shared seam does NOT carry the assumption — `rewriteEpubEntries`
  // releases first because that order is correct for a tree as well, not because
  // a tree needs it; a tree write touches only the entries whose bytes changed
  // and never renames the book.
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
  checkProviderConnection,
  cleanupEpub,
  cancelCleanupJob,
  getOcrCleanupSystemPrompt,
  loadPrompt,
  savePrompt,
  reloadPrompt,
  getPromptFilePath
};

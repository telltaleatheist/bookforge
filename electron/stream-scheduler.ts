/**
 * Stream Scheduler - the main process's adapter onto the shared session policy.
 *
 * ── What moved, and what did not (Phase 16 step 2) ──────────────────────────
 *
 * The POLICY — the read-ahead window, the background prefetch, the preempt
 * rule, the playhead, the first-wave ramp and the five event shapes — is
 * `shared/listen-client/session-policy.ts` since Phase 16
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §5 step 2), because the browser extension
 * is a Crucible client of its own now and has to schedule its own rows. Two
 * schedulers would be two answers to "which row is generated next", and the
 * extension's own read-ahead is what made that question interesting in the
 * first place.
 *
 * What is left in this file is everything that is genuinely the main process's:
 * which engine answers (`getActiveEngine()`), where events go by default
 * (every BrowserWindow), and the measured numbers below — those belong to the
 * engine, not to the policy.
 *
 * The exported surface is unchanged: `start`, `reportPlayhead`, `stop`,
 * `isActive`, `activeIds` and the `streamScheduler` object, with the same
 * arguments and the same `{kind, requestId, …}` events on the wire. The TTS API
 * server, the reader bridge and the Play tab cannot tell.
 *
 * Event shapes (see the shared policy's header for the full note):
 *   {kind:'chunk',    requestId, sentenceIndex, seq, data(pcm16 b64), duration, sampleRate}
 *   {kind:'done',     requestId, sentenceIndex, duration}
 *   {kind:'failed',   requestId, sentenceIndex, error}
 *   {kind:'complete', requestId}
 *   {kind:'cancelled',requestId}
 */

import { BrowserWindow } from 'electron';
import {
  PlaySettings,
  StreamChunk,
  STREAM_RAMP_WIDTH,
} from './streaming-contract';
import { getActiveEngine } from './streaming-engine';
import {
  ListenSessions,
  type ListenChunk,
  type ListenGeneratorPort,
  type ListenSink,
  type ListenStartOptions,
} from '../shared/listen-client/session-policy.js';

/** Where a session's events go. Defaults to broadcasting to all windows. */
export type StreamSink = ListenSink;

/** Options for {@link start}. Re-exported: the three surfaces pass them. */
export type StartOptions = ListenStartOptions;

// ─────────────────────────────────────────────────────────────────────────────
// THE MEASURED NUMBERS — why the cap and the ramp are what they are
// ─────────────────────────────────────────────────────────────────────────────
//
// Streaming batching (Orpheus): EVERY sentence — openers included — goes through
// the batch path (the engine's getMaxConcurrentSentences — orpheus-worker-pool.ts
// STREAM_BATCH_WIDTH, measured 2.8x realtime at 16). The client (extension
// offscreen.ts) gates the start of playback until the pipeline is far enough ahead
// that the block can play through without a gap, so the thing worth optimising here
// is how fast the whole block renders, not how fast sentence 1 does.
//
// This inverts the old "stream the openers solo for fast first audio" design. Bench
// (M1 Ultra, deathstalker, ~135-char sentences): a SOLO render is 0.73x realtime
// (~9.5s wall for ~7.5s of audio), while a batch of 16 is 2.8x. Each opener pulled
// out of the batch therefore delayed the first batch by ~10s to contribute ~7.5s of
// audio — under a seamless-start gate that is a pure loss, ~15-20s off the moment
// the first block is fully rendered.
//
// FIRST-BATCH RAMP: one exception to "always full width", and only for the session
// being LISTENED to, on its FIRST wave. A batch's wall clock is nearly flat in width
// but not quite — 8 rows land ~60s of audio in ~28s where 16 land ~120s in ~40s —
// and until the gate opens the listener is watching a spinner, not banking cushion.
// So the first wave goes out at STREAM_RAMP_WIDTH (8): the gate opens ~15s sooner,
// and the ~60s it opens on still covers the following full-width batch's ~40s of
// silence with ~20s to spare. Every wave after it, and every background read-ahead
// session, is full width — the rows retire per-row, so the next pump refills to the
// full cap and the pool's flushBatch packs them into full batches again.
//
// THE FIRST BATCH IS WIDE ON PURPOSE, AND THE COST IS PAID BEFORE THE FIRST WORD.
//
// It is tempting to give the playing block a batch to ITSELF so the first word lands
// fast, and it works exactly as advertised: measured 2026-08-31 (M1 Ultra, deathstalker,
// MLX) the clicked paragraph came back in 15.3s alone versus ~50s riding with seven
// read-ahead rows, because rows retire in mlx-lm's order and a whole paragraph is
// normally the LONGEST row present, so it retires LAST. That was shipped for an
// afternoon. It is wrong, and the reason is arithmetic, not scheduling:
//
//     batch of 1 row  ->  12.7 chars/sec        deathstalker SPEAKS at ~17.6 chars/sec
//     batch of 3 rows ->  14.3 chars/sec
//     batch of 8 rows ->  30-33 chars/sec
//     batch of 16     ->  32 chars/sec
//
// A narrow batch generates SLOWER THAN SPEECH. So a fast first word is bought by
// starting the read already behind: the listener hears 11s of paragraph 1 and then
// waits ~33s for paragraph 2, because the first wide batch takes ~44s and paragraph 1
// never bought enough time to cover it. Every batch from the second on runs ~1.8x
// speech and pulls away, so there is exactly ONE stall — early, and unmissable.
//
// The listener's own ruling: pay it up front. A 50s wait before the first word, then an
// article that reads straight through, beats 15s to the first word and a hole in the
// middle of it. So the first batch goes out at STREAM_RAMP_WIDTH — the narrowest width
// that beats speech rate — carrying the playing block AND the read-ahead behind it, and
// playback starts when the whole batch lands with several blocks already buffered.
//
// Do not "fix" the clicked block retiring last without re-reading this block. It is a
// real observation with a wrong cure, and the cure has been tried.
//
// The pool batches from a SINGLE queue shared by every session: flushBatch fills to the
// ladder's current width, priority rows first, so the playing block's own sentences are
// always in that first batch rather than queued behind read-ahead.
//
// The "MLX needs one narrow fixed warmed shape" rationale that once justified small
// batches everywhere is obsolete: mlx-lm 0.31.3 right-pads batch prefills, so widths
// may vary freely; an unwarmed width just compiles lazily (~10s, once). The worker
// pre-warms width 1, the ramp width and the full width — the ramp is warmed because
// a lazy compile in front of the first sentence is exactly what it exists to avoid,
// while a stray intermediate width (a block's short tail group) still compiles
// lazily behind a buffer that is by then many sentences deep.
//
// READ-AHEAD IS NEVER NARROWED BY BLOCK, and the temptation to do it is strong enough
// to be worth writing down. It looks like the fix for "paragraph 2 arrived after
// paragraphs 3 and 4": rows retire in mlx-lm's order, so a batch mixing the block that
// plays next with the blocks behind it retires the SHORT ones first, and on a news page
// paragraph 2 is usually the long quote-heavy one. Giving the next block a batch to
// itself does put it back in order — and measured 2026-08-31 (deathstalker, MLX,
// ~175-char sentences) it is a disaster, because MLX per-step cost is nearly FLAT in
// width above ~3 rows:
//
//     width  3 -> 36.8s wall for  28.0s of audio = 0.76x realtime
//     width  8 -> 42.1s wall for  75.5s of audio = 1.79x realtime
//     width 16 -> 83.0s wall for 149.8s of audio = 1.80x realtime
//
// Widening 3 -> 8 costs FIVE SECONDS of wall clock and returns 2.7x the audio. A
// per-block ramp holds read-ahead at the 3-row shape, i.e. below realtime, so playback
// outruns generation and stalls again at every paragraph — trading one ordering
// complaint for a permanent one. In-order delivery is worth nothing if the pipeline
// cannot keep up; being a few blocks out of order costs nothing once the buffer is
// deep, because the client assembles by index and plays in order regardless.
//
// The ordering the listener actually feels is handled where it belongs: the FIRST batch
// carries the block being played and nothing else (the ramp hold above), so the first
// word is fast. Everything after that goes as wide as the pool's ladder allows.
//
// THE OPPOSITE PHYSICS IS GONE WITH ITS ENGINE. Until 2026-09-05 this scheduler
// carried a second dispatch path for XTTS — a solo, genuinely token-streamed
// OPENER (`shouldStreamSentence`), which was right for it: sub-3s first audio,
// with a multi-worker pool rendering the rest above realtime behind it. XTTS was
// removed from the root, and every remaining engine is a batching one, so the
// predicate could only ever answer false. It is deleted rather than left as an
// always-false branch: an unreachable dispatch arm is a second answer to "how
// does a sentence get generated" that nothing tests. Fast start is how a
// listener gets early audio now, and it rides the batch path rather than
// competing with it.

function broadcastToWindows(data: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('stream:event', data);
    }
  }
}

/**
 * The active streaming engine, as the shared policy's generator port.
 *
 * Read through `getActiveEngine()` on every call rather than captured: the
 * venue-routed facade (`electron/crucible/stream.ts`) picks its backend at cold
 * start, and a captured engine would keep answering for the one before it.
 */
const engineAsGenerator: ListenGeneratorPort<string, PlaySettings> = {
  isReady: () => getActiveEngine().isSessionActive(),
  concurrency: () => {
    // A batching engine reports its streaming batch width here (Orpheus: 16 —
    // see orpheus-worker-pool.ts STREAM_BATCH_WIDTH); an engine that does not
    // batch reports its worker count.
    const engine = getActiveEngine();
    const batching = typeof engine.getMaxConcurrentSentences === 'function';
    return {
      cap: engine.getMaxConcurrentSentences?.() ?? engine.getWorkerCount(),
      batching,
    };
  },
  rampWidth: () => STREAM_RAMP_WIDTH,
  generate: (text, sentenceIndex, settings, priority, isStale, onChunk) =>
    getActiveEngine().generateSentence(
      text,
      sentenceIndex,
      settings,
      priority,
      isStale,
      onChunk === undefined
        ? undefined
        : (chunk: StreamChunk) => onChunk(chunk as ListenChunk<string>),
    ),
  abandonStaleBatch: () => { getActiveEngine().cancelPendingBatchIfStale?.(); },
};

/** Every generating session, and the rules about which row goes next. */
const sessions = new ListenSessions<string, PlaySettings>(
  engineAsGenerator,
  broadcastToWindows,
  (line) => console.log(`[StreamScheduler] ${line}`),
);

/**
 * Start a generation session. requestId is caller-supplied so the client can
 * filter events for the session it asked for. With `preempt` (default) this
 * cancels all other sessions first; with `preempt:false` it runs alongside them.
 */
export function start(
  sentences: string[],
  startIndex: number,
  settings: PlaySettings,
  requestId: string | number,
  sink: StreamSink = broadcastToWindows,
  opts: StartOptions = {},
): { success: boolean; error?: string } {
  return sessions.start(sentences, startIndex, settings, requestId, sink, opts);
}

/** Client reports playback position. Advances this session's lookahead window
 *  and — since only the block being listened to reports a playhead — promotes a
 *  background read-ahead session to playing priority. */
export function reportPlayhead(requestId: string | number, sentenceIndex: number): void {
  sessions.reportPlayhead(requestId, sentenceIndex);
}

/** Stop one session (by requestId) or, with no argument, every session.
 *  In-flight streaming is cancelled; batch results are dropped via isStale(). */
export function stop(requestId?: string | number): void {
  sessions.stop(requestId);
}

/** True if a session with this requestId is still generating. Lets a caller
 *  verify ownership before playhead/cancel. */
export function isActive(requestId: string | number): boolean {
  return sessions.isActive(requestId);
}

/** Every generating session's requestId. Lets a caller preempt SELECTIVELY —
 *  cancelling other clients' sessions while sparing the requesting client's own
 *  read-ahead, which is already-rendered audio that a blanket stopAll would
 *  throw away. The 8766 relay was this door's reason and is deleted; the reader
 *  bridge still needs the same distinction. */
export function activeIds(): (string | number)[] {
  return sessions.activeIds();
}

export const streamScheduler = {
  start,
  reportPlayhead,
  stop,
  isActive,
  activeIds,
};

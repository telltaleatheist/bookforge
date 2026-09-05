/**
 * Stream Scheduler - main-process orchestration for Play/Stream TTS playback
 *
 * Owns the sentence queues for listening. MULTIPLE sessions can generate at
 * once: one "playing" session (priority) plus any number of background
 * read-ahead sessions the browser extension prefetches for upcoming blocks.
 * Their sentences interleave across the whole worker pool via the pool's
 * free-worker queue, so a page made of tiny one-sentence blocks still saturates
 * all CPU workers instead of dribbling through one block at a time. The playing
 * session's sentences are dispatched at high priority (they jump the pool's wait
 * queue) so read-ahead never delays what's actually being heard.
 *
 * A `start({preempt:true})` (the default) cancels every existing session first —
 * that's how a new play action takes over the single audio output. A
 * `start({preempt:false})` adds a session alongside the others — that's how the
 * extension fans out read-ahead. `priority:false` marks a session as background
 * (batch-only, low pool priority); a background session is promoted the moment a
 * playhead is reported for it (the extension adopted it as the current block).
 *
 * Living in the main process means any window (main app or listen window) can
 * drive or observe a session, and renderer reloads don't orphan generation.
 *
 * All events go out through the session's sink. Window sessions broadcast on
 * the 'stream:event' channel; external sessions (TTS API server) send to one
 * WebSocket client. Event shapes:
 *   {kind:'chunk',    requestId, sentenceIndex, seq, data(pcm16 b64), duration, sampleRate}
 *   {kind:'done',     requestId, sentenceIndex, duration}   // sentence fully generated
 *
 * A sentence normally emits ONE chunk (seq 0) and then its 'done'. A fastStart
 * session emits several (see StartOptions.fastStart, added for Owen's 2026-09-04
 * ruling): 4 SNAC frames at a time while it generates, then a 'done' with NO
 * further chunk. The shape is the same either way, so a client that assembles by
 * (sentenceIndex, seq) needs to know nothing about which it is getting.
 *   {kind:'failed',   requestId, sentenceIndex, error}
 *   {kind:'complete', requestId}                            // nothing left to generate
 *   {kind:'cancelled',requestId}                            // stopped or preempted by a new start
 */

import { BrowserWindow } from 'electron';
import {
  PlaySettings,
  StreamChunk,
  STREAM_RAMP_WIDTH,
} from './orpheus-worker-pool';
import { getActiveEngine } from './streaming-engine';

/** Where a session's events go. Defaults to broadcasting to all windows. */
export type StreamSink = (data: Record<string, unknown>) => void;

// Default: generate until this much audio is buffered ahead of the playhead, then
// idle until the playhead advances. Sized to fully buffer a short article up front
// (~2000s ≈ 5000 spoken words) so a whole page can play through without underruns;
// the worker pool generates flat-out until the window is full, then idles. Right
// for the extension's per-block requests (each finishes well inside the window).
// Callers streaming ONE long session — the in-app Play tab streams a whole book —
// pass a small lookaheadSeconds instead: 45s refills faster than playback drains
// it (~2.1x realtime aggregate), and a deep window on a book would burn minutes of
// flat-out compute on audio the listener may never reach (and discard it all on a
// voice/speed change). Memory is the client's concern.
const DEFAULT_LOOKAHEAD_SECONDS = 2000;

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
// being LISTENED to, on its FIRST wave (see the cap in pump). A batch's wall clock
// is nearly flat in width but not quite — 8 rows land ~60s of audio in ~28s where 16
// land ~120s in ~40s — and until the gate opens the listener is watching a spinner,
// not banking cushion. So the first wave goes out at STREAM_RAMP_WIDTH (8): the gate
// opens ~15s sooner, and the ~60s it opens on still covers the following full-width
// batch's ~40s of silence with ~20s to spare. Every wave after it, and every
// background read-ahead session, is full width — the rows retire per-row, so the
// next pump refills to the full cap and the pool's flushBatch packs them into full
// batches again.
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
//
// The "MLX needs one narrow fixed warmed shape" rationale that once justified small
// batches everywhere is obsolete: mlx-lm 0.31.3 right-pads batch prefills, so widths
// may vary freely; an unwarmed width just compiles lazily (~10s, once). The worker
// pre-warms width 1, the ramp width and the full width — the ramp is warmed because
// a lazy compile in front of the first sentence is exactly what it exists to avoid,
// while a stray intermediate width (a block's short tail group) still compiles
// lazily behind a buffer that is by then many sentences deep.
//
// THE OPPOSITE PHYSICS IS GONE WITH ITS ENGINE. Until 2026-09-05 this scheduler
// carried a second dispatch path for XTTS — a solo, genuinely token-streamed
// OPENER (`shouldStreamSentence`), which was right for it: sub-3s first audio,
// with a multi-worker pool rendering the rest above realtime behind it. XTTS was
// removed from the root, and every remaining engine is a batching one, so the
// predicate could only ever answer false. It is deleted rather than left as an
// always-false branch: an unreachable dispatch arm is a second answer to "how
// does a sentence get generated" that nothing tests. Fast start (below) is how a
// listener gets early audio now, and it rides the batch path rather than
// competing with it.

interface SchedulerSession {
  requestId: string | number;
  sentences: string[];
  settings: PlaySettings;
  startIndex: number;
  nextToDispatch: number;
  playhead: number;
  /** sentenceIndex -> generated audio duration (seconds) */
  durations: Map<number, number>;
  inFlight: Set<number>;
  stopped: boolean;
  completeSent: boolean;
  sink: StreamSink;
  /** Playing session (true) vs background read-ahead (false). Drives pool
   *  priority and whether the opening sentences stream. Flips to true when a
   *  playhead is reported (the client started playing this block). */
  priority: boolean;
  /** Generate-ahead window for this session (seconds ahead of the playhead). */
  lookaheadSeconds: number;
  /** FAST START — see StartOptions.fastStart. */
  fastStart: boolean;
}

/** Every generating session, keyed by requestId. */
const sessions = new Map<string | number, SchedulerSession>();

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
// carries the block being played and nothing else (the ramp hold below), so the first
// word is fast. Everything after that goes as wide as the pool's ladder allows.

function broadcastToWindows(data: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('stream:event', data);
    }
  }
}

/** Options for {@link start}. */
export interface StartOptions {
  /** Cancel every other session first (a new play action takes over the audio
   *  output). Default true — read-ahead passes false to coexist. */
  preempt?: boolean;
  /** Playing session (true, default) vs background read-ahead (false). */
  priority?: boolean;
  /** Generate-ahead window (seconds of audio ahead of the playhead). Defaults
   *  deep (whole short article); long single-session callers pass ~45. */
  lookaheadSeconds?: number;
  /**
   * FAST START. Default false, which is every path that existed before 2026-09-04.
   *
   * Owen's ruling of that date: the batch design above is right for a read that has
   * to play through without a hole, and it costs ~30s before the first word. He
   * wanted the choice — a switch in the browser extension, ON ("buffer before
   * playing") by default and behaving exactly as it always has, OFF ("fast start")
   * accepting stalls in exchange for hearing something in about a second.
   *
   * OFF sets this. It does NOT change batching or scheduling: same width, same
   * ramp, same order, same pool. What changes is WHEN audio leaves the worker — the
   * engine emits each sentence in sub-sentence chunks as it generates instead of one
   * payload when the batch retires — and, on the client, when playback starts. Read
   * the batch-width and first-batch-ramp blocks at the top of this file before
   * touching it: none of that reasoning is wrong, it is simply a different bargain,
   * and this flag is which bargain the listener chose.
   *
   * Only the PLAYING session ever streams. Background read-ahead has nobody waiting
   * on its first second, and streaming it would spend chunk traffic on audio that
   * will be played from cache minutes later, if at all.
   */
  fastStart?: boolean;
}

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
  opts: StartOptions = {}
): { success: boolean; error?: string } {
  if (!getActiveEngine().isSessionActive()) {
    return { success: false, error: 'TTS session not active' };
  }

  const preempt = opts.preempt !== false;
  const priority = opts.priority !== false;

  if (preempt) stopAll();
  else endSession(sessions.get(requestId));  // replace a same-id session, if any

  const s: SchedulerSession = {
    requestId,
    sentences,
    settings,
    startIndex,
    nextToDispatch: startIndex,
    playhead: startIndex,
    durations: new Map(),
    inFlight: new Set(),
    stopped: false,
    completeSent: false,
    sink,
    priority,
    lookaheadSeconds: opts.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS,
    fastStart: opts.fastStart === true
  };
  sessions.set(requestId, s);

  console.log(`[StreamScheduler] Start req=${requestId} ${priority ? 'play' : 'prefetch'} from sentence ${startIndex}/${sentences.length}${preempt ? ' (preempt)' : ''}${s.fastStart && priority ? ' [fast start]' : ''}`);
  pump(s);
  return { success: true };
}

/** Client reports playback position. Advances this session's lookahead window
 *  and — since only the block being listened to reports a playhead — promotes a
 *  background read-ahead session to playing priority. */
export function reportPlayhead(requestId: string | number, sentenceIndex: number): void {
  const s = sessions.get(requestId);
  if (!s || s.stopped) return;
  s.priority = true;
  if (sentenceIndex > s.playhead) {
    s.playhead = sentenceIndex;
    pump(s);
  }
}

/** Stop one session (by requestId) or, with no argument, every session.
 *  In-flight streaming is cancelled; batch results are dropped via isStale(). */
export function stop(requestId?: string | number): void {
  if (requestId === undefined) { stopAll(); return; }
  endSession(sessions.get(requestId));
}

/** True if a session with this requestId is still generating. Lets external
 *  callers (TTS API server) verify ownership before playhead/cancel. */
export function isActive(requestId: string | number): boolean {
  const s = sessions.get(requestId);
  return !!s && !s.stopped;
}

/** Every generating session's requestId. Lets a caller preempt SELECTIVELY —
 *  the TTS API server cancels other clients' sessions on a preempting speak while
 *  sparing the requesting client's own read-ahead, which is already-rendered
 *  audio that a blanket stopAll would throw away. */
export function activeIds(): (string | number)[] {
  return [...sessions.keys()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Cancel every session (used by a preempting start / global stop). */
function stopAll(): void {
  for (const s of [...sessions.values()]) endSession(s);
}

/** Cancel one session: drop it from the map, cancel its stream if any, and tell
 *  the client it was cancelled (unless it already completed). */
function endSession(s: SchedulerSession | undefined): void {
  if (!s || s.stopped) return;
  console.log(`[StreamScheduler] Stop req=${s.requestId}`);
  s.stopped = true;
  sessions.delete(s.requestId);
  // This session's rows may be the last live ones in the engine's in-flight batch —
  // and on a serial batching engine (Orpheus) that batch is 30-43s of work whose
  // results are now discarded on arrival, with the next voice load and the next
  // block's batch queued behind it. Ask the engine to abandon it. It refuses unless
  // EVERY outstanding row is stale, so a batch still carrying another session's
  // sentences is untouched — which is why this must come AFTER `s.stopped` and the
  // map removal above (the staleness predicates read exactly that state).
  getActiveEngine().cancelPendingBatchIfStale?.();
  if (!s.completeSent) s.sink({ kind: 'cancelled', requestId: s.requestId });
}

/** Seconds of generated-but-not-yet-played audio ahead of the playhead. */
function bufferedSecondsAhead(s: SchedulerSession): number {
  let total = 0;
  for (const [index, duration] of s.durations) {
    if (index >= s.playhead) total += duration;
  }
  return total;
}

function pump(s: SchedulerSession): void {
  if (s.stopped || sessions.get(s.requestId) !== s) return;

  const engine = getActiveEngine();

  // In-flight cap: a batching engine (Orpheus) reports its streaming batch width
  // here (16 — see orpheus-worker-pool.ts STREAM_BATCH_WIDTH); an engine that does
  // not batch reports its worker count. We dispatch a whole batch's worth at once
  // so the engine's batch goes out FULL — a partly-filled MLX batch costs the same
  // wall clock as a full one, so anything less is throughput thrown away.
  const batching = typeof engine.getMaxConcurrentSentences === 'function';
  const fullCap = engine.getMaxConcurrentSentences?.() ?? engine.getWorkerCount();
  // …except the FIRST wave of the session actually being listened to, which goes out
  // at STREAM_RAMP_WIDTH so the client's start gate opens ~15s sooner (see the
  // first-batch ramp note at the top of this file). Only ever the first wave: after
  // this, nextToDispatch has moved off startIndex and the cap is full again.
  // Background read-ahead never ramps — full batches are the entire point there.
  const cap = batching && s.priority && s.nextToDispatch === s.startIndex
    ? Math.min(STREAM_RAMP_WIDTH, fullCap)
    : fullCap;

  while (
    s.inFlight.size < cap &&
    s.nextToDispatch < s.sentences.length &&
    bufferedSecondsAhead(s) < s.lookaheadSeconds
  ) {
    dispatch(s, s.nextToDispatch++);
  }

  // Everything generated and delivered?
  if (
    !s.completeSent &&
    s.nextToDispatch >= s.sentences.length &&
    s.inFlight.size === 0
  ) {
    s.completeSent = true;
    sessions.delete(s.requestId);
    s.sink({ kind: 'complete', requestId: s.requestId });
  }
}

function dispatch(s: SchedulerSession, sentenceIndex: number): void {
  const requestId = s.requestId;
  const text = s.sentences[sentenceIndex];
  const isStale = () => sessions.get(requestId) !== s || s.stopped;
  s.inFlight.add(sentenceIndex);

  // FAST START (see StartOptions.fastStart): sink this sentence's audio in
  // sub-sentence chunks as it generates, instead of one chunk when it lands. The
  // sink shape is IDENTICAL to the one the batch path emits below — same 'chunk'
  // event, same fields — so the client needs no new event type: it simply receives
  // several per sentence, earlier, and assembles them by (sentenceIndex, seq)
  // exactly as it always has.
  //
  // Only the playing session, and only when the client asked. A background
  // read-ahead session never streams: nobody is waiting on its first second.
  const onChunk = s.fastStart && s.priority
    ? (chunk: StreamChunk) => {
        if (isStale()) return;
        s.sink({
          kind: 'chunk',
          requestId,
          sentenceIndex,
          seq: chunk.seq,
          data: chunk.data,
          duration: chunk.duration,
          sampleRate: chunk.sampleRate
        });
      }
    : undefined;

  void getActiveEngine()
    .generateSentence(text, sentenceIndex, s.settings, s.priority, isStale, onChunk)
    .then((result) => {
      if (isStale()) return;
      s.inFlight.delete(sentenceIndex);
      if (result.success && result.streamed) {
        // Fast start: the audio already went out chunk by chunk above, so the ONLY
        // thing left to say is that the sentence is finished. Emitting a seq-0 chunk
        // here would deliver it a second time.
        const duration = result.duration || 0;
        s.durations.set(sentenceIndex, duration);
        s.sink({ kind: 'done', requestId, sentenceIndex, duration });
      } else if (result.success && result.audio) {
        s.durations.set(sentenceIndex, result.audio.duration);
        s.sink({
          kind: 'chunk',
          requestId,
          sentenceIndex,
          seq: 0,
          data: result.audio.data,
          duration: result.audio.duration,
          sampleRate: result.audio.sampleRate
        });
        s.sink({ kind: 'done', requestId, sentenceIndex, duration: result.audio.duration });
      } else {
        console.error(`[StreamScheduler] Sentence ${sentenceIndex} failed:`, result.error);
        s.sink({ kind: 'failed', requestId, sentenceIndex, error: result.error });
      }
      pump(s);
    });
}

export const streamScheduler = {
  start,
  reportPlayhead,
  stop,
  isActive,
  activeIds
};

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
 *   {kind:'failed',   requestId, sentenceIndex, error}
 *   {kind:'complete', requestId}                            // nothing left to generate
 *   {kind:'cancelled',requestId}                            // stopped or preempted by a new start
 */

import { BrowserWindow } from 'electron';
import {
  PlaySettings,
  StreamChunk
} from './xtts-worker-pool';
import { STREAM_RAMP_WIDTH } from './orpheus-worker-pool';
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
// The ramp is a claim on ONE batch, so the scheduler has to keep read-ahead from
// widening it (rampPendingOnPriority / the fill budget in pump). The pool batches from
// a SINGLE queue shared by every session: flushBatch fills to STREAM_BATCH_WIDTH,
// priority rows first. So 8 ramp rows plus any background rows sitting in that queue
// when the flush fires go out as one width-16 batch — the same ~40s the ramp exists to
// avoid, with the ramp's own rows no earlier than before. That is the COMMON case on a
// cold start, not a corner: the extension fires read-ahead speaks milliseconds after
// the playing one, all of them then wait out the same model load, and every session
// starts within the same instant of each other.
//
// So while a playing session has a ramp wave out with nothing back from it yet, what
// read-ahead faces is a BUDGET, not a total block: background sessions may dispatch up
// to (STREAM_RAMP_WIDTH − the wave's size) rows, in sessions-map order, which is
// reading order. The ramp batch still goes out at width ≤ 8; what changes is what
// rides in it.
//
// It has to be a budget because the wave is capped by the PLAYING BLOCK'S OWN LENGTH,
// not by STREAM_RAMP_WIDTH. A 2-3 sentence blog paragraph — the common shape of a
// page, not a corner — ramps to 2-3 rows: a first burst carrying ~25s of audio, all of
// it the block already being heard, with the next block's opening sentences left to
// wait out the FOLLOWING full-width batch. Measured 2026-08-10: an audible ~15s gap
// between paragraph 1 and paragraph 2. Filling the rest of that batch with the next
// block's openers banks their audio inside the ~28s the ramp was already spending. A
// playing block with ≥8 sentences leaves budget 0 and behaves exactly as before.
//
// The budget lasts exactly until the ramp batch's first row retires, by which time the
// worker is busy with that batch and any released rows would have queued for the NEXT
// flush anyway. It is on new dispatches only — rows already in flight when a playing
// session appears are untouched (the check lives in pump, which is only ever about what
// to send next), so the warm case, where read-ahead is already mid-batch, never stalls.
//
// The "MLX needs one narrow fixed warmed shape" rationale that once justified small
// batches everywhere is obsolete: mlx-lm 0.31.3 right-pads batch prefills, so widths
// may vary freely; an unwarmed width just compiles lazily (~10s, once). The worker
// pre-warms width 1, the ramp width and the full width — the ramp is warmed because
// a lazy compile in front of the first sentence is exactly what it exists to avoid,
// while a stray intermediate width (a block's short tail group) still compiles
// lazily behind a buffer that is by then many sentences deep.
//
// XTTS is the opposite physics and keeps its ONE streamed opener (see
// shouldStreamSentence): true token streaming gives sub-3s first audio, and its
// multi-worker pool already runs faster than realtime, so nothing downstream waits.
// It is not a batching engine, so the ramp never applies to it.

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
  /** How many of this session's sentences are dispatched-but-not-resolved on the
   *  streaming path — so cancelling it knows to call cancelStreaming (only
   *  priority sessions on a NON-batching engine ever stream). A COUNT, not a flag:
   *  it survived the era of multiple streamed openers, and it stays a count because
   *  a boolean cleared by the first resolver would leak an uncancelled stream if the
   *  opener policy ever widens again. */
  streamingCount: number;
  /** Has ANY dispatched sentence come back yet — done OR failed? Not derivable from
   *  `durations`, which only records successes: a first wave that failed every row
   *  would leave that map empty forever and hold read-ahead behind a batch that is
   *  already over. Set in both branches of dispatch; only ever false→true. */
  firstResultSeen: boolean;
  /** Generate-ahead window for this session (seconds ahead of the playhead). */
  lookaheadSeconds: number;
}

/** Every generating session, keyed by requestId. */
const sessions = new Map<string | number, SchedulerSession>();

/** Rows background sessions have already contributed to the CURRENT ramp window — the
 *  fill riding in the ramp's own batch (see the first-batch ramp note above). Counted
 *  across all background sessions, because the budget is a property of the one batch
 *  they are all filling. Reset when the window closes: the playing session's first
 *  result, or the death of the session holding the ramp. */
let rampFillDispatched = 0;

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
    streamingCount: 0,
    firstResultSeen: false,
    lookaheadSeconds: opts.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS
  };
  sessions.set(requestId, s);

  console.log(`[StreamScheduler] Start req=${requestId} ${priority ? 'play' : 'prefetch'} from sentence ${startIndex}/${sentences.length}${preempt ? ' (preempt)' : ''}`);
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
  // Was this the session read-ahead is being held behind? If it dies with its ramp
  // wave unanswered — cancelled, preempted by a new play action, stopped by the user
  // — nothing else will ever report that first result, so the ramp window has to be
  // closed here or background generation stays on its fill budget forever.
  const heldTheRamp = s.priority && !s.firstResultSeen && s.nextToDispatch > s.startIndex;
  s.stopped = true;
  sessions.delete(s.requestId);
  // Only the playing session ever streams, so cancel streaming only when this
  // session has one of its openers mid-stream — otherwise we'd abort an unrelated
  // session's sentence (cancelStreaming hits every streaming worker).
  if (s.streamingCount > 0) getActiveEngine().cancelStreaming();
  // This session's rows may be the last live ones in the engine's in-flight batch —
  // and on a serial batching engine (Orpheus) that batch is 30-43s of work whose
  // results are now discarded on arrival, with the next voice load and the next
  // block's batch queued behind it. Ask the engine to abandon it. It refuses unless
  // EVERY outstanding row is stale, so a batch still carrying another session's
  // sentences is untouched — which is why this must come AFTER `s.stopped` and the
  // map removal above (the staleness predicates read exactly that state).
  getActiveEngine().cancelPendingBatchIfStale?.();
  if (!s.completeSent) s.sink({ kind: 'cancelled', requestId: s.requestId });
  // After the session is out of the map, so rampPendingOnPriority() sees the truth.
  // (Harmless inside stopAll: a session it has already stopped pumps to nothing, and
  // one it is about to stop can only dispatch rows that isStale() then drops.)
  if (heldTheRamp) {
    if (!rampPendingOnPriority()) rampFillDispatched = 0;
    pumpBackgroundSessions();
  }
}

/** Is a playing session's first (ramped) wave out with nothing back from it yet?
 *
 *  That is the window in which a background row entering the pool's queue would be
 *  packed into the ramp's own batch and widen it — see the first-batch ramp note at
 *  the top of this file. `nextToDispatch > startIndex` is what makes it "out": a
 *  priority session that has not dispatched anything holds nobody up (and one with
 *  no sentences at all never would, so this cannot deadlock on it). */
function rampPendingOnPriority(): boolean {
  for (const s of sessions.values()) {
    if (s.priority && !s.stopped && !s.firstResultSeen && s.nextToDispatch > s.startIndex) {
      return true;
    }
  }
  return false;
}

/** How many rows the pending ramp wave has in flight, summed over every session
 *  holding one (normally exactly one session, and normally its entire first wave).
 *  This is what the fill budget is measured against: the ramp's batch has room for
 *  STREAM_RAMP_WIDTH rows, the wave claims this many, and the remainder is read-ahead's
 *  to fill. Same predicate as rampPendingOnPriority — a session that is not holding a
 *  ramp contributes nothing to the width the ramp is claiming. */
function rampWaveInFlight(): number {
  let total = 0;
  for (const s of sessions.values()) {
    if (s.priority && !s.stopped && !s.firstResultSeen && s.nextToDispatch > s.startIndex) {
      total += s.inFlight.size;
    }
  }
  return total;
}

/** The ramp window closed (its first row landed, or the session holding it died):
 *  re-pump read-ahead. Safe to call at any time — pump re-checks the hold itself. */
function pumpBackgroundSessions(): void {
  for (const s of [...sessions.values()]) {
    if (!s.priority) pump(s);
  }
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
  // here (16 — see orpheus-worker-pool.ts STREAM_BATCH_WIDTH); XTTS reports its
  // worker count. We dispatch a whole batch's worth at once so the engine's batch
  // goes out FULL — a partly-filled MLX batch costs the same wall clock as a full
  // one, so anything less is throughput thrown away.
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

  // …and while that ramp wave is unanswered, read-ahead dispatches against a BUDGET
  // rather than freely: the pool would otherwise pack these rows into the ramp's own
  // batch and widen it back to 16, but the wave is capped by the playing block's length
  // and is often far short of STREAM_RAMP_WIDTH, so the room it leaves is filled with
  // the next blocks' openers instead of wasted (see the first-batch ramp note above).
  // Background sessions are pumped in sessions-map order, which is reading order, so
  // the fill is the audio that plays next.
  const fillingRamp = batching && !s.priority && rampPendingOnPriority();
  // The wave cannot change while the window is open (its rows only leave in flight by
  // reporting a result, which closes the window), so measure it once per pump.
  const rampFillBudget = fillingRamp
    ? Math.max(0, STREAM_RAMP_WIDTH - rampWaveInFlight())
    : 0;

  while (
    s.inFlight.size < cap &&
    s.nextToDispatch < s.sentences.length &&
    bufferedSecondsAhead(s) < s.lookaheadSeconds
  ) {
    // Breaks rather than returning, so a background session that has already delivered
    // everything still reports 'complete' below — withholding a terminal event would
    // leave the client's read-ahead slot occupied by a block that is actually finished.
    // Rows already in flight are unaffected either way.
    if (fillingRamp && rampFillDispatched >= rampFillBudget) break;
    dispatch(s, s.nextToDispatch++);
    if (fillingRamp) rampFillDispatched++;
  }

  // Everything generated and delivered? (No ramp release needed on this path: to get
  // here a session either dispatched nothing — never a hold — or had every dispatched
  // row come back, which set firstResultSeen; and it leaves the map either way.)
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

/** Whether to generate this sentence via the low-latency streaming path (vs the
 *  batched path). Only the playing session's FIRST sentence ever streams, and only
 *  on an engine whose streaming is genuinely faster than its batch: XTTS emits
 *  sub-sentence chunks, so audio starts in ~2-3s, and its multi-worker pool renders
 *  the rest above realtime behind it. Streaming costs ~37% more compute, so every
 *  later sentence — and all background read-ahead — uses batch inference.
 *
 *  A BATCHING engine (Orpheus — it reports getMaxConcurrentSentences) streams
 *  NOTHING. Its "stream" is a whole-sentence solo render at 0.73x realtime, so
 *  pulling openers out of the batch delays the first batch by ~10s each for ~7.5s of
 *  audio; with the client gating playback on a real cushion, batching everything
 *  gets the block ready ~15-20s sooner. See the batching block at the top. */
function shouldStreamSentence(s: SchedulerSession, sentenceIndex: number): boolean {
  const engine = getActiveEngine();
  if (!s.priority || typeof engine.generateSentenceStream !== 'function') return false;
  if (typeof engine.getMaxConcurrentSentences === 'function') return false; // batching engine
  return sentenceIndex < s.startIndex + 1;
}

/** A dispatched sentence came back — done or failed, the distinction doesn't matter
 *  here. The FIRST one on a playing session closes the ramp window: the pool is now
 *  demonstrably working on that batch, so read-ahead can queue for the next flush. */
function noteResult(s: SchedulerSession): void {
  if (s.firstResultSeen) return;
  s.firstResultSeen = true;
  if (s.priority) {
    // Window closed — unless another playing session is holding a ramp of its own (rare,
    // but the counter belongs to whichever window is open, so guard it). The next ramp
    // gets a fresh fill budget.
    if (!rampPendingOnPriority()) rampFillDispatched = 0;
    pumpBackgroundSessions();
  }
}

function dispatch(s: SchedulerSession, sentenceIndex: number): void {
  const requestId = s.requestId;
  const text = s.sentences[sentenceIndex];
  const isStale = () => sessions.get(requestId) !== s || s.stopped;
  s.inFlight.add(sentenceIndex);

  // XTTS only: the opening sentence streams so audio starts in ~2-3s.
  if (shouldStreamSentence(s, sentenceIndex)) {
    s.streamingCount++;
    void getActiveEngine()
      .generateSentenceStream(text, s.settings, (chunk: StreamChunk) => {
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
      }, isStale)
      .then((result) => {
        s.streamingCount--;
        if (isStale()) return;
        s.inFlight.delete(sentenceIndex);
        if (result.success && !result.cancelled) {
          s.durations.set(sentenceIndex, result.duration || 0);
          s.sink({ kind: 'done', requestId, sentenceIndex, duration: result.duration || 0 });
        } else if (!result.success) {
          console.error(`[StreamScheduler] Stream sentence ${sentenceIndex} failed:`, result.error);
          s.sink({ kind: 'failed', requestId, sentenceIndex, error: result.error });
        }
        noteResult(s);
        pump(s);
      });
    return;
  }

  void getActiveEngine()
    .generateSentence(text, sentenceIndex, s.settings, s.priority, isStale)
    .then((result) => {
      if (isStale()) return;
      s.inFlight.delete(sentenceIndex);
      if (result.success && result.audio) {
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
      // Before pump(s): a first result on a playing session releases read-ahead, and
      // it must be released whether this row succeeded or failed.
      noteResult(s);
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

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

// Warmup ramp (batching engines only — e.g. Orpheus). A wide batch is slow to
// produce its FIRST item (the GPU is split across all rows), so kicking a reading
// session straight into a wide batch (64 on Mac, 96 on NVIDIA) stalls playback
// right after the opening sentence. Instead, stream sentences ONE AT A TIME —
// far lower per-sentence
// latency — until this much audio is buffered ahead of the playhead (≈ the first
// paragraph/section), THEN switch to batched read-ahead and let it run flat-out
// while the reader listens. Platform-agnostic: same ramp on Mac/MLX and
// Windows/NVIDIA. The knob trades time-to-steady-state (lower = batch sooner) for
// stall-resistance at the hand-off (higher = deeper cushion). Per-sentence
// streaming costs ~37% more compute, so this is bounded buffer, not the whole job.
const STREAM_WARMUP_SECONDS = 30;

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
   *  priority and whether the first sentence streams. Flips to true when a
   *  playhead is reported (the client started playing this block). */
  priority: boolean;
  /** True while this session's first sentence is mid-stream — so cancelling it
   *  knows to call cancelStreaming (only priority sessions ever stream). */
  streaming: boolean;
  /** Warmup ramp (batching engines): while true, the playing session streams
   *  sentences one at a time for low first-audio latency. Flips false once
   *  STREAM_WARMUP_SECONDS of audio is buffered ahead, after which the remainder
   *  is batched. Never set for background read-ahead (those batch immediately). */
  warmup: boolean;
  /** Generate-ahead window for this session (seconds ahead of the playhead). */
  lookaheadSeconds: number;
}

/** Every generating session, keyed by requestId. */
const sessions = new Map<string | number, SchedulerSession>();

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
    streaming: false,
    warmup: true,
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
  // Only the playing session ever streams, so cancel streaming only when this
  // session is the one mid-stream — otherwise we'd abort an unrelated session's
  // first sentence (cancelStreaming hits every streaming worker).
  if (s.streaming) getActiveEngine().cancelStreaming();
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

  // Warmup ramp (batching engines, playing session only): stream sentences one at
  // a time until STREAM_WARMUP_SECONDS is buffered ahead, so the reader hears the
  // opening fast without stalling on a wide batch's first-item latency. Only ONE
  // stream runs at a time; each completion re-pumps to stream the next. See
  // STREAM_WARMUP_SECONDS and shouldStreamSentence().
  if (
    s.warmup &&
    s.priority &&
    typeof engine.generateSentenceStream === 'function' &&
    typeof engine.getMaxConcurrentSentences === 'function' &&
    bufferedSecondsAhead(s) < STREAM_WARMUP_SECONDS &&
    s.nextToDispatch < s.sentences.length
  ) {
    if (s.inFlight.size === 0 && bufferedSecondsAhead(s) < s.lookaheadSeconds) {
      dispatch(s, s.nextToDispatch++);
    }
    return; // hold off on batching until the cushion is built (or sentences run out)
  }
  s.warmup = false; // breathing room reached → batch the rest while the reader listens

  // In-flight cap: a batching engine (Orpheus) reports its batch size here so we
  // dispatch a batch's worth of sentences at once for the pool to coalesce into one
  // vLLM/MLX call; XTTS reports its worker count. (Falls back to worker count.)
  const inFlightCap = engine.getMaxConcurrentSentences?.() ?? engine.getWorkerCount();
  while (
    s.inFlight.size < inFlightCap &&
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

/** Whether to generate this sentence via the low-latency streaming path (vs the
 *  batched path). Only the playing session ever streams. Batching engines (Orpheus)
 *  stream throughout the warmup ramp; non-batching engines (XTTS) just stream the
 *  first sentence as before. Streaming costs ~37% more compute, so everything else
 *  — lookahead past warmup, and all background read-ahead — uses batch inference. */
function shouldStreamSentence(s: SchedulerSession, sentenceIndex: number): boolean {
  const engine = getActiveEngine();
  if (!s.priority || typeof engine.generateSentenceStream !== 'function') return false;
  if (typeof engine.getMaxConcurrentSentences === 'function') return s.warmup;
  return sentenceIndex === s.startIndex;
}

function dispatch(s: SchedulerSession, sentenceIndex: number): void {
  const requestId = s.requestId;
  const text = s.sentences[sentenceIndex];
  const isStale = () => sessions.get(requestId) !== s || s.stopped;
  s.inFlight.add(sentenceIndex);

  // Audio starts in ~2-3s and stays ahead of the reader during warmup.
  if (shouldStreamSentence(s, sentenceIndex)) {
    s.streaming = true;
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
        s.streaming = false;
        if (isStale()) return;
        s.inFlight.delete(sentenceIndex);
        if (result.success && !result.cancelled) {
          s.durations.set(sentenceIndex, result.duration || 0);
          s.sink({ kind: 'done', requestId, sentenceIndex, duration: result.duration || 0 });
        } else if (!result.success) {
          console.error(`[StreamScheduler] Stream sentence ${sentenceIndex} failed:`, result.error);
          s.sink({ kind: 'failed', requestId, sentenceIndex, error: result.error });
        }
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
      pump(s);
    });
}

export const streamScheduler = {
  start,
  reportPlayhead,
  stop,
  isActive
};

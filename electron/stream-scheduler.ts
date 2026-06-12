/**
 * Stream Scheduler - main-process orchestration for Play/Stream TTS playback
 *
 * Owns the sentence queue for a listening session: streams the first sentence
 * chunk-by-chunk for fast time-to-first-audio (~2-3s), fills lookahead with
 * batch generations across the worker pool, and throttles generation to a
 * seconds-based window ahead of the renderer-reported playhead.
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
  xttsWorkerPool,
  PlaySettings,
  StreamChunk
} from './xtts-worker-pool';

/** Where a session's events go. Defaults to broadcasting to all windows. */
export type StreamSink = (data: Record<string, unknown>) => void;

// Generate until this much audio is buffered ahead of the playhead, then idle
// until the playhead advances. Sized to fully buffer a short article up front
// (~2000s ≈ 5000 spoken words) so a whole page can play through without underruns;
// the worker pool generates flat-out until the window is full, then idles. For the
// common per-block path each request is a single paragraph that finishes well
// inside this window; the large cap only matters when one request is a long
// selection. Memory is the client's concern — see PREFETCH_LOOKAHEAD_SECONDS.
const LOOKAHEAD_SECONDS = 2000;

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
}

let session: SchedulerSession | null = null;

function broadcastToWindows(data: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('stream:event', data);
    }
  }
}

/**
 * Start (or restart) generation. requestId is caller-supplied so the renderer
 * can filter events for the session it asked for; a new start invalidates all
 * in-flight work from previous ones.
 */
export function start(
  sentences: string[],
  startIndex: number,
  settings: PlaySettings,
  requestId: string | number,
  sink: StreamSink = broadcastToWindows
): { success: boolean; error?: string } {
  if (!xttsWorkerPool.isSessionActive()) {
    return { success: false, error: 'TTS session not active' };
  }

  stop();

  session = {
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
    sink
  };

  console.log(`[StreamScheduler] Start req=${requestId} from sentence ${startIndex}/${sentences.length}`);
  pump();
  return { success: true };
}

/** Renderer reports playback position so the lookahead window can advance. */
export function reportPlayhead(sentenceIndex: number): void {
  if (!session || session.stopped) return;
  if (sentenceIndex > session.playhead) {
    session.playhead = sentenceIndex;
    pump();
  }
}

/** Stop generating. In-flight streaming is cancelled; batch results are dropped. */
export function stop(): void {
  if (session && !session.stopped) {
    console.log(`[StreamScheduler] Stop req=${session.requestId}`);
    session.stopped = true;
    xttsWorkerPool.cancelStreaming();
    if (!session.completeSent) {
      session.sink({ kind: 'cancelled', requestId: session.requestId });
    }
  }
}

/** requestId of the session currently generating, or null. Lets external
 *  callers (TTS API server) verify ownership before stopping. */
export function getActiveRequestId(): string | number | null {
  return session && !session.stopped ? session.requestId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds of generated-but-not-yet-played audio ahead of the playhead. */
function bufferedSecondsAhead(s: SchedulerSession): number {
  let total = 0;
  for (const [index, duration] of s.durations) {
    if (index >= s.playhead) total += duration;
  }
  return total;
}

function pump(): void {
  const s = session;
  if (!s || s.stopped) return;

  while (
    s.inFlight.size < xttsWorkerPool.getWorkerCount() &&
    s.nextToDispatch < s.sentences.length &&
    bufferedSecondsAhead(s) < LOOKAHEAD_SECONDS
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
    s.sink({ kind: 'complete', requestId: s.requestId });
  }
}

function dispatch(s: SchedulerSession, sentenceIndex: number): void {
  const requestId = s.requestId;
  const text = s.sentences[sentenceIndex];
  const isStale = () => !session || session.requestId !== requestId || session.stopped;
  s.inFlight.add(sentenceIndex);

  // The playhead sentence streams so audio starts in ~2-3s. Streaming costs
  // ~37% more compute than batch, so lookahead sentences use batch inference.
  if (sentenceIndex === s.startIndex) {
    void xttsWorkerPool
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
      })
      .then((result) => {
        if (isStale()) return;
        s.inFlight.delete(sentenceIndex);
        if (result.success && !result.cancelled) {
          s.durations.set(sentenceIndex, result.duration || 0);
          s.sink({ kind: 'done', requestId, sentenceIndex, duration: result.duration || 0 });
        } else if (!result.success) {
          console.error(`[StreamScheduler] Stream sentence ${sentenceIndex} failed:`, result.error);
          s.sink({ kind: 'failed', requestId, sentenceIndex, error: result.error });
        }
        pump();
      });
    return;
  }

  void xttsWorkerPool
    .generateSentence(text, sentenceIndex, s.settings)
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
      pump();
    });
}

export const streamScheduler = {
  start,
  reportPlayhead,
  stop,
  getActiveRequestId
};

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
 * All events go out on the single 'stream:event' channel:
 *   {kind:'chunk',   requestId, sentenceIndex, seq, data(pcm16 b64), duration, sampleRate}
 *   {kind:'done',    requestId, sentenceIndex, duration}   // sentence fully generated
 *   {kind:'failed',  requestId, sentenceIndex, error}
 *   {kind:'complete',requestId}                            // nothing left to generate
 */

import { BrowserWindow } from 'electron';
import {
  xttsWorkerPool,
  PlaySettings,
  StreamChunk
} from './xtts-worker-pool';

// Generate until this much audio is buffered ahead of the playhead, then idle
// until the playhead advances. ~2.1x realtime aggregate means the window
// fills fast and workers spend most of the session idle (cool and quiet).
const LOOKAHEAD_SECONDS = 45;

interface SchedulerSession {
  requestId: number;
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
}

let session: SchedulerSession | null = null;

function broadcast(data: Record<string, unknown>): void {
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
  requestId: number
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
    completeSent: false
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
  }
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
    broadcast({ kind: 'complete', requestId: s.requestId });
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
        broadcast({
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
          broadcast({ kind: 'done', requestId, sentenceIndex, duration: result.duration || 0 });
        } else if (!result.success) {
          console.error(`[StreamScheduler] Stream sentence ${sentenceIndex} failed:`, result.error);
          broadcast({ kind: 'failed', requestId, sentenceIndex, error: result.error });
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
        broadcast({
          kind: 'chunk',
          requestId,
          sentenceIndex,
          seq: 0,
          data: result.audio.data,
          duration: result.audio.duration,
          sampleRate: result.audio.sampleRate
        });
        broadcast({ kind: 'done', requestId, sentenceIndex, duration: result.audio.duration });
      } else {
        console.error(`[StreamScheduler] Sentence ${sentenceIndex} failed:`, result.error);
        broadcast({ kind: 'failed', requestId, sentenceIndex, error: result.error });
      }
      pump();
    });
}

export const streamScheduler = {
  start,
  reportPlayhead,
  stop
};

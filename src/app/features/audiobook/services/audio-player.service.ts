import { Injectable, signal, computed } from '@angular/core';
import { PlaybackState } from '../models/play.types';

/**
 * AudioPlayerService - gapless Web Audio playback for streamed TTS audio
 *
 * Ingests base64 PCM16 chunks from the main-process stream scheduler
 * ('chunk' events: pieces of the streamed playhead sentence, or whole
 * lookahead sentences) and schedules them sample-accurately on the
 * AudioContext timeline - no onended chaining, no inter-sentence gaps.
 *
 * Buffering policy (seconds-based, not sentence counts):
 * - Start once the first sentence is fully generated (its chunks are already
 *   decoded and scheduled, so playback begins the instant 'done' arrives), or
 *   earlier if chunks are arriving faster than realtime (GPU machines).
 * - After an underrun, rebuild REBUILD_SECONDS of headroom before resuming so
 *   a slow stretch doesn't degrade into a gap after every sentence.
 */
@Injectable({
  providedIn: 'root'
})
export class AudioPlayerService {
  private audioContext: AudioContext | null = null;

  // ── Assembly state (ordered segments built from out-of-order events) ──
  private segments: Array<{ sentenceIndex: number; buffer: AudioBuffer }> = [];
  private pendingSentences = new Map<number, {
    chunks: AudioBuffer[];
    appendedCount: number;
    done: boolean;
  }>();
  private expectedNext = 0;     // next sentence index to release into segments
  private startIndex = 0;       // first sentence of this stream
  private generationDone = false;
  private streamStartedAt = 0;  // performance.now() when beginStream was called
  private bufferedAudioSec = 0; // total audio received this stream (for rate estimate)

  // ── Scheduling state ──
  private nextSegmentToSchedule = 0;
  private scheduledThrough = 0;   // context time when the last scheduled segment ends
  private chainAnchored = false;  // false -> next schedule re-anchors at currentTime
  private activeSources: Array<{
    source: AudioBufferSourceNode;
    sentenceIndex: number;
    startAt: number;
    endAt: number;
  }> = [];

  private started = false;       // has playback begun for this stream
  private wantToPlay = false;    // user intent: resume automatically when buffered

  private static readonly REBUILD_SECONDS = 8;
  private static readonly SCHEDULE_AHEAD_SECONDS = 60;
  // First-start cushion: wait for ~2 sentences before playing, or this much
  // buffered audio if one sentence is long (so we don't stall on a huge sentence).
  private static readonly START_MIN_SENTENCES = 2;
  private static readonly START_MIN_SECONDS = 6;

  // Reactive state
  readonly playbackState = signal<PlaybackState>('idle');
  readonly currentSentenceIndex = signal<number>(-1);
  readonly currentTime = signal<number>(0);
  readonly totalDuration = signal<number>(0);
  /** Seconds of decoded audio ahead of the playhead (drives the buffer ring). */
  readonly bufferedAhead = signal<number>(0);
  /** True once the scheduler reported there is nothing left to generate. */
  readonly generationFinished = signal<boolean>(false);

  // Computed
  readonly isPlaying = computed(() => this.playbackState() === 'playing');
  readonly isPaused = computed(() => this.playbackState() === 'paused');
  readonly isIdle = computed(() => this.playbackState() === 'idle');

  // Callbacks
  private onSentenceChangeCallback?: (index: number) => void;
  private onPlaybackEndCallback?: () => void;

  constructor() {
    setInterval(() => this.tick(), 200);
  }

  /**
   * Initialize audio context (must be called from user gesture)
   */
  async initialize(): Promise<void> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  onSentenceChange(callback: (index: number) => void): void {
    this.onSentenceChangeCallback = callback;
  }

  onPlaybackEnd(callback: () => void): void {
    this.onPlaybackEndCallback = callback;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream ingestion (called from stream:event handlers)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Reset assembly state for a new stream starting at the given sentence. */
  beginStream(startIndex: number): void {
    this.resetPlayback();
    this.segments = [];
    this.pendingSentences.clear();
    this.expectedNext = startIndex;
    this.startIndex = startIndex;
    this.generationDone = false;
    this.generationFinished.set(false);
    this.started = false;
    this.streamStartedAt = performance.now();
    this.bufferedAudioSec = 0;
    this.bufferedAhead.set(0);
    this.wantToPlay = true;
    this.playbackState.set('buffering');
  }

  /** Ingest one PCM16 chunk (piece of streamed sentence, or whole sentence). */
  addChunk(sentenceIndex: number, base64Pcm: string, sampleRate: number): void {
    if (!this.audioContext) return;
    const buffer = this.decodePcm16(base64Pcm, sampleRate);
    if (!buffer) return;

    this.bufferedAudioSec += buffer.duration;

    let pending = this.pendingSentences.get(sentenceIndex);
    if (!pending) {
      pending = { chunks: [], appendedCount: 0, done: false };
      this.pendingSentences.set(sentenceIndex, pending);
    }
    pending.chunks.push(buffer);

    // The expected sentence releases chunks immediately (live streaming);
    // later sentences are held until everything before them is complete.
    this.flushReadySentences();
    this.maybeStartOrResume();
  }

  /** A sentence finished generating - release it (and any complete followers). */
  markSentenceDone(sentenceIndex: number): void {
    const pending = this.pendingSentences.get(sentenceIndex);
    if (pending) {
      pending.done = true;
    } else {
      // Done with no chunks (shouldn't happen) - record as empty so ordering advances
      this.pendingSentences.set(sentenceIndex, { chunks: [], appendedCount: 0, done: true });
    }
    this.flushReadySentences();
    this.maybeStartOrResume();
  }

  /** A sentence failed - skip it so playback ordering can continue. */
  markSentenceFailed(sentenceIndex: number): void {
    this.pendingSentences.set(sentenceIndex, { chunks: [], appendedCount: 0, done: true });
    this.flushReadySentences();
    this.maybeStartOrResume();
  }

  /** Nothing left to generate for this stream. */
  generationComplete(): void {
    this.generationDone = true;
    this.generationFinished.set(true);

    // Nothing buffered and nothing coming -> the stream is over
    if (
      this.playbackState() === 'buffering' &&
      this.nextSegmentToSchedule >= this.segments.length &&
      this.pendingSentences.size === 0
    ) {
      this.playbackState.set('idle');
      this.onPlaybackEndCallback?.();
      return;
    }

    this.maybeStartOrResume();
    this.tick();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Transport
  // ─────────────────────────────────────────────────────────────────────────────

  play(): void {
    if (!this.audioContext) return;
    this.wantToPlay = true;

    if (this.playbackState() === 'paused') {
      if (this.started) {
        void this.audioContext.resume();
        this.playbackState.set('playing');
        this.scheduleSegments();
      } else {
        this.playbackState.set('buffering');
        this.maybeStartOrResume();
      }
    }
  }

  pause(): void {
    this.wantToPlay = false;
    if (this.playbackState() === 'playing') {
      void this.audioContext?.suspend();
    }
    if (this.playbackState() === 'playing' || this.playbackState() === 'buffering') {
      this.playbackState.set('paused');
    }
  }

  /** Stop playback and discard all audio (seeks restart the stream). */
  stop(): void {
    this.wantToPlay = false;
    this.resetPlayback();
    this.playbackState.set('idle');
    this.currentSentenceIndex.set(-1);
    this.currentTime.set(0);
  }

  clearQueue(): void {
    this.stop();
    this.segments = [];
    this.pendingSentences.clear();
    this.totalDuration.set(0);
  }

  hasBufferedAudio(): boolean {
    return this.segments.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: assembly
  // ─────────────────────────────────────────────────────────────────────────────

  private decodePcm16(base64Data: string, sampleRate: number): AudioBuffer | null {
    try {
      const binary = atob(base64Data);
      const sampleCount = binary.length / 2;
      if (sampleCount < 1) return null;

      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer, 0, sampleCount);

      const buffer = this.audioContext!.createBuffer(1, sampleCount, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        channel[i] = int16[i] / 32768;
      }
      return buffer;
    } catch (error) {
      console.error('[AudioPlayer] Failed to decode PCM16 chunk:', error);
      return null;
    }
  }

  /** Move chunks into the ordered segment list, strictly in sentence order. */
  private flushReadySentences(): void {
    let advanced = true;
    while (advanced) {
      advanced = false;
      const pending = this.pendingSentences.get(this.expectedNext);
      if (!pending) break;

      // Release any not-yet-appended chunks of the expected sentence
      while (pending.appendedCount < pending.chunks.length) {
        this.segments.push({
          sentenceIndex: this.expectedNext,
          buffer: pending.chunks[pending.appendedCount]
        });
        pending.appendedCount++;
      }

      if (pending.done) {
        this.pendingSentences.delete(this.expectedNext);
        this.expectedNext++;
        advanced = true;
      }
    }

    this.totalDuration.set(this.segments.reduce((sum, s) => sum + s.buffer.duration, 0));

    if (this.playbackState() === 'playing') {
      this.scheduleSegments();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: scheduling
  // ─────────────────────────────────────────────────────────────────────────────

  /** Seconds of decoded audio not yet played (scheduled remainder + unscheduled). */
  private bufferedAheadSeconds(): number {
    if (!this.audioContext) return 0;
    let total = 0;
    if (this.chainAnchored) {
      total += Math.max(0, this.scheduledThrough - this.audioContext.currentTime);
    }
    for (let i = this.nextSegmentToSchedule; i < this.segments.length; i++) {
      total += this.segments[i].buffer.duration;
    }
    return total;
  }

  /** Estimated generation speed (audio seconds per wall second) for this stream. */
  private generationRate(): number {
    const elapsed = (performance.now() - this.streamStartedAt) / 1000;
    return elapsed > 1 ? this.bufferedAudioSec / elapsed : 0;
  }

  /**
   * Decide whether to begin (or resume after underrun). Initial start waits
   * for the first sentence to be complete - on CPU chunks arrive slower than
   * realtime, so starting on the first chunk would stutter mid-sentence -
   * unless generation is measurably faster than realtime (GPU).
   */
  private maybeStartOrResume(): void {
    if (!this.wantToPlay || !this.audioContext) return;
    if (this.playbackState() !== 'buffering') return;
    if (this.nextSegmentToSchedule >= this.segments.length) return;

    const buffered = this.bufferedAheadSeconds();

    let ready: boolean;
    if (!this.started) {
      // Hold for a small cushion before the first note so a quick first sentence
      // doesn't start then immediately underrun while the next one generates:
      // wait for ~2 sentences, OR enough buffered audio (covers a long single
      // sentence), OR generation outpacing playback, OR the whole clip is ready.
      const sentencesReady = this.expectedNext - this.startIndex;
      const enoughSentences = sentencesReady >= AudioPlayerService.START_MIN_SENTENCES;
      const enoughAudio = buffered >= AudioPlayerService.START_MIN_SECONDS;
      const outpacingPlayback = this.generationRate() > 1.1 && buffered >= 1.0;
      ready = enoughSentences || enoughAudio || outpacingPlayback || this.generationDone;
    } else {
      // Mid-stream underrun: rebuild real headroom before resuming
      ready = buffered >= AudioPlayerService.REBUILD_SECONDS || this.generationDone;
    }

    if (!ready) return;

    this.started = true;
    this.playbackState.set('playing');
    void this.audioContext.resume();
    this.scheduleSegments();
  }

  /** Schedule pending segments back-to-back on the context timeline. */
  private scheduleSegments(): void {
    const ctx = this.audioContext;
    if (!ctx) return;

    while (this.nextSegmentToSchedule < this.segments.length) {
      if (!this.chainAnchored) {
        // (Re)anchor the chain slightly in the future
        this.scheduledThrough = ctx.currentTime + 0.06;
        this.chainAnchored = true;
      } else if (this.scheduledThrough - ctx.currentTime > AudioPlayerService.SCHEDULE_AHEAD_SECONDS) {
        break;
      }

      const segment = this.segments[this.nextSegmentToSchedule];
      const source = ctx.createBufferSource();
      source.buffer = segment.buffer;
      source.connect(ctx.destination);

      const startAt = this.scheduledThrough;
      const endAt = startAt + segment.buffer.duration;
      source.start(startAt);

      this.activeSources.push({
        source,
        sentenceIndex: segment.sentenceIndex,
        startAt,
        endAt
      });

      this.scheduledThrough = endAt;
      this.nextSegmentToSchedule++;
    }
  }

  private resetPlayback(): void {
    for (const active of this.activeSources) {
      try {
        active.source.stop();
        active.source.disconnect();
      } catch { /* already stopped */ }
    }
    this.activeSources = [];
    this.nextSegmentToSchedule = 0;
    this.scheduledThrough = 0;
    this.chainAnchored = false;
    this.started = false;
    // Leave the context running; suspended contexts are resumed on next play
    if (this.audioContext?.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  /** Periodic: track the playing sentence, detect underrun / end of stream. */
  private tick(): void {
    const ctx = this.audioContext;
    // Keep the buffer ring live in every active state (it should climb while
    // buffering/paused too). Idle reports 0: resetPlayback rewinds the schedule
    // cursor, so the ahead-sum over segments would falsely read as full.
    const state = this.playbackState();
    this.bufferedAhead.set(state === 'idle' ? 0 : this.bufferedAheadSeconds());
    if (!ctx || state !== 'playing') return;

    const now = ctx.currentTime;

    // Drop sources that already finished
    while (this.activeSources.length > 0 && this.activeSources[0].endAt <= now) {
      this.activeSources.shift();
    }

    // Current sentence = the segment whose window contains the clock
    const current = this.activeSources.find(a => a.startAt <= now && now < a.endAt);
    if (current && current.sentenceIndex !== this.currentSentenceIndex()) {
      this.currentSentenceIndex.set(current.sentenceIndex);
      this.onSentenceChangeCallback?.(current.sentenceIndex);
    }
    this.currentTime.set(now);

    this.scheduleSegments();

    // Out of scheduled audio?
    const exhausted =
      this.nextSegmentToSchedule >= this.segments.length &&
      now >= this.scheduledThrough - 0.05;

    if (!exhausted) return;

    const nothingPending = this.pendingSentences.size === 0;
    if (this.generationDone && nothingPending) {
      console.log('[AudioPlayer] Stream finished');
      this.playbackState.set('idle');
      this.onPlaybackEndCallback?.();
    } else {
      console.log('[AudioPlayer] Underrun - buffering until',
        AudioPlayerService.REBUILD_SECONDS, 's of headroom');
      this.chainAnchored = false;
      this.playbackState.set('buffering');
      void ctx.suspend();
    }
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    this.clearQueue();
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }
}

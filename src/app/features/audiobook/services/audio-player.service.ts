import { Injectable, signal, computed } from '@angular/core';
import { AudioChunk, PlaybackState } from '../models/play.types';

/**
 * AudioPlayerService - Web Audio API playback for TTS audio
 *
 * Handles decoding base64 WAV audio, buffering, and smooth playback
 * with support for seeking to specific sentences.
 */
@Injectable({
  providedIn: 'root'
})
export class AudioPlayerService {
  // Audio context and state
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private audioQueue: Array<{ buffer: AudioBuffer; sentenceIndex: number; duration: number }> = [];
  private currentQueueIndex = 0;
  private startTime = 0;
  private pauseTime = 0;

  // Reactive state
  readonly playbackState = signal<PlaybackState>('idle');
  readonly currentSentenceIndex = signal<number>(-1);
  readonly currentTime = signal<number>(0);
  readonly totalDuration = signal<number>(0);

  // Computed
  readonly isPlaying = computed(() => this.playbackState() === 'playing');
  readonly isPaused = computed(() => this.playbackState() === 'paused');
  readonly isIdle = computed(() => this.playbackState() === 'idle');

  // Callbacks
  private onSentenceChangeCallback?: (index: number) => void;
  private onPlaybackEndCallback?: () => void;

  // User intent - when true, auto-resume after buffering; when false, stay paused
  private wantToPlay = false;

  constructor() {
    // Update current time periodically
    setInterval(() => this.updateCurrentTime(), 100);
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

  /**
   * Set callback for sentence changes
   */
  onSentenceChange(callback: (index: number) => void): void {
    this.onSentenceChangeCallback = callback;
  }

  /**
   * Set callback for playback end
   */
  onPlaybackEnd(callback: () => void): void {
    this.onPlaybackEndCallback = callback;
  }

  /**
   * Decode and enqueue an audio chunk
   */
  async enqueueAudio(chunk: AudioChunk, sentenceIndex: number): Promise<void> {
    console.log('[AudioPlayer] Enqueueing audio for sentence', sentenceIndex, 'duration:', chunk.duration);

    if (!this.audioContext) {
      await this.initialize();
    }

    try {
      // Decode base64 WAV to AudioBuffer
      const buffer = await this.decodeBase64Wav(chunk.data);
      console.log('[AudioPlayer] Decoded buffer, duration:', buffer.duration);

      // Add to queue
      this.audioQueue.push({
        buffer,
        sentenceIndex,
        duration: buffer.duration
      });

      // Update total duration
      this.updateTotalDuration();
      console.log('[AudioPlayer] Queue length:', this.audioQueue.length, 'current index:', this.currentQueueIndex);

      // If we're waiting for audio and user wants to play, start playing
      if (this.playbackState() === 'buffering' && this.audioQueue.length > this.currentQueueIndex && this.wantToPlay) {
        console.log('[AudioPlayer] Starting playback from buffering state');
        this.playFromQueue();
      }
    } catch (error) {
      console.error('[AudioPlayer] Failed to decode audio:', error);
    }
  }

  /**
   * Start playback
   */
  play(): void {
    if (!this.audioContext) {
      console.warn('[AudioPlayer] Audio context not initialized');
      return;
    }

    this.wantToPlay = true;

    if (this.playbackState() === 'paused') {
      // Resume from pause
      this.resumeFromPause();
    } else if (this.playbackState() === 'idle' || this.playbackState() === 'buffering') {
      // Start from beginning or continue buffering
      this.playFromQueue();
    }
  }

  /**
   * Pause playback
   */
  pause(): void {
    this.wantToPlay = false;

    if (this.currentSource && this.playbackState() === 'playing') {
      this.pauseTime = this.audioContext!.currentTime - this.startTime;
      this.currentSource.stop();
      this.currentSource = null;
      this.playbackState.set('paused');
    } else if (this.playbackState() === 'buffering') {
      // Pause while waiting for audio - don't auto-resume when audio arrives
      this.playbackState.set('paused');
    }
  }

  /**
   * Stop playback and reset
   */
  stop(): void {
    this.wantToPlay = false;

    if (this.currentSource) {
      this.currentSource.stop();
      this.currentSource = null;
    }

    this.playbackState.set('idle');
    this.currentSentenceIndex.set(-1);
    this.currentTime.set(0);
    this.currentQueueIndex = 0;
    this.pauseTime = 0;
    this.startTime = 0;
  }

  /**
   * Seek to a specific sentence
   */
  seekToSentence(sentenceIndex: number): void {
    // Find the queue index for this sentence
    const queueIndex = this.audioQueue.findIndex(item => item.sentenceIndex === sentenceIndex);

    if (queueIndex === -1) {
      console.warn('[AudioPlayer] Sentence not in queue:', sentenceIndex);
      return;
    }

    // Stop current playback
    if (this.currentSource) {
      this.currentSource.stop();
      this.currentSource = null;
    }

    // Update state
    this.currentQueueIndex = queueIndex;
    this.pauseTime = 0;
    this.currentSentenceIndex.set(sentenceIndex);

    // Calculate new current time
    let time = 0;
    for (let i = 0; i < queueIndex; i++) {
      time += this.audioQueue[i].duration;
    }
    this.currentTime.set(time);

    // Resume playback if we were playing
    if (this.playbackState() === 'playing' || this.playbackState() === 'paused') {
      this.playFromQueue();
    }
  }

  /**
   * Clear the audio queue
   */
  clearQueue(): void {
    console.log('[AudioPlayer] Clearing queue, had', this.audioQueue.length, 'items');
    this.stop();
    this.audioQueue = [];
    this.totalDuration.set(0);
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.audioQueue.length;
  }

  /**
   * Check if sentence is already queued
   */
  isSentenceQueued(sentenceIndex: number): boolean {
    return this.audioQueue.some(item => item.sentenceIndex === sentenceIndex);
  }

  /**
   * Signal that generation is complete - if we're buffering with no more audio, we're done
   */
  generationComplete(): void {
    console.log('[AudioPlayer] Generation complete, state:', this.playbackState(), 'queueIndex:', this.currentQueueIndex, 'queueLength:', this.audioQueue.length);
    if (this.playbackState() === 'buffering' && this.currentQueueIndex >= this.audioQueue.length) {
      console.log('[AudioPlayer] No more audio, playback ended');
      this.playbackState.set('idle');
      this.onPlaybackEndCallback?.();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Decode base64 WAV to AudioBuffer
   */
  private async decodeBase64Wav(base64Data: string): Promise<AudioBuffer> {
    // Convert base64 to ArrayBuffer
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Decode WAV
    return await this.audioContext!.decodeAudioData(bytes.buffer);
  }

  /**
   * Play next item from queue
   */
  private playFromQueue(): void {
    const queueSentences = this.audioQueue.map(item => item.sentenceIndex);
    console.log('[AudioPlayer] playFromQueue called, queueIndex:', this.currentQueueIndex,
      'queueLength:', this.audioQueue.length, 'sentences in queue:', queueSentences);

    if (!this.audioContext) {
      console.error('[AudioPlayer] No audio context!');
      return;
    }

    if (this.currentQueueIndex >= this.audioQueue.length) {
      console.log('[AudioPlayer] Queue exhausted, waiting for more audio (buffering)');
      // No more audio in queue - wait for more (buffering state)
      // The component will call onPlaybackEnd when generation is truly complete
      this.playbackState.set('buffering');
      return;
    }

    const queueItem = this.audioQueue[this.currentQueueIndex];
    console.log('[AudioPlayer] Playing sentence', queueItem.sentenceIndex, 'duration:', queueItem.duration);

    // Create source node
    this.currentSource = this.audioContext.createBufferSource();
    this.currentSource.buffer = queueItem.buffer;
    this.currentSource.connect(this.audioContext.destination);

    // Set up end handler
    this.currentSource.onended = () => {
      console.log('[AudioPlayer] Sentence ended, state:', this.playbackState());
      if (this.playbackState() === 'playing') {
        this.currentQueueIndex++;
        this.pauseTime = 0;
        this.playFromQueue();
      }
    };

    // Start playback
    this.startTime = this.audioContext.currentTime - this.pauseTime;
    console.log('[AudioPlayer] Starting playback at', this.startTime);
    this.currentSource.start(0, this.pauseTime);
    this.playbackState.set('playing');

    // Update sentence index
    this.currentSentenceIndex.set(queueItem.sentenceIndex);
    this.onSentenceChangeCallback?.(queueItem.sentenceIndex);
  }

  /**
   * Resume from paused state
   */
  private resumeFromPause(): void {
    this.playFromQueue();
  }

  /**
   * Update current playback time
   */
  private updateCurrentTime(): void {
    if (this.playbackState() !== 'playing' || !this.audioContext) return;

    // Calculate time based on queue position and current playback
    let time = 0;
    for (let i = 0; i < this.currentQueueIndex; i++) {
      time += this.audioQueue[i].duration;
    }

    // Add current playback position
    if (this.currentSource && this.startTime > 0) {
      time += this.audioContext.currentTime - this.startTime;
    }

    this.currentTime.set(time);
  }

  /**
   * Update total duration from queue
   */
  private updateTotalDuration(): void {
    const total = this.audioQueue.reduce((sum, item) => sum + item.duration, 0);
    this.totalDuration.set(total);
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    this.stop();
    this.clearQueue();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

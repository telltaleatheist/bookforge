/**
 * ReaderPlaybackService — the streaming-TTS playback brain for the Bookshelf
 * "Listen to anything" Reader and the book "Stream / follow-along" mode. It owns
 * ONE WebSocket to the bookshelf Reader bridge (/api/reader/ws) that DRIVES
 * generation and streams PCM16 back, keeps an ordered play queue, runs concurrent
 * read-ahead of upcoming blocks, tracks per-block sentence boundaries, and drives
 * the follow-along highlight — all independent of HOW the audio is played.
 *
 * ── Two audio-output strategies (web vs native) ──────────────────────────────
 * The actual sound is produced by a pluggable {@link ReaderOutput}, chosen once at
 * construction by platform:
 *
 *   - WEB ({@link WebReaderOutput}) — the original, self-contained path: a raw
 *     `new Audio()` element (+ a Web Audio AudioContext/GainNode for >1× volume),
 *     fed a client-assembled, continuously GROWING WAV blob so playback starts
 *     mid-generation (low latency) and an in-memory LRU cache for instant replay.
 *     No arbiter, no server audio endpoint — browsers are self-contained here.
 *
 *   - NATIVE ({@link NativeReaderOutput}, iOS shell) — plays through the SHARED
 *     audio backend (createAudioBackend), so it joins the AVPlayer ownership
 *     arbiter (starting follow-along ejects the audiobook player + full-render
 *     read-aloud, and vice-versa) and survives screen-lock / backgrounding (a
 *     WKWebView <audio> is suspended on lock; AVPlayer is not). AVPlayer can't load
 *     the web `blob:` URLs, so each block's PCM is teed server-side and served as a
 *     WAV over HTTP (/api/reader/audio); a block plays only once it has finished
 *     generating (buffer-then-play), with read-ahead prefetch hiding that latency
 *     after the first block.
 *
 * Everything else — WS receive, sentence segmentation + boundaries, the prefetch
 * engine, the play queue, and `session.sentenceAt(position)` highlighting off the
 * active backend's clock — is shared and identical on both platforms.
 *
 * The phone reaches the app over http:// on the tailnet (a non-secure context), so
 * crypto.subtle / crypto.randomUUID are unavailable — cache keys use a plain string
 * hash; requestIds use a counter. Settings (rate/volume/voice) are local fields +
 * localStorage.
 */

import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { ReaderService } from '../services/reader.service';
import { ServerConfigService } from '../services/server-config.service';
import { AudioBackend, createAudioBackend } from '../services/audio-backend';
import {
  BYTES_PER_SECOND,
  ClientAction,
  EngineState,
  ServerConfig,
  ServerEvent,
  SpeakSettings,
  decodeBase64,
} from './reader-protocol';

// ─── Public types ───────────────────────────────────────────────────────────

export type PlaybackState =
  | 'connecting'
  | 'starting-engine'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
  | 'idle';

/** One block of text to read (a paragraph/heading/selection). */
export interface ReaderItem {
  id: string;
  label: string;
  text: string;
  /** char offset into `text` where playback should begin (clicked mid-block). */
  startChar?: number;
}

// ─── Tunables (from offscreen.ts) ────────────────────────────────────────────

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const START_MIN_SECONDS = 8;
const STARTUP_LEAD_SECONDS = 1;
const RESUME_MIN_SECONDS = 1.5;
const PREFETCH_LOOKAHEAD_SECONDS = 2000;
const SEEK_STEP_GRACE = 0.05;
const STATUS_INTERVAL_MS = 300;
const BUFFERING_GRACE_MS = 450;
const WEB_MAX_VOLUME = 3;    // Web Audio gain can boost past 1×.
const NATIVE_MAX_VOLUME = 1; // AVPlayer volume is a plain [0,1] gain.

/** True inside the native iOS shell (detected the same way audio-backend.ts does). */
function isNativePlatform(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

// ─── PCM assembly ─────────────────────────────────────────────────────────────

interface Slot {
  chunks: Uint8Array[];
  done: boolean;
  /** Seconds of silence this row states must follow it, from its `done` event.
   *  Null until the row retires. */
  gapSec: number | null;
}

class Session {
  requestId: string;
  sentences: string[] = [];
  slots: Slot[] = [];
  segments: Uint8Array[] = [];
  bytes = 0;
  boundaries: number[] = [0];
  appendCursor = 0;
  cursorSeq = 0;
  complete = false;
  generationDone = false;
  note: string | null = null;

  constructor(requestId: string) { this.requestId = requestId; }

  initSlots(sentences: string[]): void {
    this.sentences = sentences;
    this.slots = sentences.map(() => ({ chunks: [], done: false, gapSec: null }));
  }
  addChunk(i: number, seq: number, bytes: Uint8Array): void {
    let slot = this.slots[i];
    if (!slot) { slot = { chunks: [], done: false, gapSec: null }; this.slots[i] = slot; }
    slot.chunks[seq] = bytes;
  }
  /** A row retired, with the silence narrator says follows it. Refused by name
   *  rather than defaulted: the audio is bare speech, and a number invented here
   *  would also disagree with the WAV the server assembled for the native
   *  player, which uses the one on the wire. */
  markDone(i: number, gapSec: number): void {
    if (typeof gapSec !== 'number' || !Number.isFinite(gapSec) || gapSec < 0) {
      throw new Error(
        `row ${i} retired with gapSec ${String(gapSec)}. Listen paces from narrator's own `
        + 'classification of the row and this player has no default to use instead.',
      );
    }
    const s = this.slots[i];
    if (s) { s.done = true; s.gapSec = gapSec; }
  }
  /** A row the server refused: no audio and no pause — there is no sentence
   *  there to pause after. */
  markFailed(i: number): void {
    const s = this.slots[i];
    if (s) { s.chunks = []; s.done = true; s.gapSec = 0; }
  }

  drain(): void {
    while (this.appendCursor < this.slots.length) {
      const slot = this.slots[this.appendCursor];
      if (!slot) break;
      while (slot.chunks[this.cursorSeq] !== undefined) {
        const c = slot.chunks[this.cursorSeq];
        this.segments.push(c);
        this.bytes += c.length;
        this.cursorSeq++;
      }
      if (slot.done && this.cursorSeq >= slot.chunks.length) {
        // THE ROW'S OWN PAUSE, INSIDE ITS BOUNDARY — the same arithmetic the
        // extension's offscreen player does, and the same bytes the server put
        // in the WAV it serves the native player. `boundaries[i + 1]` is taken
        // AFTER the silence, so a playhead inside the gap still maps to the row
        // that was speaking (`sentenceAt`) and a seek to row i + 1 lands on its
        // first sample instead of in the pause in front of it.
        if (slot.gapSec === null) {
          // Unreachable by construction - `markDone` and `markFailed` are the
          // only ways a slot becomes done and both state a gap - so it is named
          // rather than defaulted: a 0 substituted here would run two sentences
          // together and nothing would say which number was missing.
          throw new Error(
            `row ${this.appendCursor} is finished but stated no gap; the pause after a row `
            + "is narrator's own classification of it and this player invents none.",
          );
        }
        const gap = Math.floor(slot.gapSec * BYTES_PER_SECOND);
        const even = gap - (gap % 2);   // PCM16 = 2 bytes/sample, keep aligned
        if (even > 0) {
          this.segments.push(new Uint8Array(even));
          this.bytes += even;
        }
        this.appendCursor++;
        this.cursorSeq = 0;
        this.boundaries[this.appendCursor] = this.bytes;
      } else break;
    }
  }
  sentenceAt(seconds: number): number {
    const byte = seconds * BYTES_PER_SECOND;
    for (let i = this.appendCursor; i >= 1; i--) {
      if (byte >= this.boundaries[i]) return i;
    }
    return 0;
  }
  get seconds(): number { return this.bytes / BYTES_PER_SECOND; }
}

interface CacheEntry {
  segments: Uint8Array[];
  bytes: number;
  boundaries: number[];
  sentences: string[];
  lastUsed: number;
}

/** Stable, collision-resistant string hash (cyrb53) — replaces SHA-256 since the
 *  phone runs over a non-secure http:// origin where crypto.subtle is unavailable. */
function hashKey(voice: string, text: string): string {
  const str = `${voice} ${text}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function buildWav(segments: Uint8Array[], totalBytes: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + totalBytes, true);
  w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, totalBytes, true);
  return new Blob([header, ...segments] as BlobPart[], { type: 'audio/wav' });
}

// ─── Output strategy contract ────────────────────────────────────────────────

/** What an output strategy needs from the shared engine (the service implements
 *  this). Keeps the queue/session state owned by the service; the output only
 *  reaches in through these calls. */
interface OutputHost {
  session(): Session | null;
  hasPendingStart(): boolean;
  targetStartSeconds(): number | null;
  sentenceStartSeconds(fraction: number): number | null;
  clearPendingStart(): void;
  advance(): void;                 // block finished → move to next
  changed(): void;                 // push state into the UI signals
  setError(message: string): void;
  audioUrl(requestId: string): string | null;  // native HTTP block URL
  nowPlayingLabel(): string | null;             // native Now Playing title
  keepReadyPrefetch(entry: { session: Session; item: ReaderItem }): void; // native
}

/** The audio-output layer, one implementation per platform. All queue/prefetch/WS
 *  logic in the service is platform-agnostic and talks only to this. */
interface ReaderOutput {
  started(): boolean;
  userPaused(): boolean;
  audioPaused(): boolean;   // underlying element/player transport is paused
  ended(): boolean;
  position(): number;
  volume(): number;         // clamped, persisted output volume
  activeState(): PlaybackState;  // computeState once started

  onData(): void;           // new WS data (or socket drop) — start/extend as fit
  togglePause(): void;
  seekBy(delta: number): void;
  seekToSeconds(target: number): void;
  seekWithin(fraction: number): void;
  setRate(r: number): void;
  setVolume(v: number): void;
  pauseAudio(): void;       // pause without changing intent (cancelGeneration)
  reset(): void;            // soft: clear per-block state for the next block
  teardown(): void;         // hard: fully release the player (full stop)

  // Cache (web only; native returns null / no-ops)
  purgeCache(): void;
  cacheGet(voice: string, text: string): CacheEntry | null;
  rememberKey(requestId: string, voice: string, text: string): void;
  cachePutForRequest(session: Session): void;
  storeCompletedPrefetch(entry: { session: Session; item: ReaderItem }): void;
}

// ─── Web output: raw <audio> + AudioContext + growing blob (the original) ─────

class WebReaderOutput implements ReaderOutput {
  private readonly audio = new Audio();
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private outputVolume = 1;
  private rate = 1;

  private startedFlag = false;
  private userPausedFlag = false;
  private finishedSentFlag = false;
  private blobBytes = 0;
  private blobUrl: string | null = null;
  private stallSince: number | null = null;

  private readonly cache = new Map<string, CacheEntry>();
  private lruCounter = 0;
  private readonly cacheKeyByRequest = new Map<string, string>();

  constructor(private readonly host: OutputHost, initialRate: number, initialVolume: number) {
    this.rate = initialRate;
    this.outputVolume = Math.max(0, Math.min(WEB_MAX_VOLUME, initialVolume));
    this.audio.preload = 'auto';
    // iOS Safari only grants background/lock-screen playback to media elements that
    // are connected to the document (kept from the original for web parity).
    this.audio.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.audio);
    this.audio.addEventListener('ended', () => {
      if (!this.host.session()) return;
      this.resumeIfReady();
      this.host.changed();
    });
    // If the browser suspended audio while backgrounded and the user never paused,
    // resume on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.host.session() && this.startedFlag && !this.userPausedFlag && this.audio.paused && !this.audio.ended) {
        void this.audio.play().catch(() => { /* stays paused */ });
        this.host.changed();
      }
    });
  }

  started(): boolean { return this.startedFlag; }
  userPaused(): boolean { return this.userPausedFlag; }
  audioPaused(): boolean { return this.audio.paused; }
  ended(): boolean { return this.audio.ended; }
  position(): number { return this.audio.currentTime; }
  volume(): number { return this.outputVolume; }

  onData(): void {
    const s = this.host.session();
    if (!s) return;
    if (!this.startedFlag) {
      if (this.host.hasPendingStart()) {
        if (this.host.targetStartSeconds() != null) this.startPlayback();
        else if (s.generationDone) { this.host.clearPendingStart(); this.startPlayback(); }
        this.host.changed();
        return;
      }
      const ready =
        s.generationDone ||
        s.seconds >= START_MIN_SECONDS ||
        (s.appendCursor >= 2 && s.seconds >= STARTUP_LEAD_SECONDS);
      if (ready) this.startPlayback();
      this.host.changed();
      return;
    }
    if (this.audio.ended) this.resumeIfReady();
    this.host.changed();
  }

  private startPlayback(): void {
    const s = this.host.session();
    if (!s) return;
    this.startedFlag = true;
    if (this.outputVolume !== 1) this.ensureGainGraph();
    const at = this.host.targetStartSeconds() ?? 0;
    this.host.clearPendingStart();
    this.loadBlob(at);
  }

  private loadBlob(atSeconds: number, exact = false): void {
    const s = this.host.session();
    if (!s) return;
    const blob = buildWav(s.segments, s.bytes);
    this.blobBytes = s.bytes;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = URL.createObjectURL(blob);

    const onLoaded = () => {
      const s2 = this.host.session();
      if (!s2) return;
      try {
        this.audio.currentTime = exact
          ? Math.min(atSeconds, s2.seconds)
          : Math.min(atSeconds, Math.max(0, s2.seconds - SEEK_STEP_GRACE));
      } catch { /* ignore */ }
      (this.audio as { preservesPitch?: boolean }).preservesPitch = true;
      this.audio.playbackRate = this.rate;
      if (!this.userPausedFlag) void this.audio.play().catch(() => { /* autoplay race */ });
      this.host.changed();
    };
    this.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    this.audio.src = this.blobUrl;
    this.audio.load();
  }

  private resumeIfReady(): void {
    const s = this.host.session();
    if (!s || !this.audio.ended) return;
    const pending = s.bytes - this.blobBytes;
    if (pending <= 0) { this.maybeFinalize(); return; }
    if (s.generationDone || pending >= RESUME_MIN_SECONDS * BYTES_PER_SECOND) {
      this.loadBlob(this.blobBytes / BYTES_PER_SECOND, true);
    }
  }

  private maybeFinalize(): void {
    const s = this.host.session();
    if (!s || !this.audio.ended || !s.generationDone) return;
    if (s.bytes > this.blobBytes) return;
    if (this.finishedSentFlag) return;
    this.finishedSentFlag = true;
    if (s.complete) this.cachePutForRequest(s);
    this.host.advance();
  }

  togglePause(): void {
    const s = this.host.session();
    if (!s) return;
    if (!this.startedFlag) this.userPausedFlag = !this.userPausedFlag;
    else if (this.audio.ended && s.generationDone && s.bytes <= this.blobBytes) {
      this.userPausedFlag = false; this.finishedSentFlag = false; this.loadBlob(0);
    } else if (this.audio.paused) { this.userPausedFlag = false; void this.audio.play().catch(() => { /* ignore */ }); }
    else { this.userPausedFlag = true; this.audio.pause(); }
  }

  seekBy(delta: number): void {
    const s = this.host.session();
    if (!s || !this.startedFlag) return;
    const target = Math.max(0, Math.min(s.seconds, this.audio.currentTime + delta));
    if (target > this.blobBytes / BYTES_PER_SECOND) this.loadBlob(target);
    else { try { this.audio.currentTime = target; } catch { /* ignore */ } }
  }

  seekToSeconds(target: number): void {
    const s = this.host.session();
    if (!s) return;
    const t = Math.max(0, Math.min(s.seconds, target));
    if (t > this.blobBytes / BYTES_PER_SECOND) this.loadBlob(t);
    else { try { this.audio.currentTime = t; } catch { /* ignore */ } }
  }

  seekWithin(fraction: number): void {
    const s = this.host.session();
    if (!s) return;
    const aligned = this.host.sentenceStartSeconds(fraction);
    const target = Math.max(0, Math.min(s.seconds, aligned ?? fraction * s.seconds));
    if (target > this.blobBytes / BYTES_PER_SECOND) this.loadBlob(target);
    else { try { this.audio.currentTime = target; } catch { /* ignore */ } }
  }

  setRate(r: number): void { this.rate = r; this.audio.playbackRate = r; }

  setVolume(v: number): void {
    this.outputVolume = Math.max(0, Math.min(WEB_MAX_VOLUME, v));
    if (this.outputVolume !== 1) this.ensureGainGraph();
    this.applyGain();
  }

  pauseAudio(): void { try { this.audio.pause(); } catch { /* ignore */ } }

  reset(): void {
    this.startedFlag = false;
    this.userPausedFlag = false;
    this.finishedSentFlag = false;
    this.blobBytes = 0;
    this.stallSince = null;
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch { /* ignore */ }
  }

  teardown(): void { this.reset(); }

  activeState(): PlaybackState {
    const s = this.host.session();
    if (!s) return 'idle';
    if (this.audio.ended && s.generationDone && s.bytes <= this.blobBytes) return 'ended';
    if (this.isNonUserStall(s)) {
      if (this.stallSince === null) this.stallSince = performance.now();
      return performance.now() - this.stallSince >= BUFFERING_GRACE_MS ? 'buffering' : 'playing';
    }
    this.stallSince = null;
    if (this.audio.paused) return this.userPausedFlag ? 'paused' : 'playing';
    return 'playing';
  }

  private isNonUserStall(s: Session): boolean {
    if (this.userPausedFlag) return false;
    if (this.audio.ended) return !(s.generationDone && s.bytes <= this.blobBytes);
    return this.audio.paused;
  }

  // ── Output gain (>1× boost) ──
  private applyGain(): void { if (this.gainNode) this.gainNode.gain.value = this.outputVolume; }
  private ensureGainGraph(): void {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      return;
    }
    try {
      this.audioCtx = new AudioContext();
      const srcNode = this.audioCtx.createMediaElementSource(this.audio);
      this.gainNode = this.audioCtx.createGain();
      srcNode.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);
      this.applyGain();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
    } catch {
      this.audioCtx = null;
      this.gainNode = null;
    }
  }

  // ── Cache ──
  purgeCache(): void { this.cache.clear(); this.lruCounter = 0; }
  cacheGet(voice: string, text: string): CacheEntry | null {
    const entry = this.cache.get(hashKey(voice, text));
    if (entry) entry.lastUsed = ++this.lruCounter;
    return entry ?? null;
  }
  rememberKey(requestId: string, voice: string, text: string): void {
    this.cacheKeyByRequest.set(requestId, hashKey(voice, text));
  }
  cachePutForRequest(session: Session): void {
    if (!session.complete || session.bytes === 0) return;
    const key = this.cacheKeyByRequest.get(session.requestId);
    if (!key) return;
    this.cachePut(key, {
      segments: session.segments, bytes: session.bytes,
      boundaries: session.boundaries, sentences: session.sentences,
    });
  }
  storeCompletedPrefetch(entry: { session: Session; item: ReaderItem }): void {
    this.cachePutForRequest(entry.session);
  }
  private cachePut(key: string, entry: Omit<CacheEntry, 'lastUsed'>): void {
    this.cache.set(key, { ...entry, lastUsed: ++this.lruCounter });
    let total = 0;
    for (const e of this.cache.values()) total += e.bytes;
    while (total > CACHE_LIMIT_BYTES && this.cache.size > 1) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, e] of this.cache) {
        if (k !== key && e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
      }
      if (!oldestKey) break;
      total -= this.cache.get(oldestKey)!.bytes;
      this.cache.delete(oldestKey);
    }
  }
}

// ─── Native output: arbitrated AVPlayer facade + HTTP-per-block (buffer-then-play) ─

class NativeReaderOutput implements ReaderOutput {
  private readonly audio: AudioBackend = createAudioBackend();
  private outputVolume = 1;
  private rate = 1;

  private startedFlag = false;
  private userPausedFlag = false;
  private finishedSentFlag = false;
  private stallSince: number | null = null;
  private pendingSeek: { at: number; exact: boolean } | null = null;

  constructor(private readonly host: OutputHost, initialRate: number, initialVolume: number) {
    this.rate = initialRate;
    this.outputVolume = Math.max(0, Math.min(NATIVE_MAX_VOLUME, initialVolume));
    this.audio.preload = 'auto';
    this.audio.volume = this.outputVolume;

    // A block's WAV loaded — apply the pending start/seek and play. (The facade
    // swallows this during an eject→reacquire reload, which restores position and
    // resumes itself, so this only runs for fresh block loads.)
    this.audio.addEventListener('loadedmetadata', () => this.onLoadedMetadata());

    // The block's WAV finished → advance to the next block.
    this.audio.addEventListener('ended', () => {
      if (!this.host.session()) return;
      this.maybeFinalize();
      this.host.changed();
    });

    // The block's server audio is gone (evicted / connection dropped mid-block).
    this.audio.addEventListener('error', () => {
      const s = this.host.session();
      if (!s || !this.audio.src) return;
      this.host.setError(s.note || 'Audio unavailable — try again.');
    });

    // Native lock-screen / Control Center commands, and the arbiter's eject signal
    // (command('pause') when another service takes the shared player).
    this.audio.nativeControls?.onCommand((action) => this.handleRemoteCommand(action));
  }

  started(): boolean { return this.startedFlag; }
  userPaused(): boolean { return this.userPausedFlag; }
  audioPaused(): boolean { return this.audio.paused; }
  ended(): boolean { return this.audio.ended; }
  position(): number { return this.audio.currentTime; }
  volume(): number { return this.outputVolume; }

  onData(): void {
    const s = this.host.session();
    if (!s) return;
    if (!this.startedFlag) {
      // Buffer-then-play: AVPlayer needs the whole block (known length) before it
      // can play, so start only once generation has settled.
      if (s.generationDone) {
        if (s.bytes > 0) this.startPlayback();
        else { this.finishedSentFlag = true; this.host.advance(); } // empty/failed → advance
      }
      this.host.changed();
      return;
    }
    this.host.changed();
  }

  private startPlayback(): void {
    const s = this.host.session();
    if (!s) return;
    this.startedFlag = true;
    const at = this.host.targetStartSeconds() ?? 0;
    this.host.clearPendingStart();
    this.loadUrl(at);
  }

  /** Point the backend at the block's server-served WAV and play. This is where the
   *  arbiter ACQUIRES the shared player (ejecting the audiobook / full-render
   *  read-aloud) and lock-screen playback begins. */
  private loadUrl(atSeconds: number, exact = false): void {
    const s = this.host.session();
    if (!s) return;
    const url = this.host.audioUrl(s.requestId);
    if (!url) { this.host.setError('Sign in as a reader to use Listen.'); return; }
    this.pendingSeek = { at: atSeconds, exact };
    this.audio.src = url;
    // load() is required by the native facade (only reaches the plugin on load()) and
    // also acquires the shared native player.
    this.audio.load();
  }

  private onLoadedMetadata(): void {
    const s = this.host.session();
    if (!s || !this.pendingSeek) return;
    const { at, exact } = this.pendingSeek;
    this.pendingSeek = null;
    try {
      this.audio.currentTime = exact
        ? Math.min(at, s.seconds)
        : Math.min(at, Math.max(0, s.seconds - SEEK_STEP_GRACE));
    } catch { /* ignore */ }
    (this.audio as { preservesPitch?: boolean }).preservesPitch = true;
    this.audio.playbackRate = this.rate;
    // We own the shared player now (load() acquired it) — push this block's Now
    // Playing card. The facade re-pushes it after an eject→reacquire.
    this.audio.nativeControls?.setMetadata({ title: this.host.nowPlayingLabel() || 'Read aloud', artist: 'Read aloud' });
    if (!this.userPausedFlag) void this.audio.play().catch(() => { /* autoplay race */ });
    this.host.changed();
  }

  private maybeFinalize(): void {
    const s = this.host.session();
    if (!s || !this.audio.ended || !s.generationDone) return;
    if (this.finishedSentFlag) return;
    this.finishedSentFlag = true;
    this.host.advance();
  }

  /** Sync to a lock-screen command / the arbiter's eject. */
  private handleRemoteCommand(action: string): void {
    switch (action) {
      case 'play':
        // Reaches us while we own the player or as a lock-screen resume after an
        // eject; play() reacquires + resumes mid-block if we were ejected.
        this.userPausedFlag = false;
        if (this.host.session() && this.startedFlag && this.audio.paused && !this.audio.ended) {
          void this.audio.play().catch(() => { /* ignore */ });
        }
        this.host.changed();
        return;
      case 'pause':
        // Also the ARBITER EJECT signal (another service took the shared player).
        // Park as paused; the facade already tore our item down — don't drive it.
        this.userPausedFlag = true;
        this.host.changed();
        return;
      case 'skipForward':
      case 'nextChapter':
        this.finishedSentFlag = true;
        this.host.advance();
        return;
      case 'skipBackward':
      case 'prevChapter':
        this.seekToSeconds(0);
        return;
    }
  }

  togglePause(): void {
    const s = this.host.session();
    if (!s) return;
    if (!this.startedFlag) { this.userPausedFlag = !this.userPausedFlag; return; }
    if (this.audio.ended) {
      this.userPausedFlag = false; this.finishedSentFlag = false; this.loadUrl(0);
    } else if (this.audio.paused) {
      this.userPausedFlag = false; void this.audio.play().catch(() => { /* ignore */ });
    } else {
      this.userPausedFlag = true; this.audio.pause();
    }
  }

  seekBy(delta: number): void {
    const s = this.host.session();
    if (!s || !this.startedFlag) return;
    const target = Math.max(0, Math.min(s.seconds, this.audio.currentTime + delta));
    try { this.audio.currentTime = target; } catch { /* ignore */ }
  }

  seekToSeconds(target: number): void {
    const s = this.host.session();
    if (!s) return;
    const t = Math.max(0, Math.min(s.seconds, target));
    try { this.audio.currentTime = t; } catch { /* ignore */ }
  }

  seekWithin(fraction: number): void {
    const s = this.host.session();
    if (!s) return;
    const aligned = this.host.sentenceStartSeconds(fraction);
    const target = Math.max(0, Math.min(s.seconds, aligned ?? fraction * s.seconds));
    try { this.audio.currentTime = target; } catch { /* ignore */ }
  }

  setRate(r: number): void { this.rate = r; this.audio.playbackRate = r; }

  setVolume(v: number): void {
    this.outputVolume = Math.max(0, Math.min(NATIVE_MAX_VOLUME, v));
    this.audio.volume = this.outputVolume;
  }

  pauseAudio(): void { try { this.audio.pause(); } catch { /* ignore */ } }

  /** Soft reset between blocks: KEEP the native player owned (a fresh loadUrl reuses
   *  it) so quick block transitions don't tear down the lock-screen card. */
  reset(): void {
    this.startedFlag = false;
    this.userPausedFlag = false;
    this.finishedSentFlag = false;
    this.pendingSeek = null;
    this.stallSince = null;
    try { this.audio.pause(); } catch { /* ignore */ }
  }

  /** Hard release (full stop): tear the native player down + clear the lock screen
   *  so the audiobook player can take over cleanly. */
  teardown(): void {
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch { /* ignore */ }
  }

  activeState(): PlaybackState {
    const s = this.host.session();
    if (!s) return 'idle';
    if (this.audio.ended && s.generationDone) return 'ended';
    if (this.isNonUserStall()) {
      if (this.stallSince === null) this.stallSince = performance.now();
      return performance.now() - this.stallSince >= BUFFERING_GRACE_MS ? 'buffering' : 'playing';
    }
    this.stallSince = null;
    if (this.audio.paused) return this.userPausedFlag ? 'paused' : 'playing';
    return 'playing';
  }

  private isNonUserStall(): boolean {
    if (this.userPausedFlag) return false;
    if (this.audio.ended) return false;
    return this.audio.paused;
  }

  // Cache is web-only; the native audio lives in the server store.
  purgeCache(): void { /* no-op */ }
  cacheGet(): CacheEntry | null { return null; }
  rememberKey(): void { /* no-op */ }
  cachePutForRequest(): void { /* no-op */ }
  storeCompletedPrefetch(entry: { session: Session; item: ReaderItem }): void {
    this.host.keepReadyPrefetch(entry);
  }
}

// ─── The shared engine ────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ReaderPlaybackService implements OutputHost {
  private readonly reader = inject(ReaderService);
  private readonly cfg = inject(ServerConfigService);
  private readonly native = isNativePlatform();

  // ── Public reactive surface (components bind to these) ──────────────────────
  readonly state: WritableSignal<PlaybackState> = signal('idle');
  readonly position = signal(0);
  readonly buffered = signal(0);
  readonly totalKnown = signal(false);
  readonly sentenceIndex = signal(-1);
  readonly sentenceCount = signal(0);
  readonly sentences = signal<string[]>([]);
  readonly paused = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly note = signal<string | null>(null);
  readonly currentId = signal<string | null>(null);
  readonly currentLabel = signal<string | null>(null);
  readonly upcomingIds = signal<string[]>([]);
  readonly engineStateSig = signal<EngineState>('stopped');
  readonly connected = signal(false);
  readonly connectionError = signal<string | null>(null);
  readonly voices = signal<string[]>([]);
  readonly currentVoice = signal<string | null>(null);
  readonly voiceSig = signal('');   // the reader's chosen voice ('' = engine default)
  readonly rateSig = signal(1);
  readonly volumeSig = signal(1);

  // ── Audio output strategy (web blob / native arbitrated HTTP) ───────────────
  private readonly out: ReaderOutput;

  // ── Queue ───────────────────────────────────────────────────────────────────
  private currentItem: ReaderItem | null = null;
  private upcoming: ReaderItem[] = [];
  private readonly prefetches = new Map<string, { session: Session; item: ReaderItem }>();
  /** (native) Prefetch sessions that finished generating, awaiting adoption; their
   *  audio lives in the server store under the session's requestId. Empty on web
   *  (completed prefetches go to the web output's cache instead). */
  private readonly readyPrefetch = new Map<string, { session: Session; item: ReaderItem }>();
  private readonly startingItems = new Set<string>();
  private readonly readyAhead = new Map<string, number>();

  // ── Player (current item) ───────────────────────────────────────────────────
  private currentSession: Session | null = null;
  private errorMsg: string | null = null;
  private preState: 'connecting' | 'starting-engine' | 'buffering' = 'connecting';
  private lastReportedSentence = -1;
  private pendingStartFraction: number | null = null;
  private playSeq = 0;
  private reqCounter = 0;
  // Per-service-instance prefix so requestIds are globally unique across clients
  // (two readers of the SAME book otherwise mint identical `${item.id}#${counter}`
  // ids and would collide in the server audio store). crypto.randomUUID is absent
  // in the native WebView, but Date.now()/Math.random() are.
  private readonly sessionPrefix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;

  // ── WebSocket ───────────────────────────────────────────────────────────────
  private ws: WebSocket | null = null;
  private authed = false;
  private connectPromise: Promise<void> | null = null;
  private engineState: EngineState = 'stopped';
  private connErr: string | null = null;
  private serverConfig: ServerConfig | null = null;

  private statusTimer: number | null = null;

  // ── Settings (local + localStorage) ─────────────────────────────────────────
  private voice = '';
  private rate = 1;
  private outputVolume = 1;
  // "Listen to anything" prefetches far ahead (whole doc); the Read&Listen
  // follow-along mode tightens this to a ~45s moving window so a long book doesn't
  // render pages the reader may never reach.
  private readAheadSeconds = PREFETCH_LOOKAHEAD_SECONDS;

  /** Cap how many seconds of upcoming audio to prefetch (follow-along = ~45s). */
  setReadAhead(seconds: number): void {
    this.readAheadSeconds = Math.max(5, seconds);
  }

  constructor() {
    this.rate = parseFloat(localStorage.getItem('bookshelf-reader-rate') || '1') || 1;
    this.outputVolume = parseFloat(localStorage.getItem('bookshelf-reader-volume') || '1') || 1;
    this.voice = localStorage.getItem('bookshelf-reader-voice') || '';
    this.out = this.native
      ? new NativeReaderOutput(this, this.rate, this.outputVolume)
      : new WebReaderOutput(this, this.rate, this.outputVolume);
    this.outputVolume = this.out.volume();
    this.rateSig.set(this.rate);
    this.volumeSig.set(this.outputVolume);
    this.voiceSig.set(this.voice);
  }

  // ─── OutputHost implementation ──────────────────────────────────────────────

  session(): Session | null { return this.currentSession; }
  hasPendingStart(): boolean { return this.pendingStartFraction != null; }
  targetStartSeconds(): number | null {
    return this.pendingStartFraction == null ? null : this.sentenceStartSeconds(this.pendingStartFraction);
  }
  clearPendingStart(): void { this.pendingStartFraction = null; }
  advance(): void { this.concludeCurrent(); }
  changed(): void { this.broadcast(); }
  setError(message: string): void { this.errorMsg = message; this.broadcast(); }
  nowPlayingLabel(): string | null { return this.currentItem?.label ?? null; }
  keepReadyPrefetch(entry: { session: Session; item: ReaderItem }): void {
    this.readyPrefetch.set(entry.item.id, entry);
  }
  /** The HTTP URL the native backend plays a block's WAV from (reader's origin,
   *  authed by the reader token in the query — AVPlayer can't set headers). */
  audioUrl(requestId: string): string | null {
    const token = this.reader.token();
    if (!token) return null;
    return this.cfg.url(`/api/reader/audio?requestId=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`);
  }
  sentenceStartSeconds(fraction: number): number | null {
    const s = this.currentSession;
    if (!s) return null;
    const sents = s.sentences;
    if (sents.length === 0) return null;
    let total = 0;
    for (const t of sents) total += t.length;
    if (total === 0) return 0;
    const want = fraction * total;
    let acc = 0;
    let idx = 0;
    for (let i = 0; i < sents.length; i++) {
      if (want < acc + sents[i].length) { idx = i; break; }
      acc += sents[i].length;
      idx = i;
    }
    if (idx >= s.appendCursor) return null;
    return s.boundaries[idx] / BYTES_PER_SECOND;
  }

  // ─── Public API (called by the Reader component) ───────────────────────────

  /** Replace the queue with an ordered run of blocks and start reading. */
  playSequence(items: ReaderItem[]): void {
    if (items.length === 0) return;
    const first = items[0];
    if (this.currentItem && this.currentItem.id === first.id && this.currentSession && !this.errorMsg && this.currentItem.text === first.text) {
      this.upcoming = items.slice(1);
      const fraction = first.startChar ? Math.min(1, first.startChar / Math.max(1, first.text.length)) : 0;
      if (this.out.started()) this.out.seekWithin(fraction);
      else { this.pendingStartFraction = fraction > 0 ? fraction : null; this.out.onData(); }
      this.fillPrefetch();
      this.broadcast();
      return;
    }
    this.currentItem = first;
    this.upcoming = items.slice(1);
    void this.startCurrent(true);
  }

  togglePause(): void {
    if (!this.currentSession) return;
    this.out.togglePause();
    this.broadcast();
  }

  seek(delta: number): void {
    if (!this.currentSession || !this.out.started()) return;
    this.out.seekBy(delta);
    this.broadcast();
  }

  setRate(r: number): void {
    this.rate = r;
    this.out.setRate(r);
    localStorage.setItem('bookshelf-reader-rate', String(r));
    this.rateSig.set(r);
    this.broadcast();
  }

  setVolume(v: number): void {
    this.out.setVolume(v);
    this.outputVolume = this.out.volume();
    localStorage.setItem('bookshelf-reader-volume', String(this.outputVolume));
    this.volumeSig.set(this.outputVolume);
  }

  /** Set the streaming voice (persisted). New speaks/prefetches use it; to hear
   *  it immediately the caller restarts the current block (cache keys include the
   *  voice, so old-voice audio never bleeds into the new selection). */
  setVoice(v: string): void {
    this.voice = v;
    localStorage.setItem('bookshelf-reader-voice', v);
    this.voiceSig.set(v);
  }

  getVoice(): string { return this.voice; }

  skip(): void { this.skipCurrent(); }

  stop(): void { this.stopAll(); }

  /** Seek within the CURRENT block to the start of an already-buffered sentence. */
  seekToSentence(index: number): void {
    const s = this.currentSession;
    if (!s || !this.out.started()) return;
    if (index <= 0) { this.out.seekToSeconds(0); this.broadcast(); return; }
    if (index >= s.appendCursor) return; // not buffered yet
    this.out.seekToSeconds(s.boundaries[index] / BYTES_PER_SECOND);
    this.broadcast();
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  private wsUrl(): string | null {
    const token = this.reader.token();
    if (!token) return null;
    return this.cfg.wsUrl(`/api/reader/ws?token=${encodeURIComponent(token)}`);
  }

  private isConnected(): boolean {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.authed);
  }

  private ensureConnected(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = this.wsUrl();
      if (!url) { reject(new Error('NOT_SIGNED_IN')); return; }
      let socket: WebSocket;
      try { socket = new WebSocket(url); } catch { reject(new Error('CONNECT_FAILED')); return; }
      this.ws = socket;
      this.authed = false;
      const timeout = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } reject(new Error('CONNECT_TIMEOUT')); }, 8000);

      socket.onmessage = (e) => {
        let msg: ServerEvent;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'hello') {
          this.authed = true;
          this.engineState = msg.state;
          this.voices.set(msg.voices);
          this.currentVoice.set(msg.currentVoice);
          this.serverConfig = msg.config;
          this.connErr = null;
          this.connected.set(true);
          this.connectionError.set(null);
          clearTimeout(timeout);
          resolve();
        }
        this.handleServerEvent(msg);
      };
      socket.onclose = (ev) => {
        clearTimeout(timeout);
        const wasAuthed = this.authed;
        this.authed = false;
        this.connected.set(false);
        if (this.ws === socket) this.ws = null;
        if (!wasAuthed) reject(new Error(ev.code === 4401 ? 'BAD_TOKEN' : 'CONNECT_FAILED'));
        else this.onSocketClosed();
      };
      socket.onerror = () => { /* close fires next with the disposition */ };
    });

    return this.connectPromise.finally(() => { this.connectPromise = null; });
  }

  private send(action: ClientAction): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(action));
  }

  private onSocketClosed(): void {
    this.engineState = 'stopped';
    this.engineStateSig.set('stopped');
    if (this.currentSession && !this.currentSession.generationDone) {
      this.finishGeneration(false, 'Connection to BookForge lost');
      this.out.onData();
    }
    this.broadcast();
  }

  // ─── Server events ──────────────────────────────────────────────────────────

  private handleServerEvent(msg: ServerEvent): void {
    if ('requestId' in msg && msg.requestId !== undefined) {
      const entry = this.prefetches.get(msg.requestId);
      if (entry) { this.handlePrefetchEvent(entry, msg); return; }
    }
    switch (msg.type) {
      case 'state':
        this.engineState = msg.state;
        this.engineStateSig.set(msg.state);
        if (!this.out.started() && this.currentSession) this.preState = msg.state === 'running' ? 'buffering' : 'starting-engine';
        this.broadcast();
        return;
      case 'status':
        this.engineState = msg.state;
        this.engineStateSig.set(msg.state);
        this.voices.set(msg.voices);
        this.currentVoice.set(msg.currentVoice);
        this.serverConfig = msg.config;
        this.broadcast();
        return;
      case 'speaking':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        this.currentSession.initSlots(msg.sentences);
        this.broadcast();
        return;
      case 'chunk':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        this.currentSession.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data));
        this.currentSession.drain();
        this.out.onData();
        return;
      case 'done':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        // The row's pause travels with its retirement — see Session.markDone.
        this.currentSession.markDone(msg.sentenceIndex, msg.gapSec);
        this.currentSession.drain();
        this.out.onData();
        return;
      case 'failed':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        this.currentSession.markFailed(msg.sentenceIndex);
        this.currentSession.drain();
        this.out.onData();
        return;
      case 'complete':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        this.finishGeneration(true);
        this.out.onData();
        this.fillPrefetch();
        return;
      case 'cancelled':
        if (!this.currentSession || msg.requestId !== this.currentSession.requestId) return;
        this.finishGeneration(false, 'Playback was taken over by another BookForge client');
        this.concludeIfIdle();
        this.broadcast();
        return;
      case 'error':
        if (this.currentSession && msg.requestId !== undefined && msg.requestId !== this.currentSession.requestId) return;
        this.errorMsg = msg.message || 'TTS error';
        if (this.currentSession) { this.finishGeneration(false); this.concludeIfIdle(); }
        this.broadcast();
        return;
    }
  }

  private finishGeneration(success: boolean, note?: string): void {
    if (!this.currentSession) return;
    this.currentSession.generationDone = true;
    if (success) { this.currentSession.complete = true; }
    if (note) this.currentSession.note = note;
  }

  private concludeIfIdle(): void {
    if (!this.out.started() || this.out.ended()) this.concludeCurrent();
  }

  // ─── Queue operations ───────────────────────────────────────────────────────

  private skipCurrent(): void {
    this.cancelGeneration();
    const next = this.upcoming.shift();
    if (next) {
      if (this.adoptPrefetchFor(next)) return;
      this.currentItem = next;
      void this.startCurrent(false);
    } else {
      this.currentItem = null;
      this.dropAllPrefetch();
      this.out.teardown();
      this.resetPlayer();
      this.stopStatusTicker();
      this.broadcast();
    }
  }

  private concludeCurrent(): void {
    const next = this.upcoming.shift();
    if (!next) { this.broadcast(); return; }
    if (this.adoptPrefetchFor(next)) return;
    this.currentItem = next;
    void this.startCurrent(false);
  }

  private stopAll(): void {
    this.cancelGeneration();
    this.dropAllPrefetch();
    this.readyAhead.clear();
    this.currentItem = null;
    this.upcoming = [];
    this.out.purgeCache();
    this.out.teardown();
    this.resetPlayer();
    this.stopStatusTicker();
    this.broadcast();
  }

  private cancelGeneration(): void {
    if (this.currentSession && !this.currentSession.generationDone && this.isConnected()) {
      this.send({ action: 'cancel', requestId: this.currentSession.requestId });
    }
    if (this.currentSession && this.currentSession.complete) this.out.cachePutForRequest(this.currentSession);
    this.out.pauseAudio();
  }

  private resetPlayer(): void {
    this.currentSession = null;
    this.lastReportedSentence = -1;
    this.pendingStartFraction = null;
    this.errorMsg = null;
    this.out.reset();
  }

  // ─── Read-ahead (concurrent prefetch) ───────────────────────────────────────

  private prefetchConcurrency(): number {
    return Math.max(1, this.serverConfig?.deviceWorkers ?? 4);
  }

  private isPrefetchingItem(id: string): boolean {
    if (this.startingItems.has(id)) return true;
    for (const { item } of this.prefetches.values()) if (item.id === id) return true;
    return false;
  }

  private handlePrefetchEvent(entry: { session: Session; item: ReaderItem }, msg: ServerEvent): void {
    const { session: s, item } = entry;
    switch (msg.type) {
      case 'speaking': s.initSlots(msg.sentences); return;
      case 'chunk': s.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data)); s.drain(); return;
      case 'done': s.markDone(msg.sentenceIndex, msg.gapSec); s.drain(); return;
      case 'failed': s.markFailed(msg.sentenceIndex); s.drain(); return;
      case 'complete':
        s.generationDone = true;
        s.complete = true;
        s.drain();
        this.prefetches.delete(s.requestId);
        this.readyAhead.set(item.id, s.seconds);
        // web → store audio in the LRU cache; native → keep for adoption (audio is
        // in the server store).
        this.out.storeCompletedPrefetch(entry);
        this.fillPrefetch();
        return;
      case 'cancelled':
      case 'error':
        this.dropPrefetchByRequest(s.requestId);
        return;
    }
  }

  private fillPrefetch(): void {
    if (!this.currentSession) return;
    let aheadSeconds = 0;
    for (const item of this.upcoming) {
      if (this.prefetches.size + this.startingItems.size >= this.prefetchConcurrency()) break;
      if (aheadSeconds >= this.readAheadSeconds) break;
      const cached = this.readyAhead.get(item.id);
      if (cached !== undefined) { aheadSeconds += cached; continue; }
      if (this.isPrefetchingItem(item.id)) continue;
      void this.startPrefetch(item);
    }
  }

  private async startPrefetch(item: ReaderItem): Promise<void> {
    const seq = this.playSeq;
    this.startingItems.add(item.id);
    try {
      const voice = this.voice;
      const hit = this.out.cacheGet(voice, item.text);
      if (hit) { this.readyAhead.set(item.id, hit.bytes / BYTES_PER_SECOND); return; }
      if (!this.upcoming.some((u) => u.id === item.id)) return;
      if ([...this.prefetches.values()].some((p) => p.item.id === item.id)) return;
      try { await this.ensureConnected(); } catch { return; }
      if (seq !== this.playSeq || !this.upcoming.some((u) => u.id === item.id)) return;
      if ([...this.prefetches.values()].some((p) => p.item.id === item.id)) return;

      const s = new Session(`${this.sessionPrefix}:${item.id}#pf${++this.reqCounter}`);
      this.prefetches.set(s.requestId, { session: s, item });
      this.out.rememberKey(s.requestId, voice, item.text);
      const speakSettings: SpeakSettings = { speed: 1.0 };
      if (voice) speakSettings.voice = voice;
      this.send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings, preempt: false, background: true });
    } finally {
      this.startingItems.delete(item.id);
      this.fillPrefetch();
    }
  }

  private dropPrefetchByRequest(requestId: string): void {
    const entry = this.prefetches.get(requestId);
    if (!entry) return;
    if (!entry.session.generationDone && this.isConnected()) this.send({ action: 'cancel', requestId });
    this.prefetches.delete(requestId);
  }

  private dropAllPrefetch(): void {
    for (const requestId of [...this.prefetches.keys()]) this.dropPrefetchByRequest(requestId);
    this.readyPrefetch.clear();
  }

  private adoptPrefetchFor(item: ReaderItem): boolean {
    let session: Session | null = null;
    const ready = this.readyPrefetch.get(item.id);
    if (ready) { session = ready.session; this.readyPrefetch.delete(item.id); }
    else {
      for (const [requestId, entry] of this.prefetches) {
        if (entry.item.id === item.id) { session = entry.session; this.prefetches.delete(requestId); break; }
      }
    }
    if (!session) return false;
    ++this.playSeq;

    this.out.reset();
    this.currentSession = session;
    this.lastReportedSentence = -1;
    this.pendingStartFraction = null;
    this.errorMsg = null;
    this.readyAhead.delete(item.id);
    this.currentItem = item;

    this.ensureStatusTicker();
    this.preState = 'buffering';
    this.out.onData();
    this.fillPrefetch();
    this.broadcast();
    return true;
  }

  // ─── Start the current item ─────────────────────────────────────────────────

  private async startCurrent(preempt: boolean): Promise<void> {
    const item = this.currentItem;
    if (!item) return;
    const seq = ++this.playSeq;

    this.cancelGeneration();
    this.resetPlayer();
    if (preempt) { this.dropAllPrefetch(); this.readyAhead.clear(); }
    this.readyAhead.delete(item.id);
    this.pendingStartFraction = item.startChar && item.text.length ? Math.min(1, item.startChar / item.text.length) : null;

    this.preState = 'connecting';
    this.ensureStatusTicker();
    this.broadcast();

    const voice = this.voice;

    // Web-only fast path: replay an already-generated block straight from the
    // in-memory cache (native returns null here — its audio lives on the server).
    const cached = this.out.cacheGet(voice, item.text);
    if (cached) {
      const s = new Session(`${this.sessionPrefix}:cache-${++this.reqCounter}`);
      s.sentences = cached.sentences;
      s.segments = cached.segments;
      s.bytes = cached.bytes;
      s.boundaries = cached.boundaries;
      s.appendCursor = cached.sentences.length;
      s.complete = true;
      s.generationDone = true;
      this.currentSession = s;
      this.out.rememberKey(s.requestId, voice, item.text);
      this.out.onData();
      this.fillPrefetch();
      return;
    }

    const s = new Session(`${this.sessionPrefix}:${item.id}#${++this.reqCounter}`);
    this.currentSession = s;
    this.out.rememberKey(s.requestId, voice, item.text);

    try {
      await this.ensureConnected();
    } catch (err) {
      if (seq !== this.playSeq) return;
      this.errorMsg = this.connectErrorMessage((err as Error).message);
      this.finishGeneration(false);
      this.broadcast();
      return;
    }
    if (seq !== this.playSeq) return;

    const speakSettings: SpeakSettings = { speed: 1.0 };
    if (voice) speakSettings.voice = voice;
    this.preState = this.engineState === 'running' ? 'buffering' : 'starting-engine';
    this.send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings, preempt, background: false });
    this.broadcast();
    this.fillPrefetch();
  }

  private connectErrorMessage(code: string): string {
    switch (code) {
      case 'NOT_SIGNED_IN': return 'Sign in as a reader to use Listen.';
      case 'BAD_TOKEN': return 'BookForge rejected your reader session — sign in again.';
      default: return "Can't reach BookForge — is the app running?";
    }
  }

  // ─── Status ticker + playhead ───────────────────────────────────────────────

  private ensureStatusTicker(): void {
    if (this.statusTimer !== null) return;
    this.statusTimer = setInterval(() => { this.reportPlayhead(); this.broadcast(); }, STATUS_INTERVAL_MS) as unknown as number;
  }
  private stopStatusTicker(): void {
    if (this.statusTimer !== null) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  private reportPlayhead(): void {
    if (!this.currentSession || !this.out.started() || this.out.audioPaused() || this.currentSession.generationDone) return;
    if (!this.isConnected()) return;
    const idx = this.currentSession.sentenceAt(this.out.position());
    if (idx !== this.lastReportedSentence) {
      this.lastReportedSentence = idx;
      this.send({ action: 'playhead', requestId: this.currentSession.requestId, sentenceIndex: idx });
    }
  }

  private computeState(): PlaybackState {
    if (this.errorMsg) return 'error';
    const s = this.currentSession;
    if (!this.currentItem || !s) return 'idle';
    if (!this.out.started()) {
      // A settled-but-silent block (nothing generated) reads as ended, not a spinner
      // (native buffer-then-play only; web never surfaces a 0-byte complete block).
      if (this.native && s.generationDone && s.bytes === 0) return 'ended';
      return this.preState === 'buffering' ? 'buffering' : this.preState;
    }
    return this.out.activeState();
  }

  /** Push the current player state into the reactive signals the UI binds to. */
  private broadcast(): void {
    const s = this.currentSession;
    this.state.set(this.computeState());
    this.position.set(this.out.started() ? this.out.position() : 0);
    this.buffered.set(s ? s.seconds : 0);
    this.totalKnown.set(s ? s.complete : false);
    this.sentenceIndex.set(s && this.out.started() ? s.sentenceAt(this.out.position()) : -1);
    this.sentenceCount.set(s ? s.sentences.length : 0);
    this.sentences.set(s ? s.sentences : []);
    this.paused.set(!!s && this.out.userPaused());
    this.errorMessage.set(this.errorMsg);
    this.note.set(s?.note ?? null);
    this.currentId.set(this.currentItem?.id ?? null);
    this.currentLabel.set(this.currentItem?.label ?? null);
    this.upcomingIds.set(this.upcoming.map((i) => i.id));
    this.connectionError.set(this.connErr);
  }
}

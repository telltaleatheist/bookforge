/**
 * Offscreen document — owns the Crucible streaming session, the recorder's
 * WebSocket, PCM assembly, the audio player, the LRU cache, AND the play queue.
 * MV3 service workers can't hold an AudioContext/<audio> and get killed when
 * idle, so all of that lives here. One offscreen document serves every tab
 * (matching a Crucible's single streaming session). Background relays commands
 * in and broadcasts the queue snapshot out.
 *
 * ── Phase 16: speech comes straight from a Crucible ─────────────────────────
 *
 * Until now this document opened a WebSocket to BookForge on 8766, sent
 * `speak {text}`, and let the app segment the paragraph, schedule the rows and
 * relay them on from a Crucible. BookForge is out of that path
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md): this document
 *
 *   - picks the Crucible the user selected in Options (`src/servers.ts`),
 *   - normalizes, segments and packs the paragraph ITSELF, with the app's own
 *     code (`shared/listen-text/` — one source, bundled twice),
 *   - schedules its own read-ahead with the app's own policy
 *     (`shared/listen-client/session-policy.ts`),
 *   - and speaks the rows on one `POST /v1/tts/stream` session
 *     (`shared/listen-client/crucible-rows.ts`).
 *
 * It lives HERE and not in the service worker because an SSE stream cannot
 * survive the worker's 30-second idle kill, and because the audio is here.
 *
 * THE SESSION NEVER LOADS A VOICE. PHASE3-TTS.md §6: a render job may load its
 * voice; a stream may not. So the voice a page is read in is the voice RESIDENT
 * on the selected server, the popup's Load button is what makes one resident,
 * and a read with nothing resident is refused by name rather than quietly
 * loading whatever the picker was showing onto somebody else's card.
 *
 * The WebSocket that is left is the tab recorder's, and only that: it needs a
 * machine with a filesystem to write the FLAC. See protocol.ts.
 *
 * Queue model: one `current` item plays; `upcoming` items follow. ▶ moves an
 * item to current and plays immediately (preempting); ＋ appends to upcoming;
 * finishing the current item advances to the next; an empty queue stops.
 *
 * Playback strategy: assembled PCM16 plays through a single <audio> element
 * backed by a growing WAV blob (not scheduled Web Audio buffers), so the speed
 * slider can preserve pitch and pause/seek/replay/caching come for free. The
 * blob is rebuilt only at sentence boundaries, so swaps are inaudible.
 */

import { CrucibleRefused } from '@crucible/client';
import type { Activity, CrucibleClient, TtsStreamSession, VoiceInfo } from '@crucible/client';
import {
  BYTES_PER_SECOND,
  CLOSE_AUTH,
  SAMPLE_RATE,
  ServerEvent,
  ClientAction
} from './protocol';
import {
  RECORDER,
  SilenceWatch,
  bytesPerSecond,
  chunkFrameSize,
  relabelledSampleRate,
  secondsFromBytes,
  silenceStopReason,
  speedGuardRefusal
} from '../../shared/audio/tab-recording';
import {
  packListenChunks,
  speakableListenText,
  splitForTts,
  type ListenChunkBand
} from '../../shared/listen-text/index';
import { bandFromVoiceRow, isReadable } from './voice-band';
import {
  CRUCIBLE_STREAM_IN_FLIGHT,
  CRUCIBLE_STREAM_RAMP_WIDTH,
  CrucibleRowSession,
  ListenSessions,
  type ListenChunk,
  type ListenGeneratorPort
} from '../../shared/listen-client/index';
import {
  NO_SERVER_SELECTED,
  clientFor,
  type ServerEntry,
  CLIENT_NAME,
} from './servers';
import {
  describeHolder,
  type HolderNote,
  describeRefusal,
  loadVoice as loadVoiceJob,
  residentClipOf,
  unloadVoice as unloadVoiceJob,
  type ResidentClip
} from './crucible';
import { findClip, referenceFor } from './clips';
import { VoiceReferenceRefused } from '../../shared/crucible/voice-reference';
import {
  PlaybackStatus,
  QueueItem,
  QueueSnapshot,
  RunProgress,
  PlayItemCmd,
  PlaySequenceCmd,
  TransportCmd,
  RecordCmd,
  RecordingStatus,
  IDLE_RECORDING,
  EngineOffscreenCmd,
  EngineState,
  EngineStatus,
  QueueOffscreenCmd,
  SyncOffscreenCmd,
  SetVoiceOffscreenCmd,
  SetClipOffscreenCmd,
  SetIdleOffscreenCmd,
  ServerChangedOffscreenCmd,
  Settings,
  VoiceRow,
  DEFAULT_SETTINGS
} from './messages';

/**
 * Offscreen documents can't touch chrome.storage (only chrome.runtime), so we
 * fetch settings from the background via a message round-trip instead.
 */
async function getSettings(): Promise<Settings> {
  try {
    const r = await chrome.runtime.sendMessage({ target: 'background', cmd: 'get-settings' });
    return (r as Settings) ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type OffscreenMessage =
  | PlayItemCmd
  | PlaySequenceCmd
  | TransportCmd
  | RecordCmd
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd
  | SetVoiceOffscreenCmd
  | SetClipOffscreenCmd
  | SetIdleOffscreenCmd
  | ServerChangedOffscreenCmd;

// ─── Tunables ─────────────────────────────────────────────────────────────────

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
// Seamless playback beats time-to-first-audio: do not START a block that is still
// generating until enough of its audio is buffered that the generator can't be caught.
// How much that is depends entirely on how fast the generator is running, so the gate
// is ADAPTIVE (startThresholdSeconds) and these two are its floor and its margin.
//
// START_MIN_SECONDS is the floor applied to a generator that is already ahead of
// realtime: XTTS (multi-worker, token-streamed) and Orpheus/vLLM on the Windows box
// reach it within seconds, so for them the gate is effectively "12s buffered" and
// costs almost nothing. It is NOT sized for the slow case — that's the projection.
//
// The projection is what covers Orpheus/MLX. It delivers in BURSTS: the server no
// longer streams solo openers, so nothing at all arrives until a batch starts
// retiring rows, and then the buffer fills within a few seconds.
//
// The server RAMPS the first burst of the block being listened to (stream-scheduler
// STREAM_RAMP_WIDTH): the first wave is 8 sentences — ~60s of audio in ~28s of wall
// clock — and every wave after it is the full 16 (~120s in ~40s). So the first
// delivery lands ~15s sooner than it used to, and the ~60s it lands still covers the
// NEXT silence, which is a full-width batch's ~40s. The gate opens on that burst
// immediately: gapCover is maxGapSeconds (the wait for this first delivery, ~28s)
// plus margin, and 60s clears it with room. Note the ordering this reverses — the
// first gap is now SHORTER than the ones that follow, where it used to be the
// longest, so maxGapSeconds is no longer a strictly conservative stand-in for the
// next silence. The cushion is what covers it instead: a first burst is always at
// least ~1.5x the following batch's silence.
//
// So the wait before the first sentence is the pipeline itself — the model load plus
// the ramped first batch's depth — not the gate stacked on top of it. Shortening it
// further means loading the model before the user presses play (the reader prewarms
// on show, and a speak-triggered start now skips the engine's discarded warm-up
// renders); there is nothing left for the gate to give back.
const START_MIN_SECONDS = 12;
// Slack added on top of the projected deficit: the rate estimate is noisy early
// (one batch = one sample) and a block boundary costs a blob reload.
const SAFETY_MARGIN_SECONDS = 4;
// Assumed seconds of audio per not-yet-rendered sentence before anything has arrived
// to measure. ~135 chars of prose ≈ 7.5s at Orpheus's pace. Only used for the
// remaining-audio projection, and only until the first sentence lands.
const DEFAULT_SECONDS_PER_SENTENCE = 7.5;
// After the playhead catches the live edge (underrun), wait until this much new audio
// has buffered before reloading. Only ever consulted WHILE GENERATION IS STILL
// RUNNING — resumeIfReady() short-circuits on generationDone and reloads immediately —
// so it is sized for that case: resuming on ~1.5s against a below-realtime generator
// guarantees an immediate re-stall, i.e. a stutter loop. 4s gives the generator room
// to get back ahead. The buffering grace below hides the reload itself from the UI.
const RESUME_MIN_SECONDS = 4;
// ── FAST START (the "Buffer before playing" switch, OFF) ─────────────────────
// Owen's ruling of 2026-09-04: the gate above is right, and it costs half a minute
// of staring at a spinner. He wanted the other side of that bargain available
// without moving anything around, so the switch picks between two GATES, not
// between two settings of one gate — every constant and every line of reasoning
// above belongs to the ON path and is left exactly as it was.
//
// With the switch off, the session is started with fastStart:true and the server
// streams each sentence in ~0.34s chunks as it generates. There is then no cushion
// to wait for and no rate to project from: the whole point is to begin. One second
// is simply "enough audio that the <audio> element has something to chew on while
// the next chunk lands" — roughly three chunks at Orpheus's cadence.
//
// The same number covers an underrun, for the same reason. RESUME_MIN_SECONDS is 4
// because resuming early against a below-realtime BATCH generator guarantees an
// immediate re-stall; against a streaming one, audio is arriving continuously and
// waiting 4s is just four seconds of silence added to a stall the listener already
// heard. Stalls are the accepted cost of this mode — dragging them out is not.
const FAST_START_MIN_SECONDS = 1.0;
// Continuous read-ahead depth. Across a run of blocks, keep the single global server
// session generating upcoming blocks into the cache — in playback order — until this
// many seconds of audio sit ready ahead of the current block. Crossing a block
// boundary then plays from cache instead of stalling while the next block generates.
//
// TEN MINUTES, which is a policy and not a memory limit.
//
// The two shapes this has to serve are a news article and a whole book posted on one
// page. Ten minutes covers any short article ENTIRELY — a 3-minute read is rendered
// end to end while the listener is still on paragraph one, so nothing can interrupt it
// — while on a 9-hour page it renders ten minutes ahead and then STOPS, waiting for the
// listener to work their way down before generating more. Rendering further ahead than
// that is speculative work on audio nobody may reach: the engine is busy, the machine
// is warm, and abandoning a page throws all of it away.
//
// It was 2000s (33 minutes) — sized only as "a whole short article", which it achieved
// by being far larger than one. Cached audio is PCM16 mono @ 24 kHz = 48 KB/s, so this
// window is ~29 MB against the LRU's CACHE_LIMIT_BYTES (256 MB): the cap was never what
// bounded read-ahead, so raising or lowering this is a decision about compute, not RAM.
const PREFETCH_LOOKAHEAD_SECONDS = 600;
const SEEK_STEP_GRACE = 0.05;
// THE PAUSE AFTER A ROW IS NOT A CONSTANT HERE ANY MORE (Owen, 2026-09-18: "yes,
// it paces like the book... maybe the browser extension should handle the gaps for
// itself"). It was PARAGRAPH_GAP_SECONDS = 0.5, appended once at the end of a block
// and declared identically in BookForge's own player — while the sentences INSIDE a
// block were separated by the flat 0.3 s narrator baked into its audio, and a book
// of the same text was assembled at 0.6 s or at the voice's measured inject. Three
// numbers for one silence, none of them the book's.
//
// narrator sends bare speech now and states the gap it classified for each row
// (`gapSec` on that row's `done`, `text/gaps.classify_gap` — the same call that
// writes a book's gaps.json). This document inserts exactly that, after each row's
// audio and inside the block's own boundaries, so a paragraph read here paces the
// way the audiobook does and a seek still lands where the highlight says.
const STATUS_INTERVAL_MS = 300;
// A blob reload at a sentence boundary briefly ends/pauses the <audio> element.
// Reporting 'buffering' for those sub-second gaps makes the transport flicker at
// every sentence even when playback is smooth, so we only surface 'buffering' once
// a non-user stall has lasted at least this long (a genuine generation underrun).
const BUFFERING_GRACE_MS = 450;

// ─── PCM assembly ─────────────────────────────────────────────────────────────

interface Slot {
  chunks: Uint8Array[];
  done: boolean;
  /** Seconds of silence this row states must follow it, from its `done`. Null
   *  until the row retires — and never null after, because the scheduler refuses
   *  a row that finished without one. */
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
  /** Sentences [0, resumeFrom) came from a cached PARTIAL render — their audio is
   *  already in `segments`, and the server was asked to generate only from here
   *  on. 0 for a session rendered from scratch. */
  resumeFrom = 0;
  /** When this session's generation began (Date.now()), and the audio it already
   *  held at that moment (a cached partial prefix). Set when the speak goes out; a
   *  cached prefix must not be counted as freshly generated or the rate reads as
   *  instant. genStartedAt anchors the FIRST quiet interval (see maxGapSeconds);
   *  the rate itself is measured from firstArrivalAt. */
  genStartedAt = Date.now();
  baseSeconds = 0;
  /** When the FIRST audio of this session arrived, and how much was held then.
   *  Everything before that moment is start-up latency — engine boot, a model
   *  load, prompt prefill, the depth of the first batch — and none of it is
   *  generation SPEED. The gate projects from the window after this point, so a
   *  40s wait for the first Orpheus batch can't masquerade as a slow generator
   *  and buy itself another 40s of waiting. */
  firstArrivalAt: number | null = null;
  firstArrivalSeconds = 0;
  /** The last moment audio arrived, and the longest QUIET INTERVAL seen so far
   *  (the wait for the first delivery included). A batching engine delivers in
   *  bursts — nothing at all for a whole batch, then a flood — so the buffer has
   *  to cover the next silence, not merely beat the average rate. */
  lastArrivalAt: number | null = null;
  lastArrivalSeconds = 0;
  maxGapSeconds = 0;
  /** This session was started with fastStart:true — the server is streaming its
   *  sentences sub-sentence, and the fast gate applies to it. Carried on the SESSION
   *  rather than read from the live setting, because the setting can be flipped
   *  mid-read and a session must be judged by the bargain it was actually started
   *  under: a read-ahead session (never fast) that is later adopted keeps the gate
   *  its audio was generated for. */
  fastStart = false;

  constructor(requestId: string) { this.requestId = requestId; }

  initSlots(sentences: string[]): void {
    this.sentences = sentences;
    // A row from the cached prefix is already DONE and its gap is already inside
    // the audio that came back with it, so it has nothing left to insert.
    this.slots = sentences.map((_, i) => ({
      chunks: [], done: i < this.resumeFrom, gapSec: i < this.resumeFrom ? 0 : null,
    }));
  }
  addChunk(i: number, seq: number, bytes: Uint8Array): void {
    let slot = this.slots[i];
    if (!slot) { slot = { chunks: [], done: false, gapSec: null }; this.slots[i] = slot; }
    slot.chunks[seq] = bytes;
  }
  /** A row retired, with the silence narrator says follows it. Refused by name
   *  rather than defaulted: the audio is bare, so a number invented here is heard
   *  at every sentence boundary of the read. */
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
  /** A row the server refused. It contributes no audio AND no pause: there is no
   *  sentence there to pause after. */
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
        // THE ROW'S OWN PAUSE, INSIDE ITS BOUNDARY. `boundaries[i + 1]` is taken
        // after the silence, so a playhead sitting in the gap still maps to the
        // row that was speaking (`sentenceAt`), and a seek to row i + 1 starts on
        // its first sample rather than in the pause before it. A gap counted
        // outside the boundary would drift the highlight by its own length at
        // every row.
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
    // Freshly generated audio (not the cached prefix baseSeconds accounts for) has
    // landed — start the rate clock on the first one, and record how long the
    // silence before this delivery lasted.
    if (this.seconds > this.baseSeconds && this.seconds > this.lastArrivalSeconds) {
      const now = Date.now();
      const quiet = (now - (this.lastArrivalAt ?? this.genStartedAt)) / 1000;
      if (quiet > this.maxGapSeconds) this.maxGapSeconds = quiet;
      this.lastArrivalAt = now;
      this.lastArrivalSeconds = this.seconds;
      if (this.firstArrivalAt === null) {
        this.firstArrivalAt = now;
        this.firstArrivalSeconds = this.seconds;
      }
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

// ─── Cache ────────────────────────────────────────────────────────────────────

/**
 * Rendered audio for one block, keyed by (voice, text). Entries may be PARTIAL —
 * a read that was interrupted keeps whatever sentences it got, and the next play
 * resumes generation at `renderedCount` instead of paying to synthesize the same
 * words twice. Nothing here is ever thrown away to make room for a re-render: the
 * only ways out are the LRU cap and the user closing the page/controls.
 */
interface CacheEntry {
  segments: Uint8Array[];
  bytes: number;
  boundaries: number[];
  sentences: string[];
  /** sentences rendered so far — === sentences.length when complete */
  renderedCount: number;
  complete: boolean;
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();
let lruCounter = 0;

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry) entry.lastUsed = ++lruCounter;
  return entry;
}
function cachePut(key: string, entry: Omit<CacheEntry, 'lastUsed'>): void {
  // Never let a shorter partial overwrite a longer/complete render of the same text.
  const existing = cache.get(key);
  if (existing && (existing.complete || existing.renderedCount >= entry.renderedCount) && !entry.complete) {
    existing.lastUsed = ++lruCounter;
    return;
  }
  cache.set(key, { ...entry, lastUsed: ++lruCounter });
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  while (total > CACHE_LIMIT_BYTES && cache.size > 1) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, e] of cache) {
      if (k !== key && e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
    }
    if (!oldestKey) break;
    total -= cache.get(oldestKey)!.bytes;
    cache.delete(oldestKey);
    forgetRendered(oldestKey);
  }
}
async function cacheKeyFor(voice: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${voice} ${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Keep a session's audio — complete or partial — and record that its block now
 * holds that audio. The two happen together on purpose: "cached" and "marked
 * rendered" describe the same fact, and when they were separate calls the block
 * markers could disagree with what was actually on hand.
 *
 * `item` is the block the session belongs to, passed in rather than read from the
 * ambient `current`: by the time a finishing session is retained, `current` has
 * often already advanced to the next block, which credited the wrong paragraph.
 */
function retainSession(s: Session, item: QueueItem | null): void {
  const key = cacheKeyByRequest.get(s.requestId);
  if (!key || s.bytes === 0 || s.appendCursor === 0) return;
  cachePut(key, {
    segments: s.segments,
    bytes: s.bytes,
    boundaries: s.boundaries,
    sentences: s.sentences,
    renderedCount: s.appendCursor,
    complete: s.complete
  });
  if (item) markRendered(item, key, s.seconds, s.complete);
}

/**
 * Build a session preloaded with cached audio. A complete entry replays with no
 * server contact at all; a partial one comes back ready to have its tail generated
 * from `resumeFrom` — which is the whole point of keeping partials.
 */
function sessionFromCache(requestId: string, cached: CacheEntry): Session {
  const s = new Session(requestId);
  s.sentences = cached.sentences;
  s.segments = [...cached.segments];
  s.bytes = cached.bytes;
  s.boundaries = [...cached.boundaries];
  s.appendCursor = cached.renderedCount;
  s.resumeFrom = cached.complete ? 0 : cached.renderedCount;
  s.complete = cached.complete;
  s.generationDone = cached.complete;
  s.initSlots(cached.sentences);
  return s;
}

// ─── WAV assembly ─────────────────────────────────────────────────────────────

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

// ─── Player + queue state ─────────────────────────────────────────────────────

const audio = new Audio();
audio.preload = 'auto';

// ── Output gain ──────────────────────────────────────────────────────────────
// A plain <audio>.volume is capped at 1.0 (system volume). To let the user
// AMPLIFY beyond that, route the element through a Web Audio GainNode
// (MediaElementSource → GainNode → destination).
//
// IMPORTANT: once an element is wired into a MediaElementSource its audio flows
// ONLY through the graph, and an AudioContext starts SUSPENDED — so routing the
// element through a context we never resumed makes playback silently stall
// (currentTime stops advancing → perpetual "buffering"). So we ONLY build the
// graph when the user actually wants gain != 1, and we resume the context when
// we do. At volume 1 (the default) playback uses the bare <audio> element,
// untouched — exactly as before the volume feature existed.
const MAX_VOLUME = 3; // 3x — past this, clipping dominates
let audioCtx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let outputVolume = 1;

function applyGain(): void {
  if (gainNode) gainNode.gain.value = outputVolume;
}
function ensureGainGraph(): void {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return;
  }
  try {
    audioCtx = new AudioContext();
    const srcNode = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    srcNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    applyGain();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch (e) {
    // Fall back to the bare element so playback still works.
    console.error('[BFR offscreen] gain graph init failed:', e);
    audioCtx = null;
    gainNode = null;
  }
}
function setOutputVolume(v: number): void {
  outputVolume = Math.max(0, Math.min(MAX_VOLUME, v));
  // Engage the Web Audio graph only to amplify/attenuate; leave default playback
  // on the bare element. Once built, the graph stays (gain 1 = transparent).
  if (outputVolume !== 1) ensureGainGraph();
  applyGain();
}
// Restore the persisted level (engaged on play only if it's non-default).
try {
  void chrome.storage.local.get('volume').then((s) => {
    if (typeof s.volume === 'number') outputVolume = Math.max(0, Math.min(MAX_VOLUME, s.volume));
  });
} catch { /* orphaned context */ }

// queue — the run is `history` (played) + `current` + `upcoming` (queued), in
// reading order. History is kept so the transport can show one progress bar for
// the whole read and a backward seek can cross block boundaries.
let history: QueueItem[] = [];
let current: QueueItem | null = null;
let upcoming: QueueItem[] = [];

/** Every block of the current run, in order. */
function runItems(): QueueItem[] {
  return current ? [...history, current, ...upcoming] : [...history, ...upcoming];
}

// Measured seconds per item id, learned as blocks render. Kept even after audio is
// evicted — it costs a number and keeps the run's total from jumping when the LRU
// drops something we already know the length of.
const measured = new Map<string, number>();
// Item id → the rendered audio held for it (cache key + how much + whether it's
// the whole block). This is what "already rendered" means everywhere: the page's
// block markers, the seek limit, and the read-ahead's notion of depth.
const renderedByItem = new Map<string, { key: string; seconds: number; complete: boolean }>();

// Speech rate for estimating blocks that haven't rendered yet, refined from every
// block that has. Seeded near Orpheus's natural pace so the first estimate is sane.
const DEFAULT_CHARS_PER_SECOND = 15;
let measuredChars = 0;
let measuredSeconds = 0;

function charsPerSecond(): number {
  return measuredSeconds > 2 ? measuredChars / measuredSeconds : DEFAULT_CHARS_PER_SECOND;
}
function recordMeasurement(item: QueueItem, seconds: number): void {
  if (seconds <= 0) return;
  measured.set(item.id, seconds);
  measuredChars += item.text.length;
  measuredSeconds += seconds;
}
function itemSeconds(item: QueueItem): number {
  return measured.get(item.id) ?? item.text.length / charsPerSecond();
}

function markRendered(item: QueueItem, key: string, seconds: number, complete: boolean): void {
  if (!key || seconds <= 0) return; // nothing replayable to point at
  renderedByItem.set(item.id, { key, seconds, complete });
  if (complete) recordMeasurement(item, seconds);
}
/** Drop the rendered-audio record for an evicted cache key. */
function forgetRendered(key: string): void {
  for (const [id, r] of renderedByItem) if (r.key === key) renderedByItem.delete(id);
}
/** Rendered audio is voice-specific; a switch invalidates every record (the cache
 *  entries themselves stay, keyed by the old voice, in case the user switches back). */
function forgetAllRendered(): void {
  renderedByItem.clear();
}

/**
 * Progress across the whole run. `rendered` stops at the first block that isn't
 * fully rendered, so it reads as "the bar is real audio up to here" — which is
 * exactly the region a seek may land in.
 */
function runProgress(): RunProgress {
  const before = history.reduce((n, it) => n + itemSeconds(it), 0);
  const cur = current ? itemSeconds(current) : 0;
  const after = upcoming.reduce((n, it) => n + itemSeconds(it), 0);

  let rendered = before;
  let contiguous = true;
  if (current) {
    const held = session ? session.seconds : (renderedByItem.get(current.id)?.seconds ?? 0);
    rendered += held;
    contiguous = !!session && session.complete;
  }
  if (contiguous) {
    for (const it of upcoming) {
      const r = renderedByItem.get(it.id);
      if (!r?.complete) break;
      rendered += r.seconds;
    }
  }

  const estimated = runItems().some((it) => !measured.has(it.id));
  return {
    position: before + (started ? audio.currentTime : 0),
    total: before + cur + after,
    rendered: Math.min(rendered, before + cur + after),
    estimated
  };
}

// Read-ahead: while the current item plays, generate upcoming blocks into the cache
// CONCURRENTLY — each as its own server session ({preempt:false, background:true}) —
// so every engine worker stays busy instead of dribbling one block at a time. That's
// the whole game on CPU (Mac), where a single worker can't keep ahead of playback and
// the per-block pipeline otherwise behaves like one worker. On advance we "adopt" a
// finished (or still-in-flight) read-ahead session as the current player.
const prefetches = new Map<string /* requestId */, { session: Session; item: QueueItem }>();
const startingItems = new Set<string /* item id */>(); // items mid-start (async-gap guard)

// player (for the current item)
let session: Session | null = null;
/** The block `session` belongs to, pinned when the session is installed. `current`
 *  moves on before a finishing session is retained, so it can't be trusted for
 *  crediting audio to a block. */
let sessionItem: QueueItem | null = null;
let started = false;
let userPaused = false;
let blobBytes = 0;
let blobUrl: string | null = null;
let rate = 1;
let errorMsg: string | null = null;
let preState: 'connecting' | 'starting-engine' | 'buffering' = 'connecting';
// performance.now() when a non-user stall began (underrun or in-flight blob
// reload), or null when audio is progressing normally. Drives the buffering grace.
let stallSince: number | null = null;
let finishedSent = false;
let lastReportedSentence = -1;
// The furthest sentence of the CURRENT session playback has actually reached — a
// high-water mark, sampled by the status ticker.
//
// `session.sentenceAt(audio.currentTime)` is the live answer, but it is only valid
// while the <audio> element holds the blob it was measured against. Every underrun
// and every sentence-boundary reload replaces `audio.src` and calls load(), and
// until 'loadedmetadata' fires and loadBlob's handler restores the position,
// currentTime reads 0 — so asking mid-reload says "sentence 0" about a listener who
// is ten sentences in. That window is not rare: it is exactly when a stalling
// generator makes someone reach for the voice picker. The high-water mark is what
// survives it. Reset wherever a new session is installed.
let playedSentence = 0;
// When the user clicks mid-block, the fraction (0..1) into the block where playback
// should begin. Resolved to a sentence boundary once that sentence is buffered, so
// the existing/cached audio is reached by a seek rather than re-synthesized. null
// for a normal start-at-top read.
let pendingStartFraction: number | null = null;
let playSeq = 0;
let reqCounter = 0;
const cacheKeyByRequest = new Map<string, string>();

// ─── The Crucible this document reads from ────────────────────────────────────
//
// One selected server, one streaming session, one resident voice. Everything
// below is what used to be a WebSocket to BookForge on 8766.

/** The registry entry the user selected in Options, re-read on every change. */
let server: ServerEntry | null = null;
/** A client bound to it. Null whenever `server` is. */
let client: CrucibleClient | null = null;
/** `GET /v1/voices` from that server, as the pickers draw them. */
let voiceRows: VoiceRow[] = [];
/** Voice ids only — what the in-page toolbar's picker shows. */
let voices: string[] = [];
/** The voice on that server's card right now, as the server last reported it. */
let serverVoice: string | null = null;
/** What KIND of thing holds the card (`tts`, `llm`, …), or null. */
let residentKind: string | null = null;
/** The server's backend word (`cuda-linux` / `mlx-darwin`), once probed. */
let backend: string | null = null;
/** A load or unload job this extension started. */
let engineBusy: 'loading' | 'unloading' | null = null;
/** The job's latest line, or the refusal that ended it. */
let engineNote: string | null = null;
/** Who else holds the engine there, from `/v1/activity`, after a refusal. */
let engineHolder: HolderNote | null = null;
/** Why nothing can be read right now, in the server's own words. */
let connectionError: string | null = null;

/** The open streaming session and the band its voice packs to. */
interface LiveStream {
  readonly session: TtsStreamSession;
  readonly rows: CrucibleRowSession;
  /** The voice it speaks. One session, one voice. */
  readonly voice: string;
  /** The length band rows are packed to, from that voice's own `maxChars`. */
  readonly band: ListenChunkBand;
}
let live: LiveStream | null = null;
/** One session at a time, and one attempt to open it at a time. */
let opening: Promise<LiveStream | null> | null = null;

/** The engine state the popup and the page draw. */
function engineState(): EngineState {
  if (engineBusy === 'loading') return 'starting';
  return serverVoice !== null && residentKind === 'tts' ? 'running' : 'stopped';
}

/** Everything the snapshot says about the selected Crucible. */
function engineStatus(): EngineStatus {
  return {
    server: server?.name ?? null,
    url: server?.url ?? null,
    backend,
    resident: serverVoice,
    residentKind,
    busy: engineBusy,
    note: engineNote,
    holder: engineHolder,
    idleMinutes,
    residentClip: residentClip === null ? null : (residentClip.name ?? residentClip.sha256.slice(0, 12)),
    residentClipNote,
  };
}

function isConnected(): boolean {
  return client !== null && connectionError === null;
}

/**
 * The voice a read will be spoken in.
 *
 * THE RESIDENT ONE, and nothing else. A streaming session never loads
 * (PHASE3-TTS.md §6), so what the picker is showing is only ever what the
 * popup's Load button WOULD make resident — reading in it before it is on the
 * card would be reading in a voice the server does not have.
 */
function voiceForSpeak(): string | null {
  return residentKind === 'tts' ? serverVoice : null;
}

/** The picker's own choice, which Load acts on. Persisted; may not be resident. */
let chosenVoice: string | null = null;
/**
 * The clip a zero-shot load will be cloned from — an id in the IndexedDB clip
 * store, or null for "none picked".
 *
 * NULL IS NOT A DEFAULT WAITING TO BE FILLED. A `zeroshot` load with no clip
 * is refused `reference_required` — by this document before it asks, and by
 * the server if it ever got there — because the base weights with no reference
 * are the MODEL'S own speaker under a voice id somebody chose for a person's.
 */
let chosenClipId: string | null = null;
/** What `/v1/activity` says was cloned onto that card, or null. */
let residentClip: ResidentClip | null = null;
/** Why `residentClip` is null when the answer is not "nothing was cloned". */
let residentClipNote: string | null = null;
/** A load-voice job for this voice is in flight. */
let switchingVoice: string | null = null;
/**
 * THE LOAD IN FLIGHT, as a promise a reader can wait on.
 *
 * Owen, 2026-09-20: *"it says its loaded in memory but the extension isnt
 * playing it."* Crucible (1.0.11+) clears the card the moment nothing holds it,
 * so a voice leaves the card every time a reading session closes. The next
 * play then fired two things at once — the reader's prewarm `engine load`, and
 * `ensureStream`'s open — and the open lost: `409 engine_in_use` while the load
 * job held the claim, a refusal the session path treated as final. The user
 * saw the voice arrive on the card and nothing read.
 *
 * `ensureStream` now waits for this before it opens, and starts it itself when
 * nothing is on the card and a voice is picked — the same act the prewarm
 * performs, in the order that works.
 */
let loading: Promise<void> | null = null;
/** Bumped per voice switch, so an earlier one that is still loading can tell it
 *  has been superseded and bow out instead of restarting playback late. */
let voiceSwitchToken = 0;
/** Minutes of no reading before this extension unloads (0 = never). */
let idleMinutes = DEFAULT_SETTINGS.idleMinutes;

function sameVoice(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * WHICH CLIP IS ON THAT CARD — asked on every server read.
 *
 * `zeroshot` is one voice id and any number of recordings, so "zeroshot is
 * resident" is not an answer to "will my book be read in the voice I picked".
 * A failure here is RECORDED AND SHOWN, never swallowed: not knowing which
 * clip is loaded is exactly the state this read exists to end, and a blank
 * where the clip name goes reads as "no clip", which would be a lie.
 */
async function readResidentClip(named: ServerEntry): Promise<void> {
  try {
    residentClip = await residentClipOf(named);
    residentClipNote = null;
  } catch (err) {
    residentClip = null;
    residentClipNote = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Is the clip already on the card the one that was picked?
 *
 * TWO FACTS, both from the server's own report: the clip's `name` and its
 * duration. One would not do — a name is a label a person typed and two
 * clients may each have typed it, and a duration alone is shared by every
 * fifteen-second clip. The sha256 beside them is the real identity, and this
 * client deliberately does NOT compute one: hashing a megabyte in the
 * offscreen document on every Load press to save a reload is the wrong trade,
 * and disagreeing with the server about a hash would be worse than reloading.
 *
 * WHEN IT CANNOT TELL, IT RELOADS. A false "same clip" reads a whole book in
 * somebody else's voice and reports success; a false "different clip" costs
 * one load.
 */
function residentClipIsTheChosenOne(chosen: { name: string; seconds: number }): boolean {
  if (residentClip === null || residentClip.name === null) return false;
  return residentClip.name === chosen.name
    && Math.abs(residentClip.seconds - chosen.seconds) < 0.05;
}

function persistVoice(voice: string): void {
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'put-settings', patch: { voice } })
    .catch(() => { /* background asleep; storage is re-read on next start */ });
}

/**
 * Ask background which Crucible is selected (an offscreen document cannot read
 * chrome.storage), and bind a client to it.
 *
 * NOTHING IS GUESSED. No selection is not "use the first one" and not "use
 * localhost": it is a named state the popup and the page both show, with the
 * one sentence that says how to fix it.
 */
async function bindServer(): Promise<boolean> {
  let entry: ServerEntry | null;
  try {
    entry = await chrome.runtime.sendMessage({ target: 'background', cmd: 'get-server' }) as ServerEntry | null;
  } catch {
    connectionError = 'The extension\'s background page is not answering; reload the extension.';
    return false;
  }
  if (entry === null || entry === undefined) {
    server = null;
    client = null;
    backend = null;
    voiceRows = [];
    voices = [];
    serverVoice = null;
    residentKind = null;
    connectionError = NO_SERVER_SELECTED;
    return false;
  }
  if (server === null || server.name !== entry.name || server.url !== entry.url
      || server.token !== entry.token) {
    server = entry;
    client = clientFor(entry);
    backend = null;
    voiceRows = [];
    voices = [];
    serverVoice = null;
    residentKind = null;
  }
  connectionError = null;
  return true;
}

/**
 * Read the selected server: what it runs on, which voices it has, and what is
 * on its card. Every refusal is the server's own, by name, and nothing is
 * retried — an unreachable Crucible is not a slow one.
 */
async function refreshServer(): Promise<boolean> {
  if (!(await bindServer())) return false;
  const bound = client;
  const named = server;
  if (bound === null || named === null) return false;
  try {
    const info = await bound.info();
    backend = info.host.backend;
    if (!info.jobTypes.includes('tts')) {
      connectionError = `Crucible "${named.name}" does not serve speech (its job types are `
        + `${info.jobTypes.join(', ') || 'none'}). Pick a server that does, in Options.`;
      return false;
    }
    const health = await bound.health();
    residentKind = health.residentKind;
    serverVoice = health.residentKind === 'tts' ? (health.residentModels[0] ?? null) : null;
    const rows = await bound.voices();
    voiceRows = rows.map((v: VoiceInfo): VoiceRow => ({
      id: v.id,
      display: v.display,
      engine: v.narratorEngine,
      loadable: v.loadable,
      reason: v.reason,
      resident: v.resident,
      // THE ROW'S FACT, never inferred from the id: a server is entitled to
      // call a zero-shot voice anything it likes, and a picker that guessed
      // from the name would hide the clip list on the day it was renamed.
      needsReference: v.needsReference,
      // VERBATIM, NULLS AND ALL. `pace` is always an object on the wire and
      // its members are what go null (crucible `voices.py` `Pace.to_dict`), so
      // there is nothing to guard here — and nothing to substitute either:
      // `voice-band.ts` is the one place a null becomes a decision.
      lengths: {
        maxChars: v.maxChars,
        safeMinChars: v.pace.safeMinChars,
        safeMaxChars: v.pace.safeMaxChars,
      },
    }));
    voices = voiceRows.map((v) => v.id);
    await readResidentClip(named);
    // The picker adopts the resident voice, exactly as it used to adopt the
    // app's: what is on the card is the truth, and a stored choice that names
    // something else is a choice, not a claim about the server.
    if (serverVoice !== null && !switchingVoice) chosenVoice = serverVoice;
    // The opening pick is the first voice this extension can actually READ
    // with, not simply the first row. Since 2026-09-19 a server may list a
    // screening checkpoint that states no measured length (PHASE18 §4), and
    // landing on one by alphabetical accident would hand the user a voice that
    // loads, shows green, and refuses at the moment they press play. It is not
    // a fallback: nothing is substituted, and when NO row is readable
    // `chosenVoice` stays null and the speak door says so by name.
    if (chosenVoice === null) {
      const readable = voiceRows.find((v) => isReadable(v.lengths));
      if (readable !== undefined) chosenVoice = readable.id;
    }
    connectionError = null;
    return true;
  } catch (err) {
    connectionError = describeRefusal(err, named.name);
    return false;
  }
}

/**
 * The band one row of this voice may occupy, from the SERVER's own numbers.
 *
 * The lengths live ON the row (`VoiceRow.lengths`) and the decision lives in
 * `voice-band.ts`, so the popup offers exactly the voices this can answer for.
 * There was a second `voiceCaps` map here until 2026-09-19 holding a private
 * copy of `maxChars`; it is gone, because a fact with two owners is this
 * system's recurring defect and the popup could not see that one at all.
 *
 * The lengths are the (voice, backend) certificate in CHARACTERS — nothing in
 * `tts` carries a token cap on the wire. A voice whose row states no length in
 * EITHER spelling is refused by name rather than packed to a number from
 * somewhere else; there is no local catalog in a browser extension to reach
 * for, and there would be nothing right in it if there were.
 */
function bandFor(voice: string): ListenChunkBand {
  const named = server?.name ?? '?';
  const row = voiceRows.find((v) => v.id === voice);
  if (row === undefined) {
    throw new Error(`Crucible "${named}" does not list a voice called "${voice}".`);
  }
  return bandFromVoiceRow(voice, named, row.lengths);
}

/**
 * Open the streaming session, or say why not.
 *
 * It does NOT load. `voice_not_resident` comes back naming what IS resident,
 * and this turns it into "press Load voice" — never into a load-voice job on a
 * card somebody else may be using.
 */
async function ensureStream(): Promise<LiveStream | null> {
  if (live !== null) return live;
  if (opening !== null) return opening;
  opening = (async (): Promise<LiveStream | null> => {
    if (!(await refreshServer())) return null;
    const bound = client;
    const named = server;
    if (bound === null || named === null) return null;
    /*
     * THE VOICE FIRST, THEN THE SESSION — in that order, and never racing.
     *
     * Crucible clears the card the moment nothing holds it, so the ordinary
     * state at the start of a read is "nothing resident": the previous session
     * closed and took the voice with it. A load may already be in flight (the
     * reader prewarms on show); if so this waits for it. If nothing is on the
     * card and a voice is picked, this performs the load itself — the same act
     * the prewarm performs, so no new permission is being taken here — and a
     * card holding something ELSE (a model, another kind) is left exactly as
     * the popup's warning says: this extension does not take it from whatever
     * put it there.
     */
    if (loading !== null) {
      await loading.catch(() => { /* the load said why, in engineNote */ });
    }
    let voice = voiceForSpeak();
    if (voice === null && residentKind === null && chosenVoice !== null) {
      await loadPickedVoice(chosenVoice, { open: false });
      voice = voiceForSpeak();
    }
    if (voice === null) {
      connectionError = engineNote
        ?? `Nothing is loaded on Crucible "${named.name}". Open this extension's `
          + 'popup and press "Load voice" — a reading session never loads one itself.';
      return null;
    }
    let band: ListenChunkBand;
    try {
      band = bandFor(voice);
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
      return null;
    }
    let session: TtsStreamSession;
    try {
      session = await openWaitingOutOurselves(bound, voice);
    } catch (err) {
      connectionError = describeRefusal(err, named.name);
      await noteHolder();
      return null;
    }
    if (session.sampleRate !== SAMPLE_RATE) {
      // The player's byte arithmetic, its WAV header and its cache are all
      // 24 kHz. A voice at another rate would play at the wrong speed and
      // sound like a broken model; it is refused by name instead.
      await session.close().catch(() => { /* already gone */ });
      connectionError = `Voice "${voice}" on Crucible "${named.name}" produces `
        + `${session.sampleRate} Hz audio, and this extension's player is built for `
        + `${SAMPLE_RATE} Hz. Refusing to read rather than play it at the wrong speed.`;
      return null;
    }
    const rows = new CrucibleRowSession(session, {
      warn: (line: string) => console.warn('[BFR]', line),
    });
    const opened: LiveStream = { session, rows, voice, band };
    live = opened;
    connectionError = null;
    console.log(`[BFR] reading from ${named.name}: ${voice} → ${session.fingerprint}, `
      + `${session.sampleRate} Hz, ${session.backend}`);
    // One reader for the session's frames, for as long as it lives.
    void rows.run().then((reason) => {
      if (live === opened) live = null;
      console.log(`[BFR] session ${session.sessionId} ended: ${reason}`);
      /*
       * A LOOP THAT ENDED WITHOUT THE SERVER CLOSING THE SESSION LEAVES AN
       * ORPHAN: the server keeps it for its grace window, the next open here is
       * refused `stream_session_open` for a session nobody is reading, and only
       * then does the server close it and clear the card (2026-09-20, seen as
       * `409` → "closed" → "unloaded" in the server log, once per play). Closing
       * it here is what the reader owes; a close the server has already done is
       * refused and that refusal is not news.
       */
      void session.close().catch(() => { /* already gone */ });
      broadcast();
    });
    return opened;
  })();
  try { return await opening; } finally { opening = null; }
}

/**
 * OPEN THE SESSION — EVICTING OUR OWN ORPHAN, WAITING OUT OUR OWN LOAD.
 *
 * Two refusals at the open are about THIS extension and are not answers:
 *
 *  - `stream_session_open` naming a session THIS browser opened. Its reader is
 *    gone or stuck (the server saw one live for fourteen minutes on 2026-09-20,
 *    seven rows rendered, nothing played, never closed — and every play after
 *    it was refused). A session this browser opened is this browser's to close:
 *    it is DELETEd and the open is asked again, at once. Waiting for it was the
 *    first draft of this rule and it never cleared, because a reader that is
 *    still attached keeps the session out of the server's grace window forever.
 *  - `engine_in_use` while our own load job is settling its claim — seconds,
 *    so a bounded wait and one more ask.
 *
 * A holder that is NOT us is a real refusal and comes straight back. "Us" is
 * `describeHolder(...).ours`: the job id, this browser's User-Agent, or the
 * name the SDK is asked to send.
 */
async function openWaitingOutOurselves(
  bound: CrucibleClient,
  voice: string,
): Promise<TtsStreamSession> {
  try {
    return await bound.stream({ voice, language: LISTEN_LANGUAGE });
  } catch (err) {
    if (!(err instanceof CrucibleRefused)) throw err;
    if (err.code !== 'stream_session_open' && err.code !== 'engine_in_use') throw err;
    const self = { userAgent: navigator.userAgent, clientName: CLIENT_NAME };
    let activity: Activity;
    try {
      activity = await bound.activity();
    } catch {
      throw err;   // cannot tell whose it is; the original refusal stands
    }
    const holder = describeHolder(activity, self);
    if (holder !== null && !holder.ours) throw err;   // somebody else's — a real refusal
    if (activity.streaming !== null && holder?.ours) {
      // OUR orphan. Close it and go again.
      console.warn(`[BFR] evicting this browser's own stale session ${activity.streaming.sessionId}`);
      await evictOwnSession(activity.streaming.sessionId);
      return await bound.stream({ voice, language: LISTEN_LANGUAGE });
    }
    // Our own load settling: wait it out, bounded, then ask once more.
    const deadline = Date.now() + OUR_ORPHAN_WAIT_MS;
    while (Date.now() < deadline) {
      let now: Activity;
      try { now = await bound.activity(); } catch { throw err; }
      const h = describeHolder(now, self);
      if (h === null) break;
      if (!h.ours) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return await bound.stream({ voice, language: LISTEN_LANGUAGE });
  }
}

/**
 * `DELETE /v1/tts/stream/{id}` for a session this browser opened and no longer
 * has a handle to. The SDK closes only the session object it handed out, and
 * an orphan by definition has none — so this speaks the one wire line the
 * `crucible api stream close` door speaks, with the server the reader is bound
 * to. A refusal here (already gone) is not news; the re-open decides.
 */
async function evictOwnSession(sessionId: string): Promise<void> {
  const entry = server;
  if (entry === null) return;
  try {
    await fetch(`${entry.url}/v1/tts/stream/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${entry.token}`, 'X-Crucible-Api': '1' },
    });
  } catch (err) {
    console.warn('[BFR] could not close the stale session:', err);
  }
}

/** How long this reader waits for its own orphaned session or settling load to clear. */
const OUR_ORPHAN_WAIT_MS = 20_000;

/** Close the session (and free the voice's claim) without unloading the voice. */
async function closeStream(reason: string): Promise<void> {
  const open = live;
  if (open === null) return;
  live = null;
  try {
    await open.rows.close(reason);
  } catch (err) {
    console.warn('[BFR] closing the reading session:', err);
  }
}

/** After a refusal, say WHO holds the engine — never take it from them. */
async function noteHolder(): Promise<void> {
  const bound = client;
  if (bound === null) { engineHolder = null; return; }
  try {
    engineHolder = describeHolder(await bound.activity(), {
      userAgent: navigator.userAgent,
      clientName: CLIENT_NAME,
    });
  } catch {
    // The holder line is a courtesy; a server that will not answer /v1/activity
    // has already failed the thing the caller actually asked for.
    engineHolder = null;
  }
}

/**
 * The language every row is spoken in.
 *
 * The same literal the app's three Listen surfaces use
 * (`electron/crucible/stream.ts`'s `LISTEN_LANGUAGE`). The extension has no
 * per-page language today; when it grows one, this is the field it fills.
 */
const LISTEN_LANGUAGE = 'en';

// ─── The read-ahead policy, on the app's own code ─────────────────────────────

/** What a row's settings carry. A session speaks one voice, so this is a check. */
interface ReadSettings { voice: string }

/**
 * PCM16 samples as the little-endian bytes the player's WAV blob wants.
 *
 * Written a sample at a time through a DataView rather than by viewing the
 * Int16Array's buffer: that view is the HOST's byte order, and a WAV file's is
 * always little-endian. Every browser this extension runs in is little-endian
 * today, which is exactly why the assumption would never be caught.
 */
function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  return bytes;
}

/**
 * The generator the shared session policy dispatches to: one Crucible row per
 * sentence-chunk, on the open session.
 */
const crucibleGenerator: ListenGeneratorPort<Uint8Array, ReadSettings> = {
  isReady: () => live !== null,
  concurrency: () => ({ cap: CRUCIBLE_STREAM_IN_FLIGHT, batching: true }),
  rampWidth: () => CRUCIBLE_STREAM_RAMP_WIDTH,
  abandonStaleBatch: () => { live?.rows.cancelStale(); },
  generate: async (text, sentenceIndex, settings, _priority, isStale, onChunk) => {
    const open = live;
    if (open === null) return { success: false, error: 'the reading session is closed' };
    if (settings.voice !== '' && !sameVoice(settings.voice, open.voice)) {
      // A session speaks ONE voice. Rendering in whatever is loaded would be
      // the wrong narrator delivered as a success.
      return {
        success: false,
        error: `the reading session speaks '${open.voice}', not the requested '${settings.voice}'`,
      };
    }
    rowCounter += 1;
    const id = `r${rowCounter}`;
    let outcome;
    try {
      outcome = await open.rows.say(text, {
        id,
        isCancelled: isStale,
        onChunk: onChunk === undefined
          ? undefined
          : (chunk) => onChunk({
              seq: chunk.seq,
              data: pcm16ToBytes(chunk.pcm),
              duration: chunk.seconds,
              sampleRate: chunk.sampleRate,
            } satisfies ListenChunk<Uint8Array>),
      });
    } catch (err) {
      return { success: false, error: describeRefusal(err, server?.name ?? '?') };
    }
    if (!outcome.success) return { success: false, error: outcome.error };
    // THE ROW'S PAUSE COMES BACK WITH ITS AUDIO and is passed straight through:
    // `crucible-rows.ts` has already refused a successful row that arrived
    // without one, and the policy refuses a success this layer returns without
    // one, so nothing here has a default to reach for.
    if (outcome.streamed === true) {
      return {
        success: true, streamed: true, duration: outcome.seconds ?? 0, gapSec: outcome.gapSec,
      };
    }
    console.debug('[BFR] row', id, 'sentence', sentenceIndex, 'done');
    return {
      success: true,
      gapSec: outcome.gapSec,
      audio: {
        data: pcm16ToBytes(outcome.pcm as Int16Array),
        duration: outcome.seconds ?? 0,
        sampleRate: open.rows.sampleRate,
      },
    };
  },
};

/** Row ids are unique per session; the counter simply never repeats one. */
let rowCounter = 0;

/**
 * THE SAME READ-AHEAD POLICY THE APP RUNS — read-ahead window, background
 * prefetch, preempt, playhead, first-wave ramp (shared/listen-client).
 *
 * Its events are the five the old socket sent, with one difference: `data` is
 * raw PCM16 bytes rather than base64, because there is no socket to put them
 * on any more.
 */
const listen = new ListenSessions<Uint8Array, ReadSettings>(
  crucibleGenerator,
  () => { /* every session passes its own sink */ },
  (line) => console.log('[BFR listen]', line),
);

/** One scheduler event, as this document's handlers read it. */
type ListenEvent = {
  kind: 'chunk' | 'done' | 'failed' | 'complete' | 'cancelled';
  requestId: string;
  sentenceIndex?: number;
  seq?: number;
  data?: Uint8Array;
  duration?: number;
  /** On `done`: the silence this row states must follow it. See Session.markDone. */
  gapSec?: number;
  error?: string;
};

/** Route a session's events to the player or to its read-ahead accumulator. */
function sinkFor(requestId: string): (event: Record<string, unknown>) => void {
  return (event) => {
    const e = event as unknown as ListenEvent;
    const prefetch = prefetches.get(requestId);
    if (prefetch) { handlePrefetchEvent(prefetch, e); return; }
    handleListenEvent(e);
  };
}

// ─── The recorder's socket ────────────────────────────────────────────────────
//
// BookForge's 8766, and ONLY for tab recording: capture hands raw PCM to a
// machine with a filesystem and its ffmpeg writes the FLAC. Speech does not
// come through here any more (see this file's header).

let ws: WebSocket | null = null;
let authed = false;
let connectPromise: Promise<void> | null = null;

function recorderSocketOpen(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN && authed);
}

/**
 * Connect, retrying a couple of times before giving up. A single failed socket is
 * usually just the app mid-restart or the port not yet bound; surfacing "can't
 * reach BookForge" on the first miss made the user re-click for something that
 * would have worked a beat later. A rejected token is NOT retried — that won't fix
 * itself.
 */
async function ensureRecorderSocket(): Promise<void> {
  const backoff = [0, 400, 1200];
  let lastError: Error | null = null;
  for (const wait of backoff) {
    if (recorderSocketOpen()) return;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      await connectOnce();
      return;
    } catch (err) {
      lastError = err as Error;
      if (lastError.message === 'BAD_TOKEN' || lastError.message === 'NO_TOKEN') throw lastError;
    }
  }
  throw lastError ?? new Error('CONNECT_FAILED');
}

async function connectOnce(): Promise<void> {
  if (recorderSocketOpen()) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const settings = await getSettings();
    // No token required for the default localhost connection: BookForge trusts
    // this extension by its (forge-proof) Origin. A token is only needed for a
    // LAN server (host other than 127.0.0.1); send it when present, else ''.
    const url = `ws://${settings.host}:${settings.port}`;

    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try { socket = new WebSocket(url); } catch { reject(new Error('CONNECT_FAILED')); return; }
      ws = socket;
      authed = false;
      // Per-socket authed flag: onclose keys its reject/finalize decision off THIS
      // socket's own auth state, not the global `authed` (which a newer connection may
      // have already flipped back to true). Without it, a stale socket's late close
      // would clear a healthy new connection's auth and truncate its live session.
      let socketAuthed = false;
      const timeout = setTimeout(() => {
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error('CONNECT_TIMEOUT'));
      }, 8000);

      socket.onopen = () => socket.send(JSON.stringify({ action: 'hello', token: settings.token } satisfies ClientAction));
      socket.onmessage = (e) => {
        let msg: ServerEvent;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'hello') {
          authed = true;
          socketAuthed = true;
          clearTimeout(timeout);
          console.log('[BFR] recorder socket up');
          resolve();
        }
        handleServerEvent(msg);
      };
      socket.onclose = (e) => {
        clearTimeout(timeout);
        if (ws !== socket) {
          // A newer socket already owns the connection; this stale socket's late close
          // must not touch the global auth/session state. Still surface a pre-hello
          // failure to whoever awaited THIS socket's connect (no-op if already settled).
          if (!socketAuthed) reject(new Error(e.code === CLOSE_AUTH ? 'BAD_TOKEN' : 'CONNECT_FAILED'));
          return;
        }
        authed = false;
        ws = null;
        if (!socketAuthed) reject(new Error(e.code === CLOSE_AUTH ? 'BAD_TOKEN' : 'CONNECT_FAILED'));
        else onSocketClosed();
      };
      socket.onerror = () => { /* close fires next with the disposition */ };
    });
  })();

  try { await connectPromise; } finally { connectPromise = null; }
}

function send(action: ClientAction): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
}

/** Raw PCM for the tab recorder. Binary frames are legal ONLY between
 *  record.started and record.stop/cancel — see the recorder section below, which
 *  is the only caller. */
function sendBinary(pcm: ArrayBuffer): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm);
}

function onSocketClosed(): void {
  // The server finalizes a recording when our socket goes away (the file is
  // complete up to the last frame it received), so this is done-with-warning, not
  // an error — but no record.done can reach us, so we conclude it ourselves.
  if (recordId) noteRecordingLostSocket();
  broadcast();
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * The recorder socket's events. Speech no longer arrives here — it comes out of
 * the shared session policy's sink (`handleListenEvent`) — so this is the
 * recorder's half of the old protocol and nothing else.
 */
function handleServerEvent(msg: ServerEvent): void {
  if (msg.type.startsWith('record.')) { handleRecordEvent(msg); return; }
  if (msg.type === 'error') {
    // Every error left on this socket belongs to a recording, because a
    // recording is the only thing this socket carries any more.
    failRecording(msg.message);
  }
}

/**
 * One event from the read-ahead policy for the session being PLAYED.
 *
 * The same five kinds the old socket sent, and the same handling — only `data`
 * changed, from base64 to the PCM16 bytes the row layer already decoded. The
 * sixth, `speaking`, is gone: this document does its own segmentation now, so
 * it knows the sentences before the first row goes out (see `startCurrent`).
 */
function handleListenEvent(msg: ListenEvent): void {
  if (!session || msg.requestId !== session.requestId) return;
  switch (msg.kind) {
    case 'chunk':
      session.addChunk(msg.sentenceIndex as number, msg.seq as number, msg.data as Uint8Array);
      session.drain();
      afterData();
      return;
    case 'done':
      // The row's pause travels with its retirement — see Session.markDone.
      session.markDone(msg.sentenceIndex as number, msg.gapSec as number);
      session.drain();
      afterData();
      return;
    case 'failed':
      // A row the server refused. Named on the console — its text is simply not
      // spoken, and the block plays on around the hole rather than stopping.
      console.warn('[BFR] row', msg.sentenceIndex, 'failed:', msg.error);
      session.markFailed(msg.sentenceIndex as number);
      session.drain();
      afterData();
      return;
    case 'complete':
      finishGeneration(true);
      retainSession(session, sessionItem);
      afterData();
      fillPrefetch(); // current done — top up the read-ahead pipeline
      noteReadActivity();
      return;
    case 'cancelled':
      // Keep what it managed to render: the next play resumes from there rather
      // than paying to synthesize these sentences again.
      retainSession(session, sessionItem);
      if (cancellingOwn.has(msg.requestId)) {
        // OUR OWN cancel, and the caller is about to install something in this
        // session's place. Concluding here would advance the queue past the
        // block that is being restarted — see `cancellingOwn`.
        finishGeneration(false);
        return;
      }
      finishGeneration(false, switchingVoice ? undefined : 'The reading session was closed');
      concludeIfIdle();
      broadcast();
      return;
  }
}

/** The whole block failed before a row went out: say so where the player looks. */
function failCurrentRead(message: string): void {
  errorMsg = message;
  if (session) { retainSession(session, sessionItem); finishGeneration(false); concludeIfIdle(); }
  broadcast();
}

function sameSentences(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function finishGeneration(success: boolean, note?: string): void {
  if (!session) return;
  session.generationDone = true;
  if (success) { session.complete = true; }
  if (note) session.note = note;
}

/**
 * A terminal failure arrived. If nothing is playing (no audio buffered, or it has
 * already ended), conclude now so a queued item can take over; otherwise let the
 * buffered audio play out and conclude when it ends.
 */
function concludeIfIdle(): void {
  if (!started || audio.ended) concludeCurrent();
}

// ─── Queue operations ─────────────────────────────────────────────────────────

function playNow(item: QueueItem): void {
  // Move to the top of the queue and play immediately; keep upcoming intact.
  upcoming = upcoming.filter((i) => i.id !== item.id);
  retireCurrentToHistory();
  current = item;
  if (adoptPrefetchFor(item)) return;
  startCurrent(true);
}

/** Replace the queue with an ordered run (block → end of page) and start it. */
function playSequence(items: QueueItem[]): void {
  if (items.length === 0) return;
  const first = items[0];
  // Clicking back into the block already playing (its audio is in the live session,
  // not yet the cache): reuse that buffer — seek to the clicked sentence instead of
  // cancelling generation and re-synthesizing it.
  if (current && current.id === first.id && session && !errorMsg && current.text === first.text) {
    upcoming = items.slice(1);
    const fraction = first.startChar ? Math.min(1, first.startChar / Math.max(1, first.text.length)) : 0;
    if (started) seekWithinCurrent(fraction);
    else { pendingStartFraction = fraction > 0 ? fraction : null; afterData(); }
    fillPrefetch();
    broadcast();
    return;
  }
  beginRun(items);
  current = first;
  upcoming = items.slice(1);
  // Read-ahead for blocks that aren't part of this run any more would sit on the
  // concurrency slots the new run needs. Cancelling them is free now: whatever they
  // rendered is kept, so if the reader comes back to those blocks they resume.
  dropPrefetchNotIn(items);
  // This block may already be generating as read-ahead. Take that session over
  // rather than cancelling it and asking for the same audio a second time — that
  // is the whole point of pressing play on something the reader is already
  // working on, and it's what made a click feel like it started from zero.
  if (adoptPrefetchFor(first)) return;
  startCurrent(true);
}

/**
 * Starting a run from `items[0]`. If that block is part of the run already in
 * progress, everything before it stays as history so the progress bar keeps
 * spanning the same read; otherwise this is a new read and history resets.
 */
function beginRun(items: QueueItem[]): void {
  const all = runItems();
  const idx = all.findIndex((i) => i.id === items[0].id);
  history = idx > 0 ? all.slice(0, idx) : [];
}

/** Move the outgoing `current` into history so the run keeps its full shape. */
function retireCurrentToHistory(): void {
  if (!current) return;
  if (history.length === 0 || history[history.length - 1].id !== current.id) history.push(current);
  current = null;
}

/** Reposition playback within the live session to the sentence at `fraction` of the
 *  block, reusing the already-generated audio (no TTS). Falls back to a proportional
 *  seek when the targeted sentence hasn't drained yet (e.g. a forward click). */
function seekWithinCurrent(fraction: number): void {
  if (!session) return;
  const aligned = sentenceStartSecondsFor(fraction);
  const target = Math.max(0, Math.min(session.seconds, aligned ?? fraction * session.seconds));
  if (target > blobBytes / BYTES_PER_SECOND) loadBlob(target);
  else { try { audio.currentTime = target; } catch { /* ignore */ } }
  broadcast();
}

function enqueue(item: QueueItem): void {
  // No item, or the current one has already finished/failed and is just sitting
  // there as "Done"/error — take over and play now instead of parking behind it.
  if (!current || currentIsDone()) { playNow(item); return; }
  if (item.id === current.id || upcoming.some((i) => i.id === item.id)) { broadcast(); return; }
  upcoming.push(item);
  fillPrefetch(); // a new read-ahead target — start generating it concurrently
  broadcast();
}

/**
 * The current item has reached a terminal state with nothing left to play:
 * generation finished (complete or failed) and the audio has played out (or an
 * error meant it never started). Such a `current` should not block the queue.
 */
function currentIsDone(): boolean {
  if (!current) return false;
  if (errorMsg) return true;
  if (!session) return false;
  return session.generationDone && (audio.ended || !started);
}

function removeFromQueue(id: string): void {
  if (current && current.id === id) { skipCurrent(); return; }
  upcoming = upcoming.filter((i) => i.id !== id);
  dropPrefetchForItem(id);
  fillPrefetch(); // a new item may now be next in line
  broadcast();
}

/** Clear upcoming but keep the current/playing item. */
function clearUpcoming(): void {
  upcoming = [];
  dropAllPrefetch();
  broadcast();
}

/** Advance to the next item, or go idle if none. */
function skipCurrent(): void {
  cancelGeneration();
  const next = upcoming.shift();
  retireCurrentToHistory();
  if (next) {
    current = next;
    if (adoptPrefetchFor(next)) return;
    startCurrent(false);
  } else {
    dropAllPrefetch();
    resetPlayer();
    stopStatusTicker();
    broadcast();
  }
}

/**
 * The current item has concluded (played out, failed, or errored). Advance to the
 * next queued item if any; otherwise leave the player in its terminal state so the
 * bar shows "Done" / the error. A finished `current` left here is no longer a
 * blocker — `enqueue()` will take over via `currentIsDone()`.
 */
function concludeCurrent(): void {
  // A voice switch is mid-flight. It cancelled generation ON PURPOSE and is going to
  // re-speak THIS block, from the listener's own position, the moment the engine
  // confirms the new voice — so the block is not finished, whatever the player thinks.
  // Without this the switch's own 'cancelled' event (or the buffer simply draining
  // during a slow load) advanced the queue, and the switch then resumed the NEXT
  // block from its first sentence: the "it started the article over" symptom.
  if (switchingVoice) return;
  const next = upcoming.shift();
  // Nothing left to play: broadcast the terminal state, then stop the 300ms ticker so
  // it doesn't keep the MV3 service worker awake forever. Broadcast first so the final
  // "Done"/error state still reaches the UI.
  if (!next) { broadcast(); stopStatusTicker(); return; }
  retireCurrentToHistory();
  current = next;
  if (adoptPrefetchFor(next)) return;
  startCurrent(false);
}

/**
 * Stop the read (Stop button, or the queue emptied): cancel generation and clear
 * the queue, but KEEP every rendered second. Stopping means "I'm done with this
 * article", not "throw away the audio" — pressing play again must replay instantly
 * rather than pay to synthesize words that were already spoken once. Memory is
 * bounded by the LRU cap; the audio is freed for real in {@link purgeAll}.
 */
function stopAll(): void {
  cancelGeneration();
  dropAllPrefetch();
  current = null;
  upcoming = [];
  history = [];
  resetPlayer();
  stopStatusTicker();
  broadcast();
}

/**
 * Tear down for real: the user closed the on-page controls, or the tab navigated
 * away / closed. This is the ONLY path that frees rendered audio — up to
 * CACHE_LIMIT_BYTES of it — so leaving a page releases the memory promptly.
 */
function purgeAll(): void {
  stopAll();
  cache.clear();
  lruCounter = 0;
  renderedByItem.clear();
  measured.clear();
  broadcast();
}

/**
 * Request ids this document is cancelling ITSELF, right now.
 *
 * THE TIMING CHANGED WITH THE WIRE AND THIS IS WHAT IT COSTS. A cancel used to
 * go out on a socket and its `cancelled` event came back a round trip later —
 * by which time `resetPlayer()` had run and the handler's `requestId !==
 * session.requestId` guard dropped it. The shared policy calls the sink
 * SYNCHRONOUSLY, so the event now lands while the outgoing session is still
 * installed, and `concludeIfIdle()` would advance the queue past the very
 * block the caller is about to start.
 *
 * So a cancel we asked for is marked as ours for the length of the call, and
 * its event is recorded and then let go.
 */
const cancellingOwn = new Set<string>();

function cancelGeneration(): void {
  if (session && !session.generationDone) {
    const id = session.requestId;
    cancellingOwn.add(id);
    try { listen.stop(id); } finally { cancellingOwn.delete(id); }
  }
  // Whatever it rendered before being cancelled is kept, so resuming this block
  // generates only the sentences that were never reached. Credited to the session's
  // OWN block — this runs from startCurrent, by which point `current` is already
  // the next paragraph.
  if (session) retainSession(session, sessionItem);
  try { audio.pause(); } catch { /* ignore */ }
}

function resetPlayer(): void {
  session = null;
  sessionItem = null;
  started = false;
  userPaused = false;
  blobBytes = 0;
  finishedSent = false;
  lastReportedSentence = -1;
  playedSentence = 0;
  pendingStartFraction = null;
  stallSince = null;
  errorMsg = null;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
}

// ─── Read-ahead (concurrent prefetch of upcoming blocks) ───────────────────────

/**
 * How many read-ahead BLOCKS may be generating at once.
 *
 * It was the server's `deviceWorkers` — the app's local pool's topology — which
 * an extension talking straight to a Crucible cannot see and has no business
 * knowing: the server's batch width is engine tuning it does not publish. What
 * a client owns is its read-ahead DEPTH, and that is
 * `CRUCIBLE_STREAM_IN_FLIGHT` rows spread across the blocks in flight. The
 * blocks interleave inside the one session anyway (the shared policy dispatches
 * them into the same row budget), so this is just the fan-out.
 */
function prefetchConcurrency(): number {
  return CRUCIBLE_STREAM_IN_FLIGHT;
}

function isPrefetchingItem(id: string): boolean {
  if (startingItems.has(id)) return true;
  for (const { item } of prefetches.values()) if (item.id === id) return true;
  return false;
}

/** Accumulate a read-ahead session's audio without disturbing current playback. */
function handlePrefetchEvent(entry: { session: Session; item: QueueItem }, msg: ListenEvent): void {
  const { session: s, item } = entry;
  switch (msg.kind) {
    case 'chunk': s.addChunk(msg.sentenceIndex as number, msg.seq as number, msg.data as Uint8Array); s.drain(); return;
    case 'done': s.markDone(msg.sentenceIndex as number, msg.gapSec as number); s.drain(); return;
    case 'failed': s.markFailed(msg.sentenceIndex as number); s.drain(); return;
    case 'complete':
      s.generationDone = true;
      s.complete = true;
      s.drain();
      retainSession(s, item);
      // This block is done and lives in the cache now; free the slot and keep the
      // read-ahead pipeline going on the next not-yet-ready block.
      prefetches.delete(s.requestId);
      fillPrefetch();
      broadcast(); // the page marks this block as rendered
      return;
    case 'cancelled':
      // Cancelled before we adopted it. Keep whatever it rendered so the next
      // attempt resumes from there instead of starting the block over.
      retainSession(s, item);
      dropPrefetchByRequest(s.requestId);
      return;
  }
}

/**
 * Keep upcoming blocks generating into the cache, CONCURRENTLY — up to
 * prefetchConcurrency() sessions at once and PREFETCH_LOOKAHEAD_SECONDS of cached
 * audio deep. Walks the queue front-first: counts what's cached ahead, skips blocks
 * already in flight, and starts read-ahead for the next gaps. Unlike the old design
 * this does NOT wait for the current block to finish — read-ahead runs alongside it
 * (the server prioritises the playing block), which is what keeps the CPU pool full.
 * Best-effort: every startPrefetch re-validates and bails on a race or queue change.
 */
function fillPrefetch(): void {
  if (!session) return;
  let aheadSeconds = 0;
  for (const item of upcoming) {
    if (prefetches.size + startingItems.size >= prefetchConcurrency()) break;
    if (aheadSeconds >= PREFETCH_LOOKAHEAD_SECONDS) break;
    const rendered = renderedByItem.get(item.id);
    if (rendered?.complete) { aheadSeconds += rendered.seconds; continue; }
    if (isPrefetchingItem(item.id)) continue; // already generating — don't double-start
    void startPrefetch(item);
  }
}

/**
 * A block of page text, as ROWS a Crucible will be handed.
 *
 * The app's own three stages, in the app's own order, from the app's own code
 * (`shared/listen-text/` — one source, bundled twice; the keeper
 * `tools/test-listen-text-one-source.js` proves it is not a copy):
 *
 *   1. the deterministic normalizer — glyph strip, punctuation, number rules,
 *      number expansion, caps fold;
 *   2. sentences, capped at THIS voice's ceiling — its measured safe band when
 *      the row states one and its truncation cap otherwise, in characters,
 *      resolved once by `voice-band.ts` and carried in `band.maxChars`;
 *   3. ramped chunks: a short opener so the first word is fast, widening to the
 *      band so the model reads whole paragraphs and the seams go away.
 *
 * It is DETERMINISTIC, and that is load-bearing: a partly-cached block is
 * resumed by index into this list, so the same text must produce the same rows
 * forever or one row's audio ends up under another row's text.
 */
function rowsFor(text: string, band: ListenChunkBand): string[] {
  const speakable = speakableListenText(text);
  if (speakable === '') return [];
  return packListenChunks(splitForTts(speakable, LISTEN_LANGUAGE, band.maxChars), band);
}

async function startPrefetch(item: QueueItem): Promise<void> {
  const seq = playSeq;
  startingItems.add(item.id); // synchronous reservation (closed in finally)
  try {
    // A read-ahead block is spoken by the SAME session as the playing one, so
    // it needs the session open before it can be keyed or sent.
    const open = await ensureStream();
    if (open === null || seq !== playSeq) return;
    const voice = open.voice;
    const key = await cacheKeyFor(voice, item.text);
    // Re-validate after the awaits: still the same playback context, the target still
    // queued, and not already cached or in flight on another session.
    if (seq !== playSeq) return;
    const hit = cacheGet(key);
    if (hit?.complete) { markRendered(item, key, hit.bytes / BYTES_PER_SECOND, true); return; }
    if (!upcoming.some((u) => u.id === item.id)) return;
    if ([...prefetches.values()].some((p) => p.item.id === item.id)) return;

    const rows = rowsFor(item.text, open.band);
    if (rows.length === 0) return;
    // A partial hit means an earlier pass rendered part of this block. Pick up
    // where it stopped rather than paying for those sentences twice — and only
    // when the split it was rendered against is the one we just computed,
    // because splicing onto a prefix cut differently is silently wrong audio.
    const usable = hit && (hit.complete || sameSentences(hit.sentences, rows)) ? hit : undefined;
    if (hit && usable === undefined) { cache.delete(key); forgetRendered(key); }
    const requestId = `${item.id}#pf${++reqCounter}`;
    const s = usable ? sessionFromCache(requestId, usable) : new Session(requestId);
    s.initSlots(rows);
    prefetches.set(s.requestId, { session: s, item });
    cacheKeyByRequest.set(s.requestId, key);
    console.log('[BFR] prefetch', s.requestId, '|', item.text.length, 'chars →', rows.length, 'rows',
      s.resumeFrom > 0 ? `| resuming at row ${s.resumeFrom}` : '');
    // Rate baseline, as in startCurrent: a read-ahead session that is later adopted
    // brings its measured rate with it, so the gate judges it on real evidence.
    s.genStartedAt = Date.now();
    s.baseSeconds = s.seconds;
    // preempt:false so it coexists with the playing block; priority:false so the
    // shared policy treats it as background read-ahead behind what is being heard.
    listen.start(rows, s.resumeFrom, { voice }, s.requestId, sinkFor(s.requestId), {
      preempt: false,
      priority: false,
    });
  } finally {
    startingItems.delete(item.id);
    fillPrefetch(); // settle: a cache hit / abort frees the slot for the next block
  }
}

/** Remove a read-ahead session's bookkeeping WITHOUT cancelling it — for when
 *  the session is already gone and there is nothing to cancel. */
function forgetPrefetch(requestId: string): void {
  cacheKeyByRequest.delete(requestId);
  prefetches.delete(requestId);
}

/** Abandon one read-ahead session by requestId. */
function dropPrefetchByRequest(requestId: string): void {
  const entry = prefetches.get(requestId);
  if (!entry) return;
  if (!entry.session.generationDone) listen.stop(requestId);
  forgetPrefetch(requestId);
}

/** Abandon any read-ahead session generating a given queue item. */
function dropPrefetchForItem(id: string): void {
  for (const [requestId, { item }] of [...prefetches.entries()]) {
    if (item.id === id) dropPrefetchByRequest(requestId);
  }
}

/** Abandon every read-ahead session (queue replaced, or we're stopping). */
function dropAllPrefetch(): void {
  for (const requestId of [...prefetches.keys()]) dropPrefetchByRequest(requestId);
}

/** Abandon read-ahead for blocks that aren't in this run. */
function dropPrefetchNotIn(items: QueueItem[]): void {
  const keep = new Set(items.map((i) => i.id));
  for (const [requestId, { item }] of [...prefetches.entries()]) {
    if (!keep.has(item.id)) dropPrefetchByRequest(requestId);
  }
}

/**
 * Promote a read-ahead session to current and play it immediately. Returns false
 * if there's no read-ahead for this item (caller falls back to a fresh startCurrent).
 *
 * This is the guarantee that pressing play never re-renders: whether the block was
 * reached by the queue advancing or by the user clicking it, an in-flight session
 * for it is taken over, never cancelled and re-requested.
 */
function adoptPrefetchFor(item: QueueItem): boolean {
  let found: { requestId: string; session: Session } | null = null;
  for (const [requestId, entry] of prefetches) {
    if (entry.item.id === item.id) { found = { requestId, session: entry.session }; break; }
  }
  if (!found) return false;
  const s = found.session;
  prefetches.delete(found.requestId);
  ++playSeq; // invalidate any in-flight startCurrent/startPrefetch racing on the old current

  // Tear down the current player but install the prefetched session in its place.
  try { audio.pause(); } catch { /* ignore */ }
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  started = false;
  userPaused = false;
  blobBytes = 0;
  finishedSent = false;
  lastReportedSentence = -1;
  playedSentence = 0;
  // A click partway into the block still lands there — on the buffered audio, by
  // seeking, not by re-synthesizing a partial.
  pendingStartFraction = item.startChar && item.text.length
    ? Math.min(1, item.startChar / item.text.length)
    : null;
  stallSince = null;
  errorMsg = null;
  renderedByItem.delete(item.id); // now playing — no longer "ahead"
  current = item;
  session = s;
  sessionItem = item;

  // Tell the policy this session is now the playing one so it lifts it from
  // background to playing priority. Promotion normally rides on a playhead
  // report, but reportPlayhead() is gated on started && !paused — which can't
  // happen until audio buffers at background priority (a block-boundary stall).
  // Index 0 is safe: the policy only advances a playhead that moves forward.
  if (!s.generationDone) listen.reportPlayhead(s.requestId, 0);

  ensureStatusTicker();
  preState = 'buffering';
  afterData(); // starts playback now if enough is buffered, else when more arrives
  fillPrefetch(); // keep the read-ahead pipeline full past the adopted block
  broadcast();
  return true;
}

// ─── Play the current item ────────────────────────────────────────────────────

/**
 * Start (or replay from cache) the current block.
 *
 * Three ways this can go, in order of preference — the first that applies wins,
 * and only the last one costs any synthesis:
 *   1. the block is fully cached  → replay it, no server contact at all
 *   2. it's partly cached         → speak from the first un-rendered row
 *   3. nothing held               → speak it whole
 *
 * @param _userInitiated true for a play the user asked for, false when
 *   advancing within a run. It used to be `preempt` and to travel on the wire;
 *   see the note beside the `listen.start` below for why nothing preempts any
 *   more. Kept as an argument because the call sites say something true with
 *   it and a future take-over gesture is where it would be read.
 */
async function startCurrent(_userInitiated: boolean): Promise<void> {
  const item = current;
  if (!item) return;
  const seq = ++playSeq;

  cancelGeneration();
  resetPlayer();
  renderedByItem.delete(item.id); // becoming current — no longer "ahead"
  // A mid-block click asks playback to begin partway in; remember it as a fraction
  // so we can land on a sentence boundary in the (possibly cached) buffer.
  pendingStartFraction = item.startChar && item.text.length ? Math.min(1, item.startChar / item.text.length) : null;
  const settings = await getSettings();
  if (seq !== playSeq) return;
  rate = settings.rate;

  preState = 'connecting';
  ensureStatusTicker();
  broadcast();

  // THE VOICE IS THE RESIDENT ONE, and the session has to exist before this
  // block can even be keyed: the cache key is (voice, text), and a streaming
  // session never loads a voice (PHASE3-TTS.md §6). Opening it first is what
  // turns "nothing is loaded over there" into a sentence on screen instead of
  // a paragraph read in whatever the server happened to have warm.
  preState = 'starting-engine';
  const open = await ensureStream();
  if (seq !== playSeq) return;
  if (open === null) {
    failCurrentRead(connectionError ?? 'No Crucible is ready to read this.');
    return;
  }
  const voice = open.voice;
  const key = await cacheKeyFor(voice, item.text);
  if (seq !== playSeq) return;

  const cached = cacheGet(key);

  // Fully cached — replay with zero server contact. Leave any in-flight read-ahead
  // running so the buffer keeps growing across this boundary.
  if (cached?.complete) {
    const s = sessionFromCache(`cache-${++reqCounter}`, cached);
    session = s;
    sessionItem = item;
    cacheKeyByRequest.set(s.requestId, key);
    startPlayback();
    fillPrefetch(); // cached item is already done — keep read-ahead full
    return;
  }

  // The rows this block becomes, computed HERE — the extension segments and
  // packs its own text now (`rowsFor`), so it knows the whole shape before the
  // first row goes out and never has to wait for a `speaking` echo.
  const rows = rowsFor(item.text, open.band);
  if (rows.length === 0) {
    failCurrentRead('There is nothing speakable in this block.');
    return;
  }
  // Partly cached (an earlier pass was interrupted) — keep those rows and ask
  // only for the rest, and ONLY when the prefix was rendered against this same
  // split. Splicing new audio onto a differently-cut prefix is silently wrong.
  const usable = cached && sameSentences(cached.sentences, rows) ? cached : undefined;
  if (cached && usable === undefined) { cache.delete(key); forgetRendered(key); }
  const s = usable ? sessionFromCache(`${item.id}#${++reqCounter}`, usable) : new Session(`${item.id}#${++reqCounter}`);
  s.initSlots(rows);
  session = s;
  sessionItem = item;
  cacheKeyByRequest.set(s.requestId, key);

  preState = 'buffering';
  // "Buffer before playing" OFF ⇒ fast start (Owen 2026-09-04). Crucible's door
  // ALWAYS emits sub-sentence frames, so this no longer asks the server for
  // anything: it decides whether THIS document hands them to the player as they
  // land or holds each row until it is whole. Recorded on the session, not
  // consulted globally, so flipping the switch never re-judges a session already
  // generating under the other bargain. Only the FOREGROUND block —
  // startPrefetch deliberately never sets it.
  s.fastStart = settings.bufferBeforePlaying === false;
  console.log('[BFR] read', s.requestId, '|', item.text.length, 'chars →', rows.length, 'rows',
    s.fastStart ? '| fast start' : '',
    s.resumeFrom > 0 ? `| resuming at row ${s.resumeFrom}` : '');
  // Generation starts NOW: everything already in `segments` is a cached prefix, so
  // the adaptive start gate measures the rate from here (see startThresholdSeconds).
  s.genStartedAt = Date.now();
  s.baseSeconds = s.seconds;
  noteReadActivity();
  /*
   * NEVER `preempt: true`, and the reason changed with the wire.
   *
   * On BookForge's socket, `preempt` meant "cancel the OTHER CLIENTS' sessions"
   * — the app's scheduler deliberately spared this client's own read-ahead,
   * because that is audio already paid for. There are no other clients on this
   * policy: it is this document's alone, so `preempt: true` here would cancel
   * exactly the read-ahead the old flag protected. The outgoing playing session
   * is already stopped by `cancelGeneration()` at the top of this function.
   *
   * And preempting ACROSS clients is not a flag any more either. A second
   * client's session on that server is refused by name (`stream_session_open`),
   * and taking it over is an explicit act through the engine — never something
   * a play button does quietly (plan §1).
   */
  listen.start(rows, s.resumeFrom, { voice }, s.requestId, sinkFor(s.requestId), {
    preempt: false,
    priority: true,
    fastStart: s.fastStart,
  });
  broadcast();
  fillPrefetch(); // generate upcoming blocks alongside this one (started after, so it goes first)
}

/**
 * Why the RECORDER's socket would not open. Speech does not come through here;
 * its refusals are the server's own words (`describeRefusal`).
 */
function connectErrorMessage(code: string): string {
  switch (code) {
    case 'NO_TOKEN': return 'No token configured — open Options and paste BookForge\'s recorder token.';
    case 'BAD_TOKEN': return 'BookForge rejected the recorder token — check it in Options.';
    default: return "Can't reach BookForge — is the app running? (Recording needs it; reading does not.)";
  }
}

// ─── Audio scheduling ─────────────────────────────────────────────────────────

function afterData(): void {
  if (!session) return;
  if (!started) {
    // Mid-block click: hold until the targeted sentence has buffered AND the start
    // gate opens on the audio ahead of it, then begin there. Falls back to the top
    // only if generation finished without resolving it (e.g. an empty/failed
    // segmentation).
    if (pendingStartFraction != null) {
      const at = targetStartSeconds();
      if (at != null && startGateOpen(at)) startPlayback();
      else if (session.generationDone) { pendingStartFraction = null; startPlayback(); }
      broadcast();
      return;
    }
    if (startGateOpen()) startPlayback();
    broadcast();
    return;
  }
  if (audio.ended) resumeIfReady();
  broadcast();
}

/**
 * May playback START now, from `fromSeconds` into the block, without stalling later?
 *
 * Seamlessness beats first-audio latency (see START_MIN_SECONDS), so a block that is
 * STILL GENERATING waits for a real cushion. Nothing that is already in hand waits:
 *
 *   b) generationDone — a cache hit, an adopted read-ahead session that finished, or
 *      a render that ended (complete, cancelled or failed). Nothing more is coming,
 *      so there is nothing to stall on.
 *   c) every sentence the server announced has drained into the buffer — the block's
 *      whole expected audio is already here and only the terminal 'complete' is
 *      outstanding. This is what keeps SHORT blocks instant.
 *   a) otherwise: hold until the buffer ahead of the start point covers the deficit
 *      this generator is projected to run up over the REST of the block
 *      (startThresholdSeconds), floored at START_MIN_SECONDS.
 *
 * While this holds playback back the player is simply not `started`, which
 * computeState() already reports as 'buffering' (spinner + stop square) — no new UI
 * state involved.
 */
function startGateOpen(fromSeconds = 0): boolean {
  if (!session) return false;
  // FAST START is a DIFFERENT GATE, not this one with smaller numbers — everything
  // below this line is the "buffer before playing" path and is untouched by it.
  if (session.fastStart) return fastStartGateOpen(session, fromSeconds);
  if (session.generationDone) return true;
  if (session.sentences.length > 0 && session.appendCursor >= session.sentences.length) return true;
  const threshold = startThresholdSeconds({
    arrivedSeconds: session.seconds - session.baseSeconds,
    // The rate window opens at the FIRST arrival, not at the request — see
    // Session.firstArrivalAt.
    steadySeconds: session.firstArrivalAt === null ? 0 : session.seconds - session.firstArrivalSeconds,
    steadyWallSeconds: session.firstArrivalAt === null ? 0 : (Date.now() - session.firstArrivalAt) / 1000,
    maxGapSeconds: session.maxGapSeconds,
    arrivedSentences: session.appendCursor - session.resumeFrom,
    remainingSentences: session.sentences.length - session.appendCursor
  });
  return session.seconds - fromSeconds >= threshold;
}

/**
 * The FAST-START gate: may playback begin, given that this session's audio is being
 * streamed to us as it is generated?
 *
 * Three ways to open, and none of them is a projection:
 *   - the block is done (a cache hit, or generation ended) — nothing to stall on;
 *   - every announced sentence has drained — the whole block is here;
 *   - one second of audio sits ahead of the start point.
 *
 * There is deliberately no rate estimate and no gap cover. Those exist because a
 * batch engine delivers in bursts and the buffer has to survive the next silence;
 * this mode has decided it would rather start and risk the silence. Trying to be
 * clever here would reinvent the gate the switch was flipped to escape.
 */
function fastStartGateOpen(s: Session, fromSeconds: number): boolean {
  if (s.generationDone) return true;
  if (s.sentences.length > 0 && s.appendCursor >= s.sentences.length) return true;
  return s.seconds - fromSeconds >= FAST_START_MIN_SECONDS;
}

// ─── gate math (pure; exercised by scratchpad/gate-math.test.mjs) ──────────────
/**
 * How many seconds of audio must sit ahead of the start point before playback may
 * begin, given how this session's generator is actually performing.
 *
 * The rule is just "don't start something you can't finish". Playback drains 1s of
 * buffer per second; the generator refills it at R = seconds of audio per wall
 * second. If R >= 1 it can never be caught, so only the floor applies. If R < 1 it
 * falls behind by (1/R - 1) seconds for every second of audio still to come, and
 * ALL of that deficit has to be pre-bought before the first note plays:
 *
 *     threshold = max(START_MIN_SECONDS, remainingAudio x (1/R - 1) + margin)
 *
 * Worked: R=0.5 with 40s of audio left needs 40s buffered (+margin) — start on less
 * and the playhead is guaranteed to hit the live edge partway through. R=1.3 needs
 * nothing beyond the floor.
 *
 * Two things have to hold, and the threshold is whichever demands more buffer:
 *
 *   RATE — R is measured FROM THE FIRST ARRIVAL, not from the request. Measuring
 *   from the request folds start-up latency (engine boot, an Orpheus model load,
 *   prompt prefill) into the rate: the first rows of an MLX batch land against a
 *   wall clock that makes a 2.8x-realtime generator read as 0.3x, and the gate then
 *   demands minutes of buffer to cover a deficit that does not exist.
 *
 *   GAP — a batching engine does not deliver smoothly; it delivers in bursts, with a
 *   whole batch of silence between them. Beating the average rate is not enough if
 *   the next silence is longer than the buffer, so the buffer must also cover the
 *   longest quiet interval this session has seen (Session.maxGapSeconds, which
 *   includes the wait for the very first delivery). This is what the old from-request
 *   rate was accidentally doing, and it is why removing it without a replacement
 *   would start playback on ~15s of buffer in front of a 40s batch.
 *
 *   maxGapSeconds is a MEASUREMENT of the past, not a prediction, and since the
 *   server ramped the first burst (see START_MIN_SECONDS) the first gap is the
 *   SHORTEST of the session rather than the longest. What keeps that safe is not the
 *   gap term but the size of the burst it arrives with: a ramped first wave delivers
 *   ~60s against a following silence of ~40s, so the gate opens on a cushion that
 *   already outruns the gap it cannot yet have seen. If the ramp is ever widened
 *   toward the full width without the wave growing with it, this term stops covering
 *   the second batch and the floor would have to.
 *
 * Returns Infinity while nothing has arrived (there is nothing to play anyway).
 */
function startThresholdSeconds(gen: {
  arrivedSeconds: number;
  steadySeconds: number;
  steadyWallSeconds: number;
  maxGapSeconds: number;
  arrivedSentences: number;
  remainingSentences: number;
}): number {
  if (gen.arrivedSeconds <= 0) return Infinity;
  const perSentence = gen.arrivedSentences > 0
    ? gen.arrivedSeconds / gen.arrivedSentences
    : DEFAULT_SECONDS_PER_SENTENCE;
  const remainingAudio = Math.max(0, gen.remainingSentences) * perSentence;
  // Nothing left to generate: no future gap and no deficit to cover.
  if (remainingAudio <= 0) return START_MIN_SECONDS;
  const rate = gen.steadyWallSeconds > 0 && gen.steadySeconds > 0
    ? gen.steadySeconds / gen.steadyWallSeconds
    : 0;
  // No rate yet (a single delivery is one sample, not a rate) — hold for the next
  // one, which on a batching engine is a second or two behind the first.
  if (rate <= 0) return Infinity;
  const deficit = remainingAudio * Math.max(0, 1 / rate - 1);
  const gapCover = gen.maxGapSeconds + SAFETY_MARGIN_SECONDS;
  return Math.max(START_MIN_SECONDS, deficit + SAFETY_MARGIN_SECONDS, gapCover);
}
// ─── end gate math ────────────────────────────────────────────────────────────

/**
 * Resolve pendingStartFraction to the playback time at the start of the targeted
 * sentence, or null if that sentence hasn't buffered yet (so the caller keeps
 * waiting). The fraction is mapped over the cumulative character length of the
 * session's sentences, so it lands on a sentence boundary even when the server's
 * text length differs slightly from the DOM text the click was measured against.
 */
function targetStartSeconds(): number | null {
  return pendingStartFraction == null ? null : sentenceStartSecondsFor(pendingStartFraction);
}

/**
 * The playback time at the start of the sentence containing `fraction` (0..1) of
 * the block, or null if that sentence hasn't buffered yet. The fraction is mapped
 * over the cumulative character length of the session's sentences, so it lands on
 * a sentence boundary even when the server's text length differs slightly from the
 * DOM text the click was measured against.
 */
function sentenceStartSecondsFor(fraction: number): number | null {
  if (!session) return null;
  const sents = session.sentences;
  if (sents.length === 0) return null; // segmentation not announced yet
  let total = 0;
  for (const s of sents) total += s.length;
  if (total === 0) return 0;
  const want = fraction * total;
  let acc = 0;
  let idx = 0;
  for (let i = 0; i < sents.length; i++) {
    if (want < acc + sents[i].length) { idx = i; break; }
    acc += sents[i].length;
    idx = i;
  }
  if (idx >= session.appendCursor) return null; // targeted sentence not buffered yet
  return session.boundaries[idx] / BYTES_PER_SECOND;
}

/**
 * The playhead reached the end of the loaded blob. Resume from where it stopped
 * once a worthwhile buffer (or the final tail) is ready, otherwise finalize, or
 * stay 'buffering' until more audio arrives. Reloading for a few stray
 * milliseconds at the live edge just produces a stutter loop, so we hold off.
 */
function resumeIfReady(): void {
  if (!session || !audio.ended) return;
  const pending = session.bytes - blobBytes;
  if (pending <= 0) { maybeFinalize(); return; }
  // FAST START: its own resume rule, for the reason spelled out at
  // FAST_START_MIN_SECONDS — audio is arriving continuously here, so the 4s that
  // stops a batch generator from re-stalling immediately would just be four more
  // seconds of the silence the listener is already sitting through.
  if (session.fastStart) {
    if (session.generationDone || pending >= FAST_START_MIN_SECONDS * BYTES_PER_SECOND) {
      loadBlob(blobBytes / BYTES_PER_SECOND, true);
    }
    return;
  }
  if (session.generationDone || pending >= RESUME_MIN_SECONDS * BYTES_PER_SECOND) {
    loadBlob(blobBytes / BYTES_PER_SECOND, true);
  }
}

function startPlayback(): void {
  if (!session) return;
  started = true;
  // Only route through the gain node when the user is actually amplifying — at
  // volume 1 we leave the bare <audio> element alone (routing through a suspended
  // AudioContext would stall playback into a perpetual buffering spinner).
  if (outputVolume !== 1) ensureGainGraph();
  const at = targetStartSeconds() ?? 0; // mid-block click seeks the buffer; normal read starts at 0
  pendingStartFraction = null;
  loadBlob(at);
}

function loadBlob(atSeconds: number, exact = false): void {
  if (!session) return;
  const blob = buildWav(session.segments, session.bytes);
  blobBytes = session.bytes;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  const onLoaded = () => {
    try {
      // Resume lands exactly where playback stopped (no backward jump). User seeks
      // keep a small grace so they don't land on the very end and instantly re-end.
      audio.currentTime = exact
        ? Math.min(atSeconds, session!.seconds)
        : Math.min(atSeconds, Math.max(0, session!.seconds - SEEK_STEP_GRACE));
    } catch { /* ignore */ }
    (audio as { preservesPitch?: boolean }).preservesPitch = true;
    audio.playbackRate = rate;
    if (!userPaused) void audio.play().catch(() => { /* autoplay race */ });
    broadcast();
  };
  audio.addEventListener('loadedmetadata', onLoaded, { once: true });
  audio.src = blobUrl;
  audio.load();
}

function maybeFinalize(): void {
  if (!session || !audio.ended || !session.generationDone) return;
  if (session.bytes > blobBytes) return;
  if (finishedSent) return;
  finishedSent = true;
  retainSession(session, sessionItem);
  // Advance whether the item completed or failed — a finished item must not wedge
  // the queue. concludeCurrent() leaves the terminal state visible if nothing's next.
  concludeCurrent();
}

// ─── Transport ────────────────────────────────────────────────────────────────

function handleTransport(cmd: TransportCmd): void {
  switch (cmd.op) {
    case 'toggle-pause':
      if (!session) return;
      if (!started) userPaused = !userPaused;
      else if (audio.ended && session.generationDone && session.bytes <= blobBytes) { userPaused = false; finishedSent = false; loadBlob(0); }
      else if (audio.paused) { userPaused = false; void audio.play().catch(() => { /* ignore */ }); }
      else { userPaused = true; audio.pause(); }
      broadcast();
      return;
    case 'seek': {
      if (!session || !started) return;
      const target = Math.max(0, Math.min(session.seconds, audio.currentTime + (cmd.delta ?? 0)));
      seekCurrentTo(target);
      broadcast();
      return;
    }
    case 'seek-run':
      seekRun(cmd.position ?? 0);
      return;
    case 'rate':
      rate = cmd.rate ?? 1;
      audio.playbackRate = rate;
      broadcast();
      return;
    case 'volume':
      setOutputVolume(cmd.volume ?? 1);
      return;
    case 'stop':
      stopAll();
      return;
    case 'close':
      purgeAll();
      return;
  }
}

function seekCurrentTo(target: number): void {
  if (target > blobBytes / BYTES_PER_SECOND) loadBlob(target);
  else { try { audio.currentTime = target; } catch { /* ignore */ } }
}

/**
 * Seek to an absolute position in the RUN — the bar spans every block, so a drag
 * can cross paragraph boundaries in either direction. Landing on a block other than
 * the one playing makes that block current and re-shapes history/upcoming around
 * it; its audio is already rendered (the UI only offers the rendered region), so
 * this is a replay, never a re-render.
 */
function seekRun(target: number): void {
  const items = runItems();
  if (items.length === 0) return;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const len = itemSeconds(items[i]);
    const last = i === items.length - 1;
    if (target < acc + len || last) {
      const offset = Math.max(0, Math.min(len, target - acc));
      focusRunItem(i, offset, len);
      return;
    }
    acc += len;
  }
}

function focusRunItem(index: number, offsetSeconds: number, itemLength: number): void {
  const items = runItems();
  const item = items[index];

  // Already the playing block: a plain seek inside the live buffer.
  if (current && current.id === item.id && session && started) {
    seekCurrentTo(Math.max(0, Math.min(session.seconds, offsetSeconds)));
    broadcast();
    return;
  }

  history = items.slice(0, index);
  upcoming = items.slice(index + 1);
  // Land on the sentence containing the target. The offset is proportional here
  // (a block's per-sentence timings aren't known until it's rendered), and it's
  // resolved to a sentence boundary in the buffer at play time.
  const fraction = itemLength > 0 ? Math.min(1, offsetSeconds / itemLength) : 0;
  current = { ...item, startChar: fraction > 0 ? Math.floor(fraction * item.text.length) : undefined };
  if (adoptPrefetchFor(current)) return;
  void startCurrent(false);
}

// ─── Engine control: load and unload a voice on the selected Crucible ─────────
//
// These two were `engine.start` / `engine.stop` on BookForge's socket and they
// are NOT the same act: nothing here starts or stops a process. Loading makes
// a voice resident on somebody's card; unloading gives the card back. Owen's
// rule (2026-09-14): a model is unloaded when we are done with it, every time.

/**
 * Make the picked voice resident, then open the reading session on it.
 *
 * Refusals are the SERVER's, by name, and none of them is retried or worked
 * around: `env_missing`, `not_installed`, `insufficient_vram`, `server_busy`,
 * `leased`, `engine_in_use`. When the card is held by someone else the popup
 * is told WHO, from `/v1/activity` — and nothing takes it from them.
 */
async function handleEngine(op: 'load' | 'unload', requested?: string): Promise<void> {
  if (op === 'load') await loadPickedVoice(requested ?? chosenVoice);
  else await unloadResidentVoice();
}

/**
 * Load the picked voice, and — unless `open` is false — open the reading
 * session on it once it is resident. `open: false` is `ensureStream`'s: it IS
 * the session opener, and a load that opened the session back would be a
 * promise awaiting itself.
 */
async function loadPickedVoice(voice: string | null, opts: { open?: boolean } = {}): Promise<void> {
  if (!(await refreshServer())) { broadcast(); return; }
  const bound = client;
  const named = server;
  if (bound === null || named === null) { broadcast(); return; }
  if (!voice) {
    engineNote = 'Pick a voice first — this extension will not choose one for you.';
    broadcast();
    return;
  }
  /*
   * THE CLIP, IF THIS VOICE IS CLONED FROM ONE (PHASE3-TTS.md §5's
   * amendment). The ROW says whether it needs one; a voice this server does
   * not list is not guessed about either way, because a load of a voice the
   * picker does not know is refused below by the server anyway and refusing
   * it here for the wrong reason would send the reader to the wrong fix.
   */
  const row = voiceRows.find((v) => v.id === voice);
  let reference: { data: string; transcript: string; name: string } | null = null;
  let chosenClip: { name: string; seconds: number } | null = null;
  if (row?.needsReference === true) {
    if (chosenClipId === null || chosenClipId === '') {
      // THE SERVER'S OWN NAME, made here rather than a megabyte later.
      engineNote = `reference_required: "${voice}" is cloned from a recording, and no clip is `
        + 'picked. Choose one under the voice, or add one in Options → Zero-shot clips. The base '
        + 'weights with no reference are the model\'s OWN speaker, which is not the voice you '
        + 'chose.';
      broadcast();
      return;
    }
    const stored = await findClip(chosenClipId);
    if (stored === null) {
      engineNote = `reference_required: the clip this extension was told to use (${chosenClipId}) `
        + 'is no longer in its clip store. Pick another under the voice, or add it again in '
        + 'Options → Zero-shot clips.';
      broadcast();
      return;
    }
    chosenClip = { name: stored.name, seconds: stored.seconds };
    try {
      reference = await referenceFor(chosenClipId);
    } catch (err) {
      // `reference_malformed` from this side — the same word the server uses,
      // arrived at from the same bytes, before they are sent.
      engineNote = err instanceof VoiceReferenceRefused
        ? err.message
        : `The clip could not be read: ${err instanceof Error ? err.message : String(err)}`;
      broadcast();
      return;
    }
  }
  if (sameVoice(voice, serverVoice) && residentKind === 'tts'
      && (chosenClip === null || residentClipIsTheChosenOne(chosenClip))) {
    // Already on the card — and for a cloned voice, cloned from the SAME clip.
    // Opening the session is the rest of what Load means.
    if (opts.open !== false) await ensureStream();
    broadcast();
    return;
  }
  // Our own session holds the resident voice's claim, so it has to go before
  // the card can be re-pointed — otherwise the load is refused by our own
  // reading session.
  await closeStream(`loading ${voice}`);
  engineBusy = 'loading';
  engineNote = null;
  engineHolder = null;
  switchingVoice = voice;
  broadcast();
  // Held in `loading` for the whole of the job AND the server re-read after it,
  // so a reader that waits on it wakes to `serverVoice` already saying the
  // voice is there — see `loading`.
  const inFlight = (async (): Promise<void> => {
    try {
      await loadVoiceJob(bound, voice, reference, (line) => { engineNote = line; broadcast(); });
      engineNote = null;
    } catch (err) {
      engineNote = describeRefusal(err, named.name);
      await noteHolder();
      throw err;
    } finally {
      engineBusy = null;
      switchingVoice = null;
      await refreshServer();
      broadcast();
    }
  })();
  loading = inFlight;
  try {
    await inFlight;
  } catch {
    return;   // said in engineNote by the catch above
  } finally {
    if (loading === inFlight) loading = null;
  }
  noteReadActivity();
}

async function unloadResidentVoice(): Promise<void> {
  if (!(await refreshServer())) { broadcast(); return; }
  const bound = client;
  const named = server;
  if (bound === null || named === null) { broadcast(); return; }
  if (residentKind !== 'tts' || serverVoice === null) {
    // A card holding a MODEL is not this extension's to clear: whatever put a
    // language model there is using it, and evicting it to tidy up after a web
    // page would be taking somebody else's work off the card.
    engineNote = residentKind === null
      ? `Nothing is loaded on Crucible "${named.name}".`
      : `Crucible "${named.name}" is holding a ${residentKind}, not a voice. This extension `
        + 'only unloads voices it asked for.';
    broadcast();
    return;
  }
  const voice = serverVoice;
  await closeStream('unloading the voice');
  cancelGeneration();
  dropAllPrefetch();
  engineBusy = 'unloading';
  engineNote = null;
  broadcast();
  try {
    await unloadVoiceJob(bound, voice, (line) => { engineNote = line; broadcast(); });
    // Nothing is on the card, so nothing was cloned onto it. Said here rather
    // than waited for, so the popup does not show the departed clip's name
    // beside "nothing loaded" until the next server read.
    residentClip = null;
    engineNote = null;
  } catch (err) {
    engineNote = describeRefusal(err, named.name);
  } finally {
    engineBusy = null;
    await refreshServer();
    broadcast();
  }
}

/**
 * Pick a different voice — which on a Crucible means: stop reading, close the
 * session, load the new voice, and pick the read back up where it was.
 *
 * WHERE they had reached is snapshotted HERE, at the moment they asked — never
 * read again after the load confirms. The wait can be long and the player does
 * not sit still through it: the buffer drains, the <audio> element reloads, and
 * both of those made a later reading answer "sentence 0". The block is
 * snapshotted too, so a confirmation arriving after the queue moved on cannot
 * paste this position onto another paragraph. See resumeCharForSwitch.
 *
 * The old voice's audio stays in the cache under its own key — switch back and
 * it replays instantly instead of being rendered again.
 */
async function handleSetVoice(voice: string): Promise<void> {
  if (!voice || sameVoice(voice, chosenVoice)) return;
  const token = ++voiceSwitchToken;

  // Where to pick the read back up: the character offset of the sentence being read.
  // (Counting characters, not sentences — startChar is resolved back through
  // cumulative sentence lengths, so a sentence-count fraction would drift on a
  // paragraph of uneven sentences.) Taken BEFORE anything below disturbs the player.
  const resumeChar = resumeCharForSwitch();
  const resumeItem = current;

  // Marked as switching FIRST: it is what stops the queue advancing past this block
  // while generation is cancelled and the voice loads (concludeCurrent), and what
  // tells the incoming 'cancelled' event that this cancel was ours.
  switchingVoice = voice;
  // Nothing may keep generating in the outgoing voice.
  cancelGeneration();
  dropAllPrefetch();
  forgetAllRendered();
  chosenVoice = voice;
  persistVoice(voice);
  broadcast();

  await loadPickedVoice(voice);
  if (token !== voiceSwitchToken) return; // a newer switch owns the card now
  if (!sameVoice(serverVoice, voice)) {
    // The load did not take. `engineNote` already carries the server's words;
    // the pickers snap back to what is actually resident on the next refresh.
    errorMsg = engineNote ?? `Crucible "${server?.name ?? '?'}" did not load "${voice}".`;
    broadcast();
    return;
  }

  // Loaded. Pick the read back up where it was, now in the new voice. The
  // position belongs to the block it was measured in: if `current` is somehow no
  // longer that block, restart it from its own beginning rather than dropping the
  // listener into an arbitrary point of a paragraph they have not heard.
  if (current) {
    // Same block: set the resume point, or CLEAR a stale one (a startChar left over
    // from an earlier mid-block click would otherwise re-apply itself here).
    if (resumeItem && current.id === resumeItem.id) {
      current = { ...current, startChar: resumeChar > 0 ? resumeChar : undefined };
    }
    await startCurrent(true);
  } else {
    broadcast();
  }
}

/**
 * Pick a different CLIP for the zero-shot voice — the other half of an
 * identity whose first half is the voice id.
 *
 * It goes through the same door a voice switch does, and for the same reason:
 * a clone is the base weights plus THIS recording, so changing the recording
 * changes who is reading exactly as much as changing the voice would. The
 * session closes, the card is re-pointed, and the read picks up where it was.
 *
 * It does NOT check that the current voice needs a reference. A clip chosen
 * against a checkpoint voice is simply never sent (`loadPickedVoice` reads the
 * ROW), and the choice survives for the moment the user picks the zero-shot
 * voice it belongs to.
 */
async function handleSetClip(clipId: string): Promise<void> {
  if (clipId === (chosenClipId ?? '')) return;
  chosenClipId = clipId === '' ? null : clipId;
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'put-settings', patch: { zeroshotClipId: clipId } })
    .catch(() => { /* background asleep; storage is re-read on next start */ });
  const voice = chosenVoice;
  const row = voice === null ? undefined : voiceRows.find((v) => v.id === voice);
  if (voice === null || row?.needsReference !== true) { broadcast(); return; }

  // The same sequence as a voice switch, because it IS one: a different clip
  // is a different speaker under the same id.
  const token = ++voiceSwitchToken;
  const resumeChar = resumeCharForSwitch();
  const resumeItem = current;
  switchingVoice = voice;
  cancelGeneration();
  dropAllPrefetch();
  forgetAllRendered();
  broadcast();

  await loadPickedVoice(voice);
  if (token !== voiceSwitchToken) return;
  if (!sameVoice(serverVoice, voice)) {
    errorMsg = engineNote ?? `Crucible "${server?.name ?? '?'}" did not load "${voice}".`;
    broadcast();
    return;
  }
  if (current) {
    if (resumeItem && current.id === resumeItem.id) {
      current = { ...current, startChar: resumeChar > 0 ? resumeChar : undefined };
    }
    await startCurrent(true);
  } else {
    broadcast();
  }
}

// ─── The idle unload ──────────────────────────────────────────────────────────
//
// A CLIENT TIMER, and the honest version of what `config.set {idleMinutes}`
// used to be. A Crucible's residency is the operator's and its own idle rule is
// the server's; what this extension can truthfully say is "I am finished with
// it", and that is an unload job on a timer it owns. Every row that lands and
// every transport action pushes the timer out; nothing else does, so a browser
// left open on an article overnight gives the card back.

let idleTimer: number | null = null;

/** Something was read. Restart the idle countdown. */
function noteReadActivity(): void {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  if (idleMinutes <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void idleUnload();
  }, idleMinutes * 60_000) as unknown as number;
}

/** The window elapsed with nothing read. Give the card back. */
async function idleUnload(): Promise<void> {
  if (session && !session.generationDone) { noteReadActivity(); return; }
  if (prefetches.size > 0) { noteReadActivity(); return; }
  if (live === null && (serverVoice === null || residentKind !== 'tts')) return;
  console.log(`[BFR] ${idleMinutes} minutes with nothing read — unloading the voice`);
  await unloadResidentVoice();
}

/** Persist the idle window and restart the countdown on it. */
async function handleSetIdle(minutes: number): Promise<void> {
  idleMinutes = Math.max(0, Math.floor(minutes));
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'put-settings', patch: { idleMinutes } })
    .catch(() => { /* background asleep; storage is re-read on next start */ });
  noteReadActivity();
  broadcast();
}

/** The Options page changed the registry or the selection. */
async function handleServerChanged(): Promise<void> {
  await closeStream('the selected Crucible changed');
  cancelGeneration();
  dropAllPrefetch();
  forgetAllRendered();
  server = null;
  client = null;
  await refreshServer();
  broadcast();
}

async function doSync(): Promise<void> {
  // Refresh what the popup draws; don't load anything and don't start reading.
  broadcast(); // instant: confirm the pipe works while we ask the server
  await refreshServer();
  broadcast();
}

// ─── Tab recording (docs/TAB_RECORDER.md) ─────────────────────────────────────
//
// The offscreen document owns capture for the same reason it owns playback: MV3
// service workers cannot hold an AudioContext, and a popup dies the moment it
// closes. The popup only mints the stream id (that needs a user gesture) and
// hands it here.
//
// The audio path, and why each edge exists:
//
//   MediaStream ─► MediaStreamAudioSource ─┬─► ctx.destination     keeps the tab
//                                          │                       AUDIBLE — tab
//                                          │                       capture mutes
//                                          │                       the tab unless
//                                          │                       it is wired back
//                                          └─► AudioWorkletNode ─► gain(0) ─► destination
//                                                    │             a node nothing
//                                                    │             pulls is never
//                                                    │             processed, so the
//                                                    │             tap needs a path
//                                                    │             to the destination
//                                                    ▼             — muted, so it
//                                              f32 frames          adds no sound
//
// Nothing is encoded here: float32 PCM goes out as binary frames and BookForge's
// ffmpeg writes the FLAC.

/** Live recorder state — broadcast to the popup inside the QueueSnapshot. */
let recording: RecordingStatus = { ...IDLE_RECORDING };

let recordId: string | null = null;
/** record.started has arrived: binary frames are legal from here until stop. */
let recordAcked = false;
let recStream: MediaStream | null = null;
let recCtx: AudioContext | null = null;
let recSource: MediaStreamAudioSourceNode | null = null;
let recTap: AudioWorkletNode | null = null;
let recSink: GainNode | null = null;
let recChannels = 2;
/** what the tab delivers */
let recSampleRate = 48000;
/** the rate the page's player is being driven at */
let recSpeed = 1;
let recWatch: SilenceWatch | null = null;
let recTicker: number | null = null;
/** Frames captured between getUserMedia and record.started. Held, not dropped —
 *  the opening of a recording is exactly where a book's first words are. */
let recPending: ArrayBuffer[] = [];
let recPendingBytes = 0;

/** How long we will hold un-acked frames before concluding the server is not
 *  answering. Ten seconds of audio is far past any plausible round trip. */
const RECORD_ACK_GRACE_SECONDS = 10;

function recordingTicker(on: boolean): void {
  if (on) {
    if (recTicker === null) recTicker = setInterval(broadcast, 250) as unknown as number;
  } else if (recTicker !== null) {
    clearInterval(recTicker);
    recTicker = null;
  }
}

async function handleRecord(cmd: RecordCmd): Promise<void> {
  if (cmd.op === 'start') await startRecording(cmd);
  else if (cmd.op === 'stop') await stopRecording();
  else await discardRecording();
}

/** True while capture is live in any form — the popup's Record button is off. */
function recordingBusy(): boolean {
  return recording.state === 'starting' || recording.state === 'recording' || recording.state === 'stopping';
}

async function startRecording(cmd: RecordCmd): Promise<void> {
  if (recordingBusy()) {
    console.warn('[BFR] record start ignored — already', recording.state);
    return;
  }
  const streamId = cmd.streamId;
  const title = (cmd.title || '').trim() || 'Untitled tab';
  const speed = cmd.speed && cmd.speed >= 1 ? cmd.speed : 1;
  if (!streamId) {
    // The popup could not mint a stream id: no user gesture, or a tab Chrome
    // refuses to capture (chrome:// pages, the Web Store).
    recording = { ...IDLE_RECORDING, state: 'error', title, error: 'Chrome would not give access to this tab' };
    broadcast();
    return;
  }
  recording = { ...IDLE_RECORDING, state: 'starting', title, speed };
  broadcast();

  // The socket first: capturing a tab and then discovering BookForge is down
  // would mute nothing but waste the gesture.
  try {
    await ensureRecorderSocket();
  } catch (err) {
    failRecording(connectErrorMessage((err as Error).message));
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The legacy `mandatory` form is the ONLY way to consume a tabCapture
      // stream id; lib.dom has no type for it, hence the cast.
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    } as unknown as MediaStreamConstraints);
  } catch (err) {
    failRecording(`Chrome refused to capture this tab: ${(err as Error).message}`);
    return;
  }

  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    failRecording('The captured tab has no audio track');
    return;
  }

  try {
    const settings = track.getSettings() as MediaTrackSettings & { sampleRate?: number; channelCount?: number };
    recChannels = Math.min(2, Math.max(1, Math.round(settings.channelCount ?? 2)));
    // The context runs AT THE STREAM'S OWN RATE so the graph never resamples —
    // the whole point of this feature is the player's decoded PCM, untouched.
    // Where Chrome doesn't report a rate we take the default and declare THAT to
    // the server: ctx.sampleRate is always the truth about what we produce.
    recCtx = settings.sampleRate ? new AudioContext({ sampleRate: settings.sampleRate }) : new AudioContext();
    await recCtx.resume();
    recSampleRate = recCtx.sampleRate;
    recSpeed = speed;

    // THE SPEED GUARD, and this is the first moment it can run: the capture rate
    // is not knowable until the context exists. Refuse here, before a single
    // frame is sent, rather than let someone discover after six hours that their
    // 3x capture is a 16 kHz file. Background restores the page to 1x when it
    // sees the recording end.
    const refusal = speedGuardRefusal(recSampleRate, speed);
    if (refusal) {
      teardownCapture();
      failRecording(refusal);
      return;
    }

    await recCtx.audioWorklet.addModule('recorder-worklet.js');

    recStream = stream;
    recSource = recCtx.createMediaStreamSource(stream);
    // Keep the tab audible. Tab capture silences the tab's own output; this edge
    // is what gives it back, and it is not optional.
    recSource.connect(recCtx.destination);

    recTap = new AudioWorkletNode(recCtx, 'bf-tab-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Explicit, so the tap always sees exactly the channel count we declared to
      // the server — a source that changes its mind cannot shift the interleave.
      channelCount: recChannels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { channels: recChannels, frameSize: chunkFrameSize(recSampleRate) }
    });
    recSink = recCtx.createGain();
    recSink.gain.value = 0;
    recSource.connect(recTap);
    recTap.connect(recSink);
    recSink.connect(recCtx.destination);
    recTap.port.onmessage = (e: MessageEvent) => onRecorderFrame(e.data);

    // The tab closed or navigated: the track ends, and that is a stop, not a loss.
    track.addEventListener('ended', () => {
      void stopRecording('The tab went away — saved what had been captured');
    });
  } catch (err) {
    teardownCapture();
    failRecording(`Could not start capturing this tab: ${(err as Error).message}`);
    return;
  }

  // Where the user wants the file. The extension can't write it, so this rides
  // record.start and the SERVER resolves it (~ expansion, mkdir, writability) —
  // and refuses by name if it can't.
  const outputDir = (await getSettings()).recordingsDir;

  recWatch = new SilenceWatch();
  recPending = [];
  recPendingBytes = 0;
  recordAcked = false;
  recordId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  send({
    action: 'record.start',
    recordId,
    title,
    // The CAPTURE rate. The server divides it by the speed to label the file;
    // nothing anywhere resamples.
    sampleRate: recSampleRate,
    channels: recChannels,
    speed,
    outputDir,
    ...(cmd.url ? { sourceUrl: cmd.url } : {})
  });
  recordingTicker(true);
  broadcast();
}

/** One ~100 ms frame off the audio thread. */
function onRecorderFrame(data: { pcm?: ArrayBuffer; peak?: number; rms?: number; warning?: string }): void {
  if (data.warning) { console.warn('[BFR] recorder:', data.warning); return; }
  const pcm = data.pcm;
  if (!pcm) return;
  // Late frames from a torn-down graph are simply not audio any more.
  if (recording.state !== 'starting' && recording.state !== 'recording') return;

  // Wall-clock seconds this frame represents. The gates are judged in real time
  // (a minute of waiting is a minute); the popup's clock is BOOK time, which at
  // speed S runs S times faster because the file is labelled S times slower.
  const wallSeconds = secondsFromBytes(pcm.byteLength, recSampleRate, recChannels);
  const bookSeconds = wallSeconds * recSpeed;

  const verdict = recWatch?.feed(data.peak ?? 0, wallSeconds) ?? null;
  recording = {
    ...recording,
    level: data.rms ?? 0,
    captureSampleRate: recSampleRate,
    // Silence before any audio is a STATE, not a failure: the user pressed Record
    // before Play, which is a reasonable order to do things in. The recording is
    // running; the popup says what it is waiting for — and shows the countdown,
    // because the same 30 s rule that ends a finished book also ends this.
    waiting: recWatch ? recWatch.waiting : false,
    silenceRemaining: recWatch ? recWatch.secondsUntilStop : RECORDER.SILENCE_STOP_SECONDS,
    // Provisional: record.progress replaces these with the server's byte count,
    // which is the truth about the file. Until the first one arrives, the popup
    // still needs a clock that moves.
    seconds: recording.seconds + bookSeconds,
    bytes: recording.bytes + pcm.byteLength
  };

  if (recordAcked) {
    sendBinary(pcm);
  } else {
    recPending.push(pcm);
    recPendingBytes += pcm.byteLength;
    if (recPendingBytes > RECORD_ACK_GRACE_SECONDS * bytesPerSecond(recSampleRate, recChannels)) {
      failRecording('BookForge never acknowledged the recording');
      return;
    }
  }

  if (verdict === 'silence-stop') {
    // The one rule, applied wherever the silence fell: the file is FINALIZED, not
    // discarded. A recording that was never fed anything saves an empty FLAC and
    // says why; a finished book saves the book and says why.
    void stopRecording(silenceStopReason());
  }
}

function flushPendingFrames(): void {
  for (const pcm of recPending) sendBinary(pcm);
  recPending = [];
  recPendingBytes = 0;
}

/**
 * Stop and keep the file. `warning` is set when the stop was not the user's own
 * button — the tab vanished, or the trailing-silence gate fired — so the popup
 * can say the recording is saved AND why it ended.
 */
async function stopRecording(warning?: string): Promise<void> {
  if (recording.state !== 'recording' && recording.state !== 'starting') return;
  const id = recordId;
  recording = { ...recording, state: 'stopping', ...(warning ? { warning } : {}) };
  broadcast();

  // Ask the worklet for the partial frame it is holding (< 100 ms) before the
  // graph goes away, so the tail of the recording is the tail of the audio.
  try { recTap?.port.postMessage({ flush: true }); } catch { /* graph already gone */ }
  await new Promise((r) => setTimeout(r, 80));

  teardownCapture();
  if (id && recorderSocketOpen()) {
    send({ action: 'record.stop', recordId: id });
  } else {
    // No socket: the server already finalized on our disconnect.
    noteRecordingLostSocket();
  }
  broadcast();
}

/** Throw the recording away. `error` turns Discard into a reported failure (the
 *  silence gate uses it); the user's own Discard passes nothing. */
async function discardRecording(error?: string): Promise<void> {
  const id = recordId;
  teardownCapture();
  recordId = null;
  recordAcked = false;
  recPending = [];
  recPendingBytes = 0;
  recWatch = null;
  recordingTicker(false);
  if (id && recorderSocketOpen()) send({ action: 'record.cancel', recordId: id });
  recording = error
    ? { ...IDLE_RECORDING, state: 'error', title: recording.title, error }
    : { ...IDLE_RECORDING };
  broadcast();
}

/** A named failure that ends the recording. Never a silent reset — the whole
 *  point of the recorder is that you find out at the time, not six hours later. */
function failRecording(message: string): void {
  const id = recordId;
  teardownCapture();
  recordId = null;
  recordAcked = false;
  recPending = [];
  recPendingBytes = 0;
  recWatch = null;
  recordingTicker(false);
  if (id && recorderSocketOpen()) send({ action: 'record.cancel', recordId: id });
  recording = {
    ...IDLE_RECORDING,
    state: 'error',
    title: recording.title,
    speed: recording.speed,
    error: message
  };
  broadcast();
}

/** The socket died with a recording live. The server finalizes it on its side, so
 *  this is a completed recording we simply cannot hear the confirmation of. */
function noteRecordingLostSocket(): void {
  if (!recordId) return;
  teardownCapture();
  recordId = null;
  recordAcked = false;
  recPending = [];
  recPendingBytes = 0;
  recWatch = null;
  recordingTicker(false);
  recording = {
    ...recording,
    state: 'done',
    level: 0,
    waiting: false,
    warning: 'Connection to BookForge was lost — the recording was saved up to that point'
  };
  broadcast();
}

/** Release the capture graph. Idempotent: every ending path calls it. */
function teardownCapture(): void {
  if (recTap) { try { recTap.port.onmessage = null; recTap.disconnect(); } catch { /* gone */ } recTap = null; }
  if (recSink) { try { recSink.disconnect(); } catch { /* gone */ } recSink = null; }
  if (recSource) { try { recSource.disconnect(); } catch { /* gone */ } recSource = null; }
  if (recStream) { for (const t of recStream.getTracks()) { try { t.stop(); } catch { /* gone */ } } recStream = null; }
  if (recCtx) { const ctx = recCtx; recCtx = null; void ctx.close().catch(() => { /* already closed */ }); }
}

function handleRecordEvent(msg: ServerEvent): void {
  switch (msg.type) {
    case 'record.started':
      if (msg.recordId !== recordId) return;
      recordAcked = true;
      recording = { ...recording, state: 'recording', path: msg.path };
      console.log(
        `[BFR] recording at ${recSpeed}x: ${recSampleRate} Hz capture → ` +
        `${relabelledSampleRate(recSampleRate, recSpeed)} Hz file`
      );
      flushPendingFrames();
      broadcast();
      return;
    case 'record.progress':
      if (msg.recordId !== recordId) return;
      // The server's byte count is the file's truth; our local running total was
      // only ever a placeholder until this arrived.
      recording = { ...recording, seconds: msg.seconds, bytes: msg.bytes };
      return; // the 250 ms ticker paints it
    case 'record.done': {
      if (msg.recordId !== recordId) return;
      recordId = null;
      recordAcked = false;
      recWatch = null;
      recordingTicker(false);
      teardownCapture();
      recording = {
        ...recording,
        state: 'done',
        path: msg.path,
        seconds: msg.seconds,
        bytes: msg.bytes,
        level: 0,
        waiting: false
      };
      broadcast();
      return;
    }
    case 'record.cancelled':
      if (msg.recordId !== recordId) return;
      recordId = null;
      recordAcked = false;
      recWatch = null;
      recordingTicker(false);
      // A cancel we made for a NAMED reason (the silence gate) has already put
      // that reason on screen; don't overwrite it with a blank idle state.
      if (recording.state !== 'error') recording = { ...IDLE_RECORDING };
      broadcast();
      return;
  }
}

// ─── Status + broadcast ───────────────────────────────────────────────────────

let statusTimer: number | null = null;

function ensureStatusTicker(): void {
  if (statusTimer !== null) return;
  statusTimer = setInterval(() => { notePlayedSentence(); reportPlayhead(); broadcast(); }, STATUS_INTERVAL_MS) as unknown as number;
}
function stopStatusTicker(): void {
  if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null; }
}

/** Sample where playback has actually got to, for {@link resumeCharForSwitch}. Runs
 *  on the status ticker, i.e. several times a second while a block plays. Only ever
 *  moves forward, and ignores the mid-reload window where currentTime reads 0. */
function notePlayedSentence(): void {
  if (!session || !started) return;
  if (audio.currentTime <= 0) return; // between blobs — the element has no position
  const idx = session.sentenceAt(audio.currentTime);
  if (idx > playedSentence) playedSentence = idx;
}

/**
 * The character offset a voice switch must pick the read back up at: the start of
 * the sentence the listener is on.
 *
 * Characters, not a sentence index, because that is what `startChar` is: startCurrent
 * turns it into a fraction of the block and sentenceStartSecondsFor maps that fraction
 * back over the NEW session's cumulative sentence lengths, so it lands on a sentence
 * boundary even if the server splits the text a little differently.
 *
 * Two things it must survive, both of which used to make it answer 0 — the beginning
 * of the block — for a listener who was well into it:
 *   - a stall. An underrun (or any sentence-boundary blob reload) leaves
 *     audio.currentTime at 0 until the reload completes, so the high-water mark
 *     playedSentence is consulted alongside the live reading, never instead of it.
 *   - never having started. A block still buffering has started === false and no
 *     position at all, but if the user clicked into the middle of it that intent is
 *     held in pendingStartFraction, and it is still where they want to be.
 */
function resumeCharForSwitch(): number {
  if (!session) return 0;
  if (!started) {
    // Not playing yet: keep the mid-block start point the user asked for, if any.
    if (pendingStartFraction == null || !sessionItem) return 0;
    return Math.floor(pendingStartFraction * sessionItem.text.length);
  }
  const sents = session.sentences;
  if (sents.length === 0) return 0;
  let idx = playedSentence;
  if (audio.currentTime > 0) idx = Math.max(idx, session.sentenceAt(audio.currentTime));
  return sents.slice(0, Math.min(idx, sents.length)).reduce((n, s) => n + s.length, 0);
}

function reportPlayhead(): void {
  if (!session || !started || audio.paused || session.generationDone) return;
  const idx = session.sentenceAt(audio.currentTime);
  if (idx !== lastReportedSentence) {
    lastReportedSentence = idx;
    listen.reportPlayhead(session.requestId, idx);
  }
}

/**
 * We want to be playing but the <audio> element isn't progressing because it ran
 * out of loaded audio — an underrun, or a sentence-boundary blob reload in flight.
 * A user pause or a genuine end-of-stream is NOT a stall.
 */
function isNonUserStall(): boolean {
  if (!started || userPaused || !session) return false;
  if (audio.ended) return !(session.generationDone && session.bytes <= blobBytes);
  return audio.paused; // paused without userPaused ⇒ mid-reload
}

function computeState(): PlaybackStatus['state'] {
  if (errorMsg) return 'error';
  if (!current || !session) return 'idle';
  if (!started) return preState === 'buffering' ? 'buffering' : preState;
  if (audio.ended && session.generationDone && session.bytes <= blobBytes) return 'ended';
  if (isNonUserStall()) {
    if (stallSince === null) stallSince = performance.now();
    // Quick boundary reloads resolve well within the grace and stay 'playing', so
    // the transport doesn't flicker; only a sustained underrun reports 'buffering'.
    return performance.now() - stallSince >= BUFFERING_GRACE_MS ? 'buffering' : 'playing';
  }
  stallSince = null;
  if (audio.paused) return userPaused ? 'paused' : 'playing';
  return 'playing';
}

function currentStatus(): PlaybackStatus {
  const s = session;
  return {
    state: computeState(),
    position: started ? audio.currentTime : 0,
    buffered: s ? s.seconds : 0,
    totalKnown: s ? s.complete : false,
    sentenceIndex: s && started ? s.sentenceAt(audio.currentTime) : -1,
    sentenceCount: s ? s.sentences.length : 0,
    sentences: s ? s.sentences : [],
    rate,
    paused: !!s && userPaused,
    error: errorMsg ?? undefined,
    note: s?.note ?? undefined
  };
}

function broadcast(): void {
  const rendered: string[] = [];
  for (const [id, r] of renderedByItem) if (r.complete) rendered.push(id);
  if (current && session?.complete) rendered.push(current.id);
  const snapshot: QueueSnapshot = {
    connected: isConnected(),
    engineState: engineState(),
    current,
    upcoming,
    playback: currentStatus(),
    run: runProgress(),
    connectionError: connectionError ?? undefined,
    voices,
    voiceRows,
    // The voice a read will actually be spoken in: the RESIDENT one. What the
    // picker is showing is `chosenVoice`, which is what Load would make
    // resident — the two differ exactly while nothing (or something else) is on
    // the card, and saying so is the point.
    currentVoice: voiceForSpeak() ?? chosenVoice,
    switchingVoice,
    engine: engineStatus(),
    renderedItemIds: rendered,
    recording
  };
  // Up to background, which projects per-tab UiState to content and pushes the
  // full snapshot to the popup. (No chrome.storage here — unavailable offscreen.)
  chrome.runtime.sendMessage({ target: 'background', cmd: 'snapshot', snapshot }).catch(() => { /* asleep */ });
}

// ─── Audio element events ─────────────────────────────────────────────────────

audio.addEventListener('ended', () => {
  if (!session) return;
  resumeIfReady();
  broadcast();
});

// ─── Message intake ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!raw || (raw as { target?: string }).target !== 'offscreen') return;
  const msg = raw as OffscreenMessage;
  switch (msg.cmd) {
    case 'play': playNow(msg.item); break;
    case 'play-sequence': playSequence(msg.items); break;
    case 'enqueue': enqueue(msg.item); break;
    case 'transport': handleTransport(msg); break;
    case 'record': void handleRecord(msg); break;
    case 'engine': void handleEngine(msg.op, msg.voice); break;
    case 'set-voice': void handleSetVoice(msg.voice); break;
    case 'set-clip': void handleSetClip(msg.clipId); break;
    case 'set-idle': void handleSetIdle(msg.minutes); break;
    case 'server-changed': void handleServerChanged(); break;
    case 'queue':
      if (msg.op === 'remove' && msg.id) removeFromQueue(msg.id);
      else if (msg.op === 'clear') clearUpcoming();
      else if (msg.op === 'skip') skipCurrent();
      break;
    case 'sync': void doSync(); break;
  }
});

// Seed the picker's voice and the idle window from storage before anything can
// happen, so the pickers are not blank for the first few hundred milliseconds
// and the countdown is the one the user chose.
void getSettings().then((s) => {
  if (!chosenVoice && s.voice) chosenVoice = s.voice;
  if (chosenClipId === null && s.zeroshotClipId !== '') chosenClipId = s.zeroshotClipId;
  idleMinutes = s.idleMinutes;
  broadcast();
});

// Emit an initial snapshot so an already-open popup gets immediate state.
broadcast();

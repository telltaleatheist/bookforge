/**
 * Offscreen document — owns the WebSocket, the protocol state machine, PCM
 * assembly, the audio player, the LRU cache, AND the play queue. MV3 service
 * workers can't hold an AudioContext/<audio> and get killed when idle, so all of
 * that lives here. One offscreen document serves every tab (matching the
 * server's single global session). Background relays commands in and broadcasts
 * the queue snapshot out.
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

import {
  BYTES_PER_SECOND,
  CLOSE_AUTH,
  EngineState,
  ServerConfig,
  ServerEvent,
  ClientAction,
  SpeakSettings,
  decodeBase64
} from './protocol';
import {
  PlaybackStatus,
  QueueItem,
  QueueSnapshot,
  RunProgress,
  PlayItemCmd,
  PlaySequenceCmd,
  TransportCmd,
  EngineOffscreenCmd,
  QueueOffscreenCmd,
  SyncOffscreenCmd,
  SetVoiceOffscreenCmd,
  SetIdleOffscreenCmd,
  RestartEngineOffscreenCmd,
  Settings,
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
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd
  | SetVoiceOffscreenCmd
  | SetIdleOffscreenCmd
  | RestartEngineOffscreenCmd;

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
// The projection is what covers Orpheus/MLX. Its batches are 16 sentences wide and
// take 30-43s of wall clock at ANY width (measured: per-row decode ~17-20 steps/s
// regardless of batch width; width 16 = 2.8x realtime aggregate), and since the
// server no longer streams solo openers, NOTHING arrives until the first batch lands.
// The buffer then jumps ~120s at once — far past any projected deficit — so the gate
// opens exactly there, ~35-45s in. That one wait is the price of never stalling again.
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
// Continuous read-ahead depth. Across a run of blocks, keep the single global server
// session generating upcoming blocks into the cache — in playback order — until this
// many seconds of audio sit ready ahead of the current block. Crossing a block
// boundary then plays from cache instead of stalling while the next block generates.
//
// Sized to buffer a whole short article ahead (~2000s ≈ 5000 spoken words). Cached
// audio is PCM16 mono @ 24 kHz = 48 KB/s, so 2000s ≈ 96 MB — held in the LRU cache
// below, which is itself capped at CACHE_LIMIT_BYTES (256 MB) and evicts oldest
// blocks first, so a longer page just keeps a rolling ~5000-word window in memory.
const PREFETCH_LOOKAHEAD_SECONDS = 2000;
const SEEK_STEP_GRACE = 0.05;
// Blocks are paragraphs (p / li / heading / blockquote …). Append this much silence
// to the end of each block's audio so paragraphs get a real pause between them
// instead of running together — on top of the engine's own intra-sentence gap. Part
// of the block's cached audio, so replays/seeks keep the pacing. 0 disables.
const PARAGRAPH_GAP_SECONDS = 0.5;
const STATUS_INTERVAL_MS = 300;
// A blob reload at a sentence boundary briefly ends/pauses the <audio> element.
// Reporting 'buffering' for those sub-second gaps makes the transport flicker at
// every sentence even when playback is smooth, so we only surface 'buffering' once
// a non-user stall has lasted at least this long (a genuine generation underrun).
const BUFFERING_GRACE_MS = 450;

// ─── PCM assembly ─────────────────────────────────────────────────────────────

interface Slot { chunks: Uint8Array[]; done: boolean; }

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
  gapAppended = false;
  note: string | null = null;
  /** Sentences [0, resumeFrom) came from a cached PARTIAL render — their audio is
   *  already in `segments`, and the server was asked to generate only from here
   *  on. 0 for a session rendered from scratch. */
  resumeFrom = 0;
  /** When this session's generation began (Date.now()), and the audio it already
   *  held at that moment (a cached partial prefix). Together they turn `seconds`
   *  into a generation RATE — what the adaptive start gate projects from. Set when
   *  the speak goes out; a cached prefix must not be counted as freshly generated
   *  or the rate reads as instant. */
  genStartedAt = Date.now();
  baseSeconds = 0;

  constructor(requestId: string) { this.requestId = requestId; }

  initSlots(sentences: string[]): void {
    this.sentences = sentences;
    this.slots = sentences.map((_, i) => ({ chunks: [], done: i < this.resumeFrom }));
  }
  addChunk(i: number, seq: number, bytes: Uint8Array): void {
    let slot = this.slots[i];
    if (!slot) { slot = { chunks: [], done: false }; this.slots[i] = slot; }
    slot.chunks[seq] = bytes;
  }
  markDone(i: number): void { const s = this.slots[i]; if (s) s.done = true; }
  markFailed(i: number): void { const s = this.slots[i]; if (s) { s.chunks = []; s.done = true; } }

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
  s.gapAppended = cached.complete; // the trailing paragraph pause is already in there
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
// When the user clicks mid-block, the fraction (0..1) into the block where playback
// should begin. Resolved to a sentence boundary once that sentence is buffered, so
// the existing/cached audio is reached by a seek rather than re-synthesized. null
// for a normal start-at-top read.
let pendingStartFraction: number | null = null;
let playSeq = 0;
let reqCounter = 0;
const cacheKeyByRequest = new Map<string, string>();

// ─── WebSocket ────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let authed = false;
let connectPromise: Promise<void> | null = null;
let engineState: EngineState = 'stopped';
let connectionError: string | null = null; // why we're not connected (for the popup)
// Engine catalog/topology mirrored from hello/status/config events, surfaced in the
// snapshot so the popup can render the voice + worker-count controls.
let voices: string[] = [];
let serverVoice: string | null = null; // what the engine reports it has loaded
let serverConfig: ServerConfig | null = null;

// ─── The chosen voice ─────────────────────────────────────────────────────────
//
// One value decides what speaks: whatever the picker shows. It is sent EXPLICITLY
// on every speak — never omitted — because a speak without a voice lets the server
// fall back to whatever model it happens to have warm, which is how a block ends
// up read by a narrator nobody selected. Until the first connect tells us what the
// engine has, it's null and we adopt the engine's answer.
let chosenVoice: string | null = null;
let switchingVoice: string | null = null;
// Resolvers waiting for the engine to confirm it loaded `switchingVoice`.
let voiceWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
// Bumped per switch, so an earlier switch that's still awaiting confirmation can
// tell it has been superseded and bow out instead of restarting playback late.
let voiceSwitchToken = 0;
// A voice load can be a whole model swap on Orpheus; give it room, and let the
// user hit stop meanwhile.
const VOICE_SWITCH_TIMEOUT_MS = 200_000;

function sameVoice(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The voice to speak with, or null if we've never heard from the engine. */
function voiceForSpeak(): string | null {
  return chosenVoice ?? serverVoice;
}

/**
 * Keep our chosen voice honest against what the engine actually offers: adopt its
 * voice the first time we learn one, and fall back to it if what we had stored
 * isn't in the catalogue any more (a renamed or removed finetune) — otherwise
 * every speak would fail on a voice that no longer exists.
 */
function adoptServerVoice(): void {
  if (!serverVoice) return;
  const stale = chosenVoice && voices.length > 0 && !voices.some((v) => sameVoice(v, chosenVoice));
  if (chosenVoice && !stale) return;
  if (stale) console.warn(`[BFR] voice '${chosenVoice}' is not installed; using '${serverVoice}'`);
  chosenVoice = serverVoice;
  persistVoice(serverVoice);
}

function persistVoice(voice: string): void {
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'put-settings', patch: { voice } })
    .catch(() => { /* background asleep; storage is re-read on next start */ });
}

/** Settle the pending voice switch once the engine confirms (or fails). */
function resolveVoiceWait(err?: Error): void {
  const waiters = voiceWaiters;
  voiceWaiters = [];
  for (const w of waiters) { if (err) w.reject(err); else w.resolve(); }
}

function isConnected(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN && authed);
}

/**
 * Connect, retrying a couple of times before giving up. A single failed socket is
 * usually just the app mid-restart or the port not yet bound; surfacing "can't
 * reach BookForge" on the first miss made the user re-click for something that
 * would have worked a beat later. A rejected token is NOT retried — that won't fix
 * itself.
 */
async function ensureConnected(): Promise<void> {
  const backoff = [0, 400, 1200];
  let lastError: Error | null = null;
  for (const wait of backoff) {
    if (isConnected()) return;
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
  if (isConnected()) return;
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
          engineState = msg.state;
          voices = msg.voices;
          serverVoice = msg.currentVoice;
          adoptServerVoice();
          serverConfig = msg.config;
          connectionError = null;
          clearTimeout(timeout);
          console.log('[BFR] connected; engine', msg.state, '| voices', msg.voices.length);
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

function onSocketClosed(): void {
  engineState = 'stopped';
  // The socket is gone, so every in-flight read-ahead session is now unreachable and
  // will never receive a terminal event. Forget them (no cancel — there's no socket
  // to send it on) so isPrefetchingItem() stops reporting them forever and
  // fillPrefetch() can regenerate on reconnect, and so adoptPrefetchFor() can't adopt
  // a dead, never-completing session. COMPLETED blocks already live in the cache
  // (readyAhead), so those stay valid and are left untouched.
  for (const requestId of [...prefetches.keys()]) forgetPrefetch(requestId);
  if (session && !session.generationDone) {
    finishGeneration(false, 'Connection to BookForge lost');
    afterData();
  }
  broadcast();
}

// ─── Server events ────────────────────────────────────────────────────────────

function handleServerEvent(msg: ServerEvent): void {
  // Events for a read-ahead session accumulate quietly and never touch the player
  // or the broadcast — the UI still reflects the currently-playing item.
  if ('requestId' in msg && msg.requestId !== undefined) {
    const entry = prefetches.get(msg.requestId);
    if (entry) { handlePrefetchEvent(entry, msg); return; }
  }
  switch (msg.type) {
    case 'state':
      engineState = msg.state;
      if (!started && session) preState = msg.state === 'running' ? 'buffering' : 'starting-engine';
      broadcast();
      return;
    case 'status':
      engineState = msg.state;
      voices = msg.voices;
      serverVoice = msg.currentVoice;
      adoptServerVoice();
      serverConfig = msg.config;
      noteVoiceConfirmation();
      broadcast();
      return;
    case 'config':
      voices = msg.voices;
      serverVoice = msg.currentVoice;
      adoptServerVoice();
      serverConfig = msg.config;
      noteVoiceConfirmation();
      broadcast();
      return;
    case 'speaking':
      if (!session || msg.requestId !== session.requestId) return;
      // A resumed session splices new audio onto a cached prefix, so the server's
      // segmentation has to be the one that prefix was rendered against. It always
      // is (same text in, same split out) — but if it ever isn't, the splice would
      // be silently wrong, so restart the block clean instead.
      if (session.resumeFrom > 0 && !sameSentences(session.sentences, msg.sentences)) {
        console.warn('[BFR] segmentation changed under a resumed block — re-rendering it whole');
        void restartCurrentFromScratch();
        return;
      }
      session.initSlots(msg.sentences);
      broadcast();
      return;
    case 'chunk':
      if (!session || msg.requestId !== session.requestId) return;
      session.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data));
      session.drain();
      afterData();
      return;
    case 'done':
      if (!session || msg.requestId !== session.requestId) return;
      session.markDone(msg.sentenceIndex);
      session.drain();
      afterData();
      return;
    case 'failed':
      if (!session || msg.requestId !== session.requestId) return;
      session.markFailed(msg.sentenceIndex);
      session.drain();
      afterData();
      return;
    case 'complete':
      if (!session || msg.requestId !== session.requestId) return;
      finishGeneration(true);
      retainSession(session, sessionItem);
      afterData();
      fillPrefetch(); // current done — top up the read-ahead pipeline
      return;
    case 'cancelled':
      if (!session || msg.requestId !== session.requestId) return;
      // Keep what it managed to render: the next play resumes from there rather
      // than paying to synthesize these sentences again.
      retainSession(session, sessionItem);
      finishGeneration(false, 'Playback was taken over by another BookForge client');
      concludeIfIdle();
      broadcast();
      return;
    case 'error':
      if (session && msg.requestId !== undefined && msg.requestId !== session.requestId) return;
      if (session) retainSession(session, sessionItem);
      errorMsg = msg.message || 'TTS error';
      if (session) { finishGeneration(false); concludeIfIdle(); }
      // An error while switching voices must not leave the switch hanging.
      if (switchingVoice) { switchingVoice = null; resolveVoiceWait(new Error(errorMsg)); }
      broadcast();
      return;
  }
}

function sameSentences(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** The engine reported its loaded voice; settle any switch waiting on it. */
function noteVoiceConfirmation(): void {
  if (!switchingVoice) return;
  if (sameVoice(serverVoice, switchingVoice)) {
    switchingVoice = null;
    resolveVoiceWait();
  }
}

function finishGeneration(success: boolean, note?: string): void {
  if (!session) return;
  session.generationDone = true;
  if (success) { session.complete = true; appendParagraphGap(session); }
  if (note) session.note = note;
}

/**
 * Append a paragraph-length silence to a completed block's audio (once). Blocks are
 * paragraphs, so this gives a real pause before the next block plays. Added to the
 * segments after the last sentence's audio — beyond the per-sentence boundaries, so
 * sentence mapping/playhead are unaffected — and it travels into the cache with the
 * block, so a later replay/seek keeps the same pacing.
 */
function appendParagraphGap(s: Session): void {
  if (s.gapAppended || s.bytes === 0 || PARAGRAPH_GAP_SECONDS <= 0) return;
  const n = Math.floor(PARAGRAPH_GAP_SECONDS * BYTES_PER_SECOND);
  const silence = new Uint8Array(n - (n % 2)); // PCM16 = 2 bytes/sample, keep aligned
  s.segments.push(silence);
  s.bytes += silence.length;
  s.gapAppended = true;
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

function cancelGeneration(): void {
  if (session && !session.generationDone && isConnected()) {
    send({ action: 'cancel', requestId: session.requestId });
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
  pendingStartFraction = null;
  stallSince = null;
  errorMsg = null;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
}

// ─── Read-ahead (concurrent prefetch of upcoming blocks) ───────────────────────

/** How many read-ahead blocks to generate at once. Sized to the engine's worker
 *  count so even one-sentence blocks keep every worker busy; the playing block is
 *  served first (the server runs read-ahead at low priority), so this is just the
 *  fan-out that fills the spare workers. Falls back to 4 before config arrives. */
function prefetchConcurrency(): number {
  return Math.max(1, serverConfig?.deviceWorkers ?? 4);
}

function isPrefetchingItem(id: string): boolean {
  if (startingItems.has(id)) return true;
  for (const { item } of prefetches.values()) if (item.id === id) return true;
  return false;
}

/** Accumulate a read-ahead session's audio without disturbing current playback. */
function handlePrefetchEvent(entry: { session: Session; item: QueueItem }, msg: ServerEvent): void {
  const { session: s, item } = entry;
  switch (msg.type) {
    case 'speaking':
      if (s.resumeFrom > 0 && !sameSentences(s.sentences, msg.sentences)) {
        // Can't splice onto a prefix rendered against a different split — drop the
        // stale partial and let the next fillPrefetch render this block whole.
        const key = cacheKeyByRequest.get(s.requestId);
        if (key) { cache.delete(key); forgetRendered(key); }
        dropPrefetchByRequest(s.requestId);
        return;
      }
      s.initSlots(msg.sentences);
      return;
    case 'chunk': s.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data)); s.drain(); return;
    case 'done': s.markDone(msg.sentenceIndex); s.drain(); return;
    case 'failed': s.markFailed(msg.sentenceIndex); s.drain(); return;
    case 'complete':
      s.generationDone = true;
      s.complete = true;
      s.drain();
      appendParagraphGap(s); // paragraph pause baked into the cached block
      retainSession(s, item);
      // This block is done and lives in the cache now; free the slot and keep the
      // read-ahead pipeline going on the next not-yet-ready block.
      prefetches.delete(s.requestId);
      fillPrefetch();
      broadcast(); // the page marks this block as rendered
      return;
    case 'cancelled':
    case 'error':
      // Cancelled or failed before we adopted it. Keep whatever it rendered so the
      // next attempt resumes from there instead of starting the block over.
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

async function startPrefetch(item: QueueItem): Promise<void> {
  const seq = playSeq;
  startingItems.add(item.id); // synchronous reservation (closed in finally)
  try {
    const voice = voiceForSpeak();
    const key = await cacheKeyFor(voice ?? '', item.text);
    // Re-validate after the awaits: still the same playback context, the target still
    // queued, and not already cached or in flight on another session.
    if (seq !== playSeq) return;
    const hit = cacheGet(key);
    if (hit?.complete) { markRendered(item, key, hit.bytes / BYTES_PER_SECOND, true); return; }
    if (!upcoming.some((u) => u.id === item.id)) return;
    if ([...prefetches.values()].some((p) => p.item.id === item.id)) return;
    try { await ensureConnected(); } catch { return; }
    if (seq !== playSeq || !upcoming.some((u) => u.id === item.id)) return;
    if ([...prefetches.values()].some((p) => p.item.id === item.id)) return;

    // A partial hit means an earlier pass rendered part of this block. Pick up
    // where it stopped rather than paying for those sentences twice.
    const requestId = `${item.id}#pf${++reqCounter}`;
    const s = hit ? sessionFromCache(requestId, hit) : new Session(requestId);
    prefetches.set(s.requestId, { session: s, item });
    cacheKeyByRequest.set(s.requestId, key);
    const speakSettings: SpeakSettings = { speed: 1.0 };
    if (voice) speakSettings.voice = voice;
    console.log('[BFR] prefetch', s.requestId, '|', item.text.length, 'chars',
      s.resumeFrom > 0 ? `| resuming at sentence ${s.resumeFrom}` : '');
    // Rate baseline, as in startCurrent: a read-ahead session that is later adopted
    // brings its measured rate with it, so the gate judges it on real evidence.
    s.genStartedAt = Date.now();
    s.baseSeconds = s.seconds;
    // preempt:false so it coexists with the playing block; background:true so the
    // server batches it at low pool priority behind what's actually being heard.
    send({
      action: 'speak',
      requestId: s.requestId,
      text: item.text,
      settings: speakSettings,
      preempt: false,
      background: true,
      startSentence: s.resumeFrom
    });
  } finally {
    startingItems.delete(item.id);
    fillPrefetch(); // settle: a cache hit / abort frees the slot for the next block
  }
}

/** Remove a read-ahead session's bookkeeping WITHOUT sending a cancel — for when the
 *  socket is gone (nothing to send it on) or the server already ended the session. */
function forgetPrefetch(requestId: string): void {
  cacheKeyByRequest.delete(requestId);
  prefetches.delete(requestId);
}

/** Abandon one read-ahead session by requestId. */
function dropPrefetchByRequest(requestId: string): void {
  const entry = prefetches.get(requestId);
  if (!entry) return;
  if (!entry.session.generationDone && isConnected()) send({ action: 'cancel', requestId });
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

  // Tell the server this session is now the playing one so it lifts it from LOW
  // (background) to playing priority. Server-side promotion normally rides on a
  // playhead report, but reportPlayhead() is gated on started && !paused — which can't
  // happen until audio buffers at LOW priority (a block-boundary stall). playhead:0 is
  // safe: the server only advances the playhead when the reported index is greater.
  if (!s.generationDone && isConnected()) {
    send({ action: 'playhead', requestId: s.requestId, sentenceIndex: 0 });
  }

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
 *   2. it's partly cached         → speak from `startSentence`, keeping the prefix
 *   3. nothing held               → speak it whole
 *
 * @param preempt true for a user-initiated play — takes the audio output over from
 *   other clients (our OWN read-ahead is deliberately left running; cancelling it
 *   would throw away audio we've already rendered). false when advancing within a
 *   run.
 */
async function startCurrent(preempt: boolean): Promise<void> {
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

  const voice = voiceForSpeak();
  const key = await cacheKeyFor(voice ?? '', item.text);
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

  // Partly cached (an earlier pass was interrupted) — keep those sentences and ask
  // only for the rest.
  const s = cached ? sessionFromCache(`${item.id}#${++reqCounter}`, cached) : new Session(`${item.id}#${++reqCounter}`);
  session = s;
  sessionItem = item;
  cacheKeyByRequest.set(s.requestId, key);

  try {
    await ensureConnected();
  } catch (err) {
    if (seq !== playSeq) return;
    console.warn('[BFR] connect failed:', (err as Error).message);
    errorMsg = connectErrorMessage((err as Error).message);
    finishGeneration(false);
    broadcast();
    return;
  }
  if (seq !== playSeq) return;

  const speakSettings: SpeakSettings = { speed: 1.0 };
  if (voice) speakSettings.voice = voice;
  preState = engineState === 'running' ? 'buffering' : 'starting-engine';
  console.log('[BFR] speak', s.requestId, '| engine', engineState, '|', item.text.length, 'chars',
    s.resumeFrom > 0 ? `| resuming at sentence ${s.resumeFrom}` : '');
  // Generation starts NOW: everything already in `segments` is a cached prefix, so
  // the adaptive start gate measures the rate from here (see startThresholdSeconds).
  s.genStartedAt = Date.now();
  s.baseSeconds = s.seconds;
  // The playing block is foreground (background:false) so it's served before
  // read-ahead. preempt takes over from OTHER clients only — the server spares our
  // own sessions, so the read-ahead we already paid for survives.
  send({
    action: 'speak',
    requestId: s.requestId,
    text: item.text,
    settings: speakSettings,
    preempt,
    background: false,
    startSentence: s.resumeFrom
  });
  broadcast();
  fillPrefetch(); // generate upcoming blocks alongside this one (sent after, so it's served first)
}

/**
 * The cached prefix a resumed block was splicing onto turned out not to match the
 * server's segmentation. Drop it and render the block whole under a fresh id (the
 * old request is cancelled, so its late events are ignored).
 */
async function restartCurrentFromScratch(): Promise<void> {
  const s = session;
  const item = current;
  if (!s || !item) return;
  const key = cacheKeyByRequest.get(s.requestId);
  if (key) { cache.delete(key); forgetRendered(key); }
  if (isConnected()) send({ action: 'cancel', requestId: s.requestId });
  cacheKeyByRequest.delete(s.requestId);
  session = null;
  sessionItem = null;
  await startCurrent(false);
}

function connectErrorMessage(code: string): string {
  switch (code) {
    case 'NO_TOKEN': return 'No token configured — open options and paste the token.';
    case 'BAD_TOKEN': return 'BookForge rejected the token — check it in options.';
    default: return "Can't reach BookForge — is the app running?";
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
  if (session.generationDone) return true;
  if (session.sentences.length > 0 && session.appendCursor >= session.sentences.length) return true;
  const threshold = startThresholdSeconds({
    arrivedSeconds: session.seconds - session.baseSeconds,
    wallSeconds: (Date.now() - session.genStartedAt) / 1000,
    arrivedSentences: session.appendCursor - session.resumeFrom,
    remainingSentences: session.sentences.length - session.appendCursor
  });
  return session.seconds - fromSeconds >= threshold;
}

// ─── gate math (pure; exercised by scratchpad/gate-math.test.mjs) ──────────────
/**
 * How many seconds of audio must sit ahead of the start point before playback may
 * begin, given how this session's generator is actually performing.
 *
 * The rule is just "don't start something you can't finish". Playback drains 1s of
 * buffer per second; the generator refills it at R = arrived/wall seconds of audio
 * per wall second. If R >= 1 it can never be caught, so only the floor applies. If
 * R < 1 it falls behind by (1/R - 1) seconds for every second of audio still to
 * come, and ALL of that deficit has to be pre-bought before the first note plays:
 *
 *     threshold = max(START_MIN_SECONDS, remainingAudio x (1/R - 1) + margin)
 *
 * Worked: R=0.5 with 40s of audio left needs 40s buffered (+margin) — start on less
 * and the playhead is guaranteed to hit the live edge partway through. R=1.3 needs
 * nothing beyond the floor.
 *
 * Returns Infinity when NOTHING has arrived yet (R is unmeasurable and the buffer is
 * empty anyway) — the gate stays shut until the b)/c) short-circuits or the first
 * audio lands. On MLX that is precisely the first-batch moment: ~120s arrives at
 * once, R jumps to ~2.8x, and the floor lets it straight through.
 */
function startThresholdSeconds(gen: {
  arrivedSeconds: number;
  wallSeconds: number;
  arrivedSentences: number;
  remainingSentences: number;
}): number {
  if (gen.arrivedSeconds <= 0 || gen.wallSeconds <= 0) return Infinity;
  const rate = gen.arrivedSeconds / gen.wallSeconds;
  if (rate <= 0) return Infinity;
  const perSentence = gen.arrivedSentences > 0
    ? gen.arrivedSeconds / gen.arrivedSentences
    : DEFAULT_SECONDS_PER_SENTENCE;
  const remainingAudio = Math.max(0, gen.remainingSentences) * perSentence;
  const deficit = remainingAudio * Math.max(0, 1 / rate - 1);
  return Math.max(START_MIN_SECONDS, deficit + SAFETY_MARGIN_SECONDS);
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

// ─── Engine control ───────────────────────────────────────────────────────────

async function handleEngine(op: 'start' | 'stop'): Promise<void> {
  if (op === 'start') {
    try { await ensureConnected(); } catch (err) {
      connectionError = connectErrorMessage((err as Error).message);
      broadcast();
      return;
    }
    const voice = voiceForSpeak();
    send(voice ? { action: 'engine.start', voice } : { action: 'engine.start' });
    broadcast();
  } else {
    if (isConnected()) send({ action: 'engine.stop' });
  }
}

/**
 * Switch the voice — and mean it. On Orpheus a voice IS a model, so this stops
 * everything in flight, tells the engine to load it, and WAITS for the engine to
 * confirm that model is what's loaded before a single word is spoken. Only then
 * does whatever was playing restart, in the new voice, from the sentence the
 * listener had reached.
 *
 * The old voice's audio stays in the cache under its own key — switch back and it
 * replays instantly instead of being rendered again.
 */
async function handleSetVoice(voice: string): Promise<void> {
  if (!voice || sameVoice(voice, chosenVoice)) return;
  const token = ++voiceSwitchToken;
  // A switch already waiting is now moot — let it go without it reporting an error.
  resolveVoiceWait();

  // Where to pick the read back up: the character offset of the sentence being
  // read. (Counting characters, not sentences — startChar is resolved back through
  // cumulative sentence lengths, so a sentence-count fraction would drift on a
  // paragraph of uneven sentences.)
  const resumeChar = started && session && session.sentences.length > 0
    ? session.sentences.slice(0, session.sentenceAt(audio.currentTime)).reduce((n, s) => n + s.length, 0)
    : 0;
  const wasPlaying = !!current;

  // Nothing may keep generating in the outgoing voice.
  cancelGeneration();
  dropAllPrefetch();
  forgetAllRendered();
  chosenVoice = voice;
  switchingVoice = voice;
  persistVoice(voice);
  broadcast();

  try { await ensureConnected(); } catch (err) {
    if (token !== voiceSwitchToken) return;
    switchingVoice = null;
    connectionError = connectErrorMessage((err as Error).message);
    resolveVoiceWait(err as Error);
    broadcast();
    return;
  }

  const confirmed = new Promise<void>((resolve, reject) => {
    voiceWaiters.push({ resolve, reject });
    setTimeout(() => {
      if (switchingVoice === voice && token === voiceSwitchToken) {
        switchingVoice = null;
        resolveVoiceWait(new Error(`Timed out loading voice '${voice}'`));
      }
    }, VOICE_SWITCH_TIMEOUT_MS);
  });
  send({ action: 'config.set', voice });

  try {
    await confirmed;
  } catch (err) {
    if (token !== voiceSwitchToken) return;
    errorMsg = (err as Error).message;
    broadcast();
    return;
  }
  if (token !== voiceSwitchToken) return; // a newer switch owns the engine now

  // Confirmed loaded. Pick the read back up where it was, now in the new voice.
  if (wasPlaying && current) {
    current = { ...current, startChar: resumeChar > 0 ? resumeChar : undefined };
    await startCurrent(true);
  } else {
    broadcast();
  }
}

/** Persist the idle-shutdown window server-side. Applies to the running engine on
 *  its next sweep, so nothing needs restarting. */
async function handleSetIdle(minutes: number): Promise<void> {
  try { await ensureConnected(); } catch (err) {
    connectionError = connectErrorMessage((err as Error).message);
    broadcast();
    return;
  }
  send({ action: 'config.set', idleMinutes: minutes });
}

/** Restart the engine to apply a worker count and/or warm a voice. The server
 *  replies with 'state' pushes then a final 'status', refreshing the snapshot. */
async function handleRestart(cpuWorkers?: number, voice?: string): Promise<void> {
  try { await ensureConnected(); } catch (err) {
    connectionError = connectErrorMessage((err as Error).message);
    broadcast();
    return;
  }
  send({ action: 'engine.restart', voice: voice || undefined, cpuWorkers });
  broadcast();
}

async function doSync(): Promise<void> {
  // Refresh engine state for the popup; don't start anything.
  broadcast(); // instant: confirm the pipe works while we (re)connect
  try { await ensureConnected(); }
  catch (err) { connectionError = connectErrorMessage((err as Error).message); }
  broadcast();
}

// ─── Status + broadcast ───────────────────────────────────────────────────────

let statusTimer: number | null = null;

function ensureStatusTicker(): void {
  if (statusTimer !== null) return;
  statusTimer = setInterval(() => { reportPlayhead(); broadcast(); }, STATUS_INTERVAL_MS) as unknown as number;
}
function stopStatusTicker(): void {
  if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null; }
}

function reportPlayhead(): void {
  if (!session || !started || audio.paused || session.generationDone) return;
  if (!isConnected()) return;
  const idx = session.sentenceAt(audio.currentTime);
  if (idx !== lastReportedSentence) {
    lastReportedSentence = idx;
    send({ action: 'playhead', requestId: session.requestId, sentenceIndex: idx });
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
    engineState,
    current,
    upcoming,
    playback: currentStatus(),
    run: runProgress(),
    connectionError: connectionError ?? undefined,
    voices,
    // The picker shows what we WILL speak with, not what the engine happens to
    // have warm — those are the same thing by construction now.
    currentVoice: voiceForSpeak(),
    switchingVoice,
    config: serverConfig,
    renderedItemIds: rendered
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
    case 'engine': void handleEngine(msg.op); break;
    case 'set-voice': void handleSetVoice(msg.voice); break;
    case 'set-idle': void handleSetIdle(msg.minutes); break;
    case 'restart-engine': void handleRestart(msg.cpuWorkers, msg.voice); break;
    case 'queue':
      if (msg.op === 'remove' && msg.id) removeFromQueue(msg.id);
      else if (msg.op === 'clear') clearUpcoming();
      else if (msg.op === 'skip') skipCurrent();
      break;
    case 'sync': void doSync(); break;
  }
});

// Seed the chosen voice from storage before anything can speak, so the very first
// request already carries the voice the pickers are showing rather than leaving
// the server to pick one.
void getSettings().then((s) => {
  if (!chosenVoice && s.voice) { chosenVoice = s.voice; broadcast(); }
});

// Emit an initial snapshot so an already-open popup gets immediate state.
broadcast();

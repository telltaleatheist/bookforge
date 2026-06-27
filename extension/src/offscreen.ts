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
  PlayItemCmd,
  PlaySequenceCmd,
  TransportCmd,
  EngineOffscreenCmd,
  QueueOffscreenCmd,
  SyncOffscreenCmd,
  SetVoiceOffscreenCmd,
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
  | RestartEngineOffscreenCmd;

// ─── Tunables ─────────────────────────────────────────────────────────────────

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const START_MIN_SECONDS = 8;
// Start playing as soon as the first sentence is assembled — we hold for at least one
// finished sentence plus this small floor of audio behind it. Concurrent read-ahead
// now generates the current block's remaining sentences in parallel (~2x real-time
// aggregate) and prefetches the next block, so the buffer keeps growing under the
// playhead without a big head start; a larger cushion here just delays time-to-audio.
// generationDone and START_MIN_SECONDS still let short clips / long single sentences
// start without waiting for a cushion that will never come.
const STARTUP_LEAD_SECONDS = 1;
// After the playhead catches the live edge (underrun), wait until this much new
// audio has buffered before reloading. Kept small so an underrun becomes a brief
// boundary reload (landed in the natural gap between sentences) rather than a long
// stall. The buffering grace below hides these quick reloads from the UI.
const RESUME_MIN_SECONDS = 1.5;
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
  note: string | null = null;

  constructor(requestId: string) { this.requestId = requestId; }

  initSlots(sentences: string[]): void {
    this.sentences = sentences;
    this.slots = sentences.map(() => ({ chunks: [], done: false }));
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

interface CacheEntry {
  segments: Uint8Array[];
  bytes: number;
  boundaries: number[];
  sentences: string[];
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
  }
}
async function cacheKeyFor(voice: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${voice} ${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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

// queue
let current: QueueItem | null = null;
let upcoming: QueueItem[] = [];

// Read-ahead: while the current item plays, generate upcoming blocks into the cache
// CONCURRENTLY — each as its own server session ({preempt:false, background:true}) —
// so every engine worker stays busy instead of dribbling one block at a time. That's
// the whole game on CPU (Mac), where a single worker can't keep ahead of playback and
// the per-block pipeline otherwise behaves like one worker. On advance we "adopt" a
// finished (or still-in-flight) read-ahead session as the current player.
const prefetches = new Map<string /* requestId */, { session: Session; item: QueueItem }>();
const startingItems = new Set<string /* item id */>(); // items mid-start (async-gap guard)
// Seconds of cached audio already ready for each upcoming block (by item id), set as
// read-ahead/playback caches each block. Lets fillPrefetch measure how deep the buffer
// is — and pick the next not-yet-generated block — synchronously, without recomputing
// cache keys.
const readyAhead = new Map<string, number>();

// player (for the current item)
let session: Session | null = null;
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
let currentVoice: string | null = null;
let serverConfig: ServerConfig | null = null;

function isConnected(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN && authed);
}

async function ensureConnected(): Promise<void> {
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
          engineState = msg.state;
          voices = msg.voices;
          currentVoice = msg.currentVoice;
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
        const wasAuthed = authed;
        authed = false;
        if (ws === socket) ws = null;
        if (!wasAuthed) reject(new Error(e.code === CLOSE_AUTH ? 'BAD_TOKEN' : 'CONNECT_FAILED'));
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
      currentVoice = msg.currentVoice;
      serverConfig = msg.config;
      broadcast();
      return;
    case 'config':
      voices = msg.voices;
      currentVoice = msg.currentVoice;
      serverConfig = msg.config;
      broadcast();
      return;
    case 'speaking':
      if (!session || msg.requestId !== session.requestId) return;
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
      afterData();
      fillPrefetch(); // current done — top up the read-ahead pipeline
      return;
    case 'cancelled':
      if (!session || msg.requestId !== session.requestId) return;
      finishGeneration(false, 'Playback was taken over by another BookForge client');
      concludeIfIdle();
      broadcast();
      return;
    case 'error':
      if (session && msg.requestId !== undefined && msg.requestId !== session.requestId) return;
      errorMsg = msg.message || 'TTS error';
      if (session) { finishGeneration(false); concludeIfIdle(); }
      broadcast();
      return;
  }
}

function finishGeneration(success: boolean, note?: string): void {
  if (!session) return;
  session.generationDone = true;
  if (success) session.complete = true;
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
  current = item;
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
  current = first;
  upcoming = items.slice(1);
  startCurrent(true);
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
  readyAhead.delete(id);
  dropPrefetchForItem(id);
  fillPrefetch(); // a new item may now be next in line
  broadcast();
}

/** Clear upcoming but keep the current/playing item. */
function clearUpcoming(): void {
  upcoming = [];
  dropAllPrefetch();
  readyAhead.clear();
  broadcast();
}

/** Advance to the next item, or go idle if none. */
function skipCurrent(): void {
  cancelGeneration();
  const next = upcoming.shift();
  if (next) {
    if (adoptPrefetchFor(next)) return;
    current = next;
    startCurrent(false);
  } else {
    current = null;
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
  if (!next) { broadcast(); return; }
  if (adoptPrefetchFor(next)) return;
  current = next;
  startCurrent(false);
}

/** Stop everything (Stop button / page ✕ / tab navigation / tab close): cancel
 *  generation, drop the queue, go idle, and purge the read-ahead cache. The cache
 *  can hold up to CACHE_LIMIT_BYTES of generated audio; freeing it here means
 *  leaving a page (or hitting Stop) releases that memory promptly instead of
 *  waiting on LRU eviction or the offscreen document's idle teardown. */
function stopAll(): void {
  cancelGeneration();
  dropAllPrefetch();
  readyAhead.clear();
  current = null;
  upcoming = [];
  resetPlayer();
  purgeCache();
  stopStatusTicker();
  broadcast();
}

/** Drop all cached audio and reset the LRU counter. */
function purgeCache(): void {
  cache.clear();
  lruCounter = 0;
}

function cancelGeneration(): void {
  if (session && !session.generationDone && isConnected()) {
    send({ action: 'cancel', requestId: session.requestId });
  }
  if (session && session.complete) cacheCurrentSession();
  try { audio.pause(); } catch { /* ignore */ }
}

function resetPlayer(): void {
  session = null;
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
    case 'speaking': s.initSlots(msg.sentences); return;
    case 'chunk': s.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data)); s.drain(); return;
    case 'done': s.markDone(msg.sentenceIndex); s.drain(); return;
    case 'failed': s.markFailed(msg.sentenceIndex); s.drain(); return;
    case 'complete':
      s.generationDone = true;
      s.complete = true;
      s.drain();
      cachePrefetchSession(entry); // caches + records readyAhead for this block
      // This block is done and lives in the cache now; free the slot and keep the
      // read-ahead pipeline going on the next not-yet-ready block.
      prefetches.delete(s.requestId);
      readyAhead.set(item.id, s.seconds);
      fillPrefetch();
      return;
    case 'cancelled':
    case 'error':
      // Preempted or failed before we adopted it — drop and regenerate on advance.
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
    const cached = readyAhead.get(item.id);
    if (cached !== undefined) { aheadSeconds += cached; continue; }
    if (isPrefetchingItem(item.id)) continue; // already generating — don't double-start
    void startPrefetch(item);
  }
}

async function startPrefetch(item: QueueItem): Promise<void> {
  const seq = playSeq;
  startingItems.add(item.id); // synchronous reservation (closed in finally)
  try {
    const settings = await getSettings();
    if (seq !== playSeq) return;
    const voice = settings.voice;
    const key = await cacheKeyFor(voice, item.text);
    // Re-validate after the awaits: still the same playback context, the target still
    // queued, and not already cached or in flight on another session.
    if (seq !== playSeq) return;
    const hit = cacheGet(key);
    if (hit) { readyAhead.set(item.id, hit.bytes / BYTES_PER_SECOND); return; } // already cached → count it
    if (!upcoming.some((u) => u.id === item.id)) return;
    if ([...prefetches.values()].some((p) => p.item.id === item.id)) return;
    try { await ensureConnected(); } catch { return; }
    if (seq !== playSeq || !upcoming.some((u) => u.id === item.id)) return;
    if ([...prefetches.values()].some((p) => p.item.id === item.id)) return;

    const s = new Session(`${item.id}#pf${++reqCounter}`);
    prefetches.set(s.requestId, { session: s, item });
    cacheKeyByRequest.set(s.requestId, key);
    const speakSettings: SpeakSettings = { speed: 1.0 };
    if (voice) speakSettings.voice = voice;
    console.log('[BFR] prefetch', s.requestId, '|', item.text.length, 'chars');
    // preempt:false so it coexists with the playing block; background:true so the
    // server batches it at low pool priority behind what's actually being heard.
    send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings, preempt: false, background: true });
  } finally {
    startingItems.delete(item.id);
    fillPrefetch(); // settle: a cache hit / abort frees the slot for the next block
  }
}

function cachePrefetchSession(entry: { session: Session; item: QueueItem }): void {
  const { session: s, item } = entry;
  if (!s.complete || s.bytes === 0) return;
  const key = cacheKeyByRequest.get(s.requestId);
  if (!key) return;
  cachePut(key, {
    segments: s.segments,
    bytes: s.bytes,
    boundaries: s.boundaries,
    sentences: s.sentences
  });
  readyAhead.set(item.id, s.seconds);
}

/** Abandon one read-ahead session by requestId. */
function dropPrefetchByRequest(requestId: string): void {
  const entry = prefetches.get(requestId);
  if (!entry) return;
  if (!entry.session.generationDone && isConnected()) send({ action: 'cancel', requestId });
  cacheKeyByRequest.delete(requestId);
  prefetches.delete(requestId);
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

/**
 * Promote a read-ahead session to current and play it immediately. Returns false
 * if there's no read-ahead for this item (caller falls back to a fresh startCurrent).
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
  pendingStartFraction = null; // adopted read-ahead blocks always start at the top
  stallSince = null;
  errorMsg = null;
  readyAhead.delete(item.id); // now playing — no longer "ahead"
  current = item;
  session = s;

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
 * @param preempt true for a user-initiated new context (play / play-sequence) —
 *   takes over the audio output and clears stale read-ahead; false when advancing
 *   within the same run (skip / auto-advance on a cache miss), which keeps the
 *   read-ahead sessions already generating further-ahead blocks.
 */
async function startCurrent(preempt: boolean): Promise<void> {
  const item = current;
  if (!item) return;
  const seq = ++playSeq;

  cancelGeneration();
  resetPlayer();
  if (preempt) { dropAllPrefetch(); readyAhead.clear(); } // fresh run — old read-ahead is stale
  readyAhead.delete(item.id); // becoming current — no longer "ahead"
  // A mid-block click asks playback to begin partway in; remember it as a fraction
  // so we can land on a sentence boundary in the (possibly cached) buffer.
  pendingStartFraction = item.startChar && item.text.length ? Math.min(1, item.startChar / item.text.length) : null;
  rate = (await getSettings()).rate;
  if (seq !== playSeq) return;

  preState = 'connecting';
  ensureStatusTicker();
  broadcast();

  const settings = await getSettings();
  if (seq !== playSeq) return;
  const voice = settings.voice;
  const key = await cacheKeyFor(voice, item.text);
  if (seq !== playSeq) return;

  // Cache hit — replay with zero server contact. Leave any in-flight read-ahead
  // running so the buffer keeps growing across this boundary.
  const cached = cacheGet(key);
  if (cached) {
    const s = new Session(`cache-${++reqCounter}`);
    s.sentences = cached.sentences;
    s.segments = cached.segments;
    s.bytes = cached.bytes;
    s.boundaries = cached.boundaries;
    s.appendCursor = cached.sentences.length;
    s.complete = true;
    s.generationDone = true;
    session = s;
    cacheKeyByRequest.set(s.requestId, key);
    startPlayback();
    fillPrefetch(); // cached item is already done — keep read-ahead full
    return;
  }

  const s = new Session(`${item.id}#${++reqCounter}`);
  session = s;
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
  console.log('[BFR] speak', s.requestId, '| engine', engineState, '|', item.text.length, 'chars');
  // preempt only on a fresh run; advancing keeps the concurrent read-ahead sessions.
  // The playing block is foreground (background:false) so it's served before read-ahead.
  send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings, preempt, background: false });
  broadcast();
  fillPrefetch(); // generate upcoming blocks alongside this one (sent after, so it's served first)
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
    // Mid-block click: hold until the targeted sentence has buffered, then begin
    // there. Falls back to the top only if generation finished without resolving
    // it (e.g. an empty/failed segmentation).
    if (pendingStartFraction != null) {
      if (targetStartSeconds() != null) startPlayback();
      else if (session.generationDone) { pendingStartFraction = null; startPlayback(); }
      broadcast();
      return;
    }
    const ready =
      session.generationDone ||                                                    // whole clip ready (short text)
      session.seconds >= START_MIN_SECONDS ||                                       // long single sentence — don't wait forever
      (session.appendCursor >= 2 && session.seconds >= STARTUP_LEAD_SECONDS);       // ~2 sentences buffered → cushion before the first note
    if (ready) startPlayback();
    broadcast();
    return;
  }
  if (audio.ended) resumeIfReady();
  broadcast();
}

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
  if (session.complete) cacheCurrentSession();
  // Advance whether the item completed or failed — a finished item must not wedge
  // the queue. concludeCurrent() leaves the terminal state visible if nothing's next.
  concludeCurrent();
}

function cacheCurrentSession(): void {
  if (!session || !session.complete || session.bytes === 0) return;
  const key = cacheKeyByRequest.get(session.requestId);
  if (!key) return;
  cachePut(key, {
    segments: session.segments,
    bytes: session.bytes,
    boundaries: session.boundaries,
    sentences: session.sentences
  });
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
      if (target > blobBytes / BYTES_PER_SECOND) loadBlob(target);
      else { try { audio.currentTime = target; } catch { /* ignore */ } }
      broadcast();
      return;
    }
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
  }
}

// ─── Engine control ───────────────────────────────────────────────────────────

async function handleEngine(op: 'start' | 'stop'): Promise<void> {
  if (op === 'start') {
    try { await ensureConnected(); } catch (err) {
      connectionError = connectErrorMessage((err as Error).message);
      broadcast();
      return;
    }
    const voice = (await getSettings()).voice;
    send(voice ? { action: 'engine.start', voice } : { action: 'engine.start' });
    broadcast();
  } else {
    if (isConnected()) send({ action: 'engine.stop' });
  }
}

/** Persist/warm a voice without restarting (server warms it live if running). */
async function handleSetVoice(voice: string, rerender?: boolean): Promise<void> {
  try { await ensureConnected(); } catch (err) {
    connectionError = connectErrorMessage((err as Error).message);
    broadcast();
    return;
  }
  send({ action: 'config.set', voice });
  // Re-render the current item in the new voice (the UI confirmed the restart).
  // Synthesis reads the voice fresh from chrome.storage via getSettings(), and the
  // cache key includes the voice, so restarting = a cache miss = regenerate. The
  // already-prefetched upcoming items regenerate too when reached (new key).
  if (rerender && current) {
    startCurrent(true);
  }
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
  const snapshot: QueueSnapshot = {
    connected: isConnected(),
    engineState,
    current,
    upcoming,
    playback: currentStatus(),
    connectionError: connectionError ?? undefined,
    voices,
    currentVoice,
    config: serverConfig
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
    case 'set-voice': void handleSetVoice(msg.voice, msg.rerender); break;
    case 'restart-engine': void handleRestart(msg.cpuWorkers, msg.voice); break;
    case 'queue':
      if (msg.op === 'remove' && msg.id) removeFromQueue(msg.id);
      else if (msg.op === 'clear') clearUpcoming();
      else if (msg.op === 'skip') skipCurrent();
      break;
    case 'sync': void doSync(); break;
  }
});

// Emit an initial snapshot so an already-open popup gets immediate state.
broadcast();

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
  | SyncOffscreenCmd;

// ─── Tunables ─────────────────────────────────────────────────────────────────

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const START_MIN_SECONDS = 8;
// Before the very first play, build a cushion so the slow first couple of sentences
// (engine still warming — those inferences run below real-time) don't underrun the
// instant the playhead catches the live edge. We hold off until at least one sentence
// has assembled AND this many seconds of audio sit queued behind it. generationDone
// and START_MIN_SECONDS below still let short clips / long single sentences start
// without waiting for a cushion that will never come.
const STARTUP_LEAD_SECONDS = 3;
// After the playhead catches the live edge (underrun), wait until this much new
// audio has buffered before reloading. Kept small so an underrun becomes a brief
// boundary reload (landed in the natural gap between sentences) rather than a long
// stall. The buffering grace below hides these quick reloads from the UI.
const RESUME_MIN_SECONDS = 1.5;
// Continuous read-ahead depth. Across a run of blocks, keep the single global server
// session generating upcoming blocks into the cache — in playback order — until this
// many seconds of audio sit ready ahead of the current block. Crossing a block
// boundary then plays from cache instead of stalling while the next block generates.
const PREFETCH_LOOKAHEAD_SECONDS = 45;
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

// queue
let current: QueueItem | null = null;
let upcoming: QueueItem[] = [];

// Prefetch: once the current item finishes generating (server idle), we start
// streaming the next queued item into a second session so the gap at the queue
// boundary disappears. On advance we "adopt" it as the current player.
let prefetch: Session | null = null;
let prefetchItem: QueueItem | null = null;
let prefetchStarting = false; // synchronous guard against double-starting a prefetch
// Seconds of cached audio already ready for each upcoming block (by item id), set as
// prefetch/playback caches each block. Lets maybeStartPrefetch measure how deep the
// read-ahead buffer is — and pick the first not-yet-generated block — synchronously,
// without recomputing cache keys.
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
let playSeq = 0;
let reqCounter = 0;
const cacheKeyByRequest = new Map<string, string>();

// ─── WebSocket ────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let authed = false;
let connectPromise: Promise<void> | null = null;
let engineState: EngineState = 'stopped';
let connectionError: string | null = null; // why we're not connected (for the popup)

function isConnected(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN && authed);
}

async function ensureConnected(): Promise<void> {
  if (isConnected()) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const settings = await getSettings();
    if (!settings.token) throw new Error('NO_TOKEN');
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
  // Events for the prefetch session accumulate quietly and never touch the player
  // or the broadcast — the UI still reflects the currently-playing item.
  if (prefetch && 'requestId' in msg && msg.requestId === prefetch.requestId) {
    handlePrefetchEvent(msg);
    return;
  }
  switch (msg.type) {
    case 'state':
      engineState = msg.state;
      if (!started && session) preState = msg.state === 'running' ? 'buffering' : 'starting-engine';
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
      maybeStartPrefetch(); // server is now idle — get a head start on the next item
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
  startCurrent();
}

/** Replace the queue with an ordered run (block → end of page) and start it. */
function playSequence(items: QueueItem[]): void {
  if (items.length === 0) return;
  cancelGeneration();
  dropPrefetch();
  readyAhead.clear();
  current = items[0];
  upcoming = items.slice(1);
  startCurrent();
}

function enqueue(item: QueueItem): void {
  // No item, or the current one has already finished/failed and is just sitting
  // there as "Done"/error — take over and play now instead of parking behind it.
  if (!current || currentIsDone()) { playNow(item); return; }
  if (item.id === current.id || upcoming.some((i) => i.id === item.id)) { broadcast(); return; }
  upcoming.push(item);
  maybeStartPrefetch(); // current may already be done generating — get ahead on this one
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
  if (prefetchItem && prefetchItem.id === id) dropPrefetch();
  maybeStartPrefetch(); // a new item may now be next in line
  broadcast();
}

/** Clear upcoming but keep the current/playing item. */
function clearUpcoming(): void {
  upcoming = [];
  dropPrefetch();
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
    startCurrent();
  } else {
    current = null;
    dropPrefetch();
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
  startCurrent();
}

/** Stop everything (page ✕): drop current + upcoming, go idle. */
function stopAll(): void {
  cancelGeneration();
  dropPrefetch();
  readyAhead.clear();
  current = null;
  upcoming = [];
  resetPlayer();
  stopStatusTicker();
  broadcast();
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
  stallSince = null;
  errorMsg = null;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
}

// ─── Prefetch the next queued item ────────────────────────────────────────────

/** Accumulate the prefetch session's audio without disturbing current playback. */
function handlePrefetchEvent(msg: ServerEvent): void {
  const s = prefetch;
  if (!s) return;
  switch (msg.type) {
    case 'speaking': s.initSlots(msg.sentences); return;
    case 'chunk': s.addChunk(msg.sentenceIndex, msg.seq, decodeBase64(msg.data)); s.drain(); return;
    case 'done': s.markDone(msg.sentenceIndex); s.drain(); return;
    case 'failed': s.markFailed(msg.sentenceIndex); s.drain(); return;
    case 'complete':
      s.generationDone = true;
      s.complete = true;
      s.drain();
      cachePrefetchSession(); // caches + records readyAhead for this block
      // This block is done and lives in the cache now; free the slot and keep the
      // read-ahead chain going on the next not-yet-ready block.
      prefetch = null;
      prefetchItem = null;
      maybeStartPrefetch();
      return;
    case 'cancelled':
    case 'error':
      // Preempted or failed before we adopted it — drop and regenerate on advance.
      dropPrefetch();
      return;
  }
}

/**
 * If the server is idle (current item done generating), keep generating upcoming
 * blocks into the cache — in playback order — until the read-ahead buffer is
 * PREFETCH_LOOKAHEAD_SECONDS deep. Walks the queue front-first: sums the audio already
 * cached ahead, and prefetches the first block that isn't ready yet. Re-armed after
 * each prefetch completes, so one call kicks off a self-sustaining chain.
 * Best-effort: bails on any race or queue change.
 */
function maybeStartPrefetch(): void {
  if (prefetch || prefetchStarting) return;
  if (!session || !session.generationDone) return; // server still busy with current
  let aheadSeconds = 0;
  let target: QueueItem | null = null;
  for (const item of upcoming) {
    const cached = readyAhead.get(item.id);
    if (cached !== undefined) { aheadSeconds += cached; continue; }
    target = item; // first block with nothing cached yet — fill the gap nearest the playhead
    break;
  }
  if (!target || aheadSeconds >= PREFETCH_LOOKAHEAD_SECONDS) return;
  prefetchStarting = true;
  // Re-evaluate on settle: a cache-hit target records itself and we move to the next;
  // a started prefetch occupies the slot until its 'complete' re-arms the chain.
  void startPrefetch(target).finally(() => { prefetchStarting = false; maybeStartPrefetch(); });
}

async function startPrefetch(item: QueueItem): Promise<void> {
  const seq = playSeq;
  const settings = await getSettings();
  if (seq !== playSeq) return;
  const voice = settings.voice;
  const key = await cacheKeyFor(voice, item.text);
  // Re-validate after the awaits: still the same playback context, still idle, the
  // target still queued, and not already cached or in flight.
  if (seq !== playSeq || prefetch) return;
  const hit = cacheGet(key);
  if (hit) { readyAhead.set(item.id, hit.bytes / BYTES_PER_SECOND); return; } // already cached → count it; chain moves on
  if (!session || !session.generationDone || !upcoming.some((u) => u.id === item.id)) return;
  try { await ensureConnected(); } catch { return; }
  if (seq !== playSeq || prefetch) return;
  if (!session || !session.generationDone || !upcoming.some((u) => u.id === item.id)) return;

  const s = new Session(`${item.id}#pf${++reqCounter}`);
  prefetch = s;
  prefetchItem = item;
  cacheKeyByRequest.set(s.requestId, key);
  const speakSettings: SpeakSettings = { speed: 1.0 };
  if (voice) speakSettings.voice = voice;
  console.log('[BFR] prefetch', s.requestId, '|', item.text.length, 'chars');
  send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings });
}

function cachePrefetchSession(): void {
  if (!prefetch || !prefetch.complete || prefetch.bytes === 0) return;
  const key = cacheKeyByRequest.get(prefetch.requestId);
  if (!key) return;
  cachePut(key, {
    segments: prefetch.segments,
    bytes: prefetch.bytes,
    boundaries: prefetch.boundaries,
    sentences: prefetch.sentences
  });
  if (prefetchItem) readyAhead.set(prefetchItem.id, prefetch.seconds);
}

/** Abandon any prefetch (its item is no longer next, or we're stopping). */
function dropPrefetch(): void {
  if (!prefetch) return;
  if (!prefetch.generationDone && isConnected()) send({ action: 'cancel', requestId: prefetch.requestId });
  cacheKeyByRequest.delete(prefetch.requestId);
  prefetch = null;
  prefetchItem = null;
}

/**
 * Promote the prefetched session to current and play it immediately. Returns false
 * if there's no prefetch for this item (caller falls back to a fresh startCurrent).
 */
function adoptPrefetchFor(item: QueueItem): boolean {
  if (!prefetch || !prefetchItem || prefetchItem.id !== item.id) return false;
  const s = prefetch;
  prefetch = null;
  prefetchItem = null;
  ++playSeq; // invalidate any in-flight startCurrent/startPrefetch

  // Tear down the current player but install the prefetched session in its place.
  try { audio.pause(); } catch { /* ignore */ }
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  started = false;
  userPaused = false;
  blobBytes = 0;
  finishedSent = false;
  lastReportedSentence = -1;
  stallSince = null;
  errorMsg = null;
  readyAhead.delete(item.id); // now playing — no longer "ahead"
  current = item;
  session = s;

  ensureStatusTicker();
  preState = 'buffering';
  afterData(); // starts playback now if enough is buffered, else when more arrives
  maybeStartPrefetch(); // if the adopted item is already complete, prefetch the next
  broadcast();
  return true;
}

// ─── Play the current item ────────────────────────────────────────────────────

async function startCurrent(): Promise<void> {
  const item = current;
  if (!item) return;
  const seq = ++playSeq;

  cancelGeneration();
  resetPlayer();
  readyAhead.delete(item.id); // becoming current — no longer "ahead"
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
  // prefetch running so the buffer keeps growing across this boundary.
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
    maybeStartPrefetch(); // cached item is already done — get ahead on the next one
    return;
  }

  // Cache miss — we need the single server session for THIS block now, so abandon any
  // read-ahead prefetch (it was for a block we haven't reached) and generate.
  dropPrefetch();
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
  send({ action: 'speak', requestId: s.requestId, text: item.text, settings: speakSettings });
  broadcast();
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
    const ready =
      session.generationDone ||                                                    // whole clip ready (short text)
      session.seconds >= START_MIN_SECONDS ||                                       // long single sentence — don't wait forever
      (session.appendCursor >= 1 && session.seconds >= STARTUP_LEAD_SECONDS);       // first sentence done + warmup cushion
    if (ready) startPlayback();
    broadcast();
    return;
  }
  if (audio.ended) resumeIfReady();
  broadcast();
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
  loadBlob(0);
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
    connectionError: connectionError ?? undefined
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

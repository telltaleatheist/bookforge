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
  TransportCmd,
  EngineOffscreenCmd,
  QueueOffscreenCmd,
  SyncOffscreenCmd,
  SNAPSHOT_KEY,
  loadSettings
} from './messages';

type OffscreenMessage =
  | PlayItemCmd
  | TransportCmd
  | EngineOffscreenCmd
  | QueueOffscreenCmd
  | SyncOffscreenCmd;

// ─── Tunables ─────────────────────────────────────────────────────────────────

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const START_MIN_SECONDS = 8;
const SEEK_STEP_GRACE = 0.05;
const STATUS_INTERVAL_MS = 300;

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

// player (for the current item)
let session: Session | null = null;
let started = false;
let userPaused = false;
let blobBytes = 0;
let blobUrl: string | null = null;
let rate = 1;
let errorMsg: string | null = null;
let preState: 'connecting' | 'starting-engine' | 'buffering' = 'connecting';
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

function isConnected(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN && authed);
}

async function ensureConnected(): Promise<void> {
  if (isConnected()) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const settings = await loadSettings();
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
      return;
    case 'cancelled':
      if (!session || msg.requestId !== session.requestId) return;
      finishGeneration(false, 'Playback was taken over by another BookForge client');
      afterData();
      return;
    case 'error':
      if (session && msg.requestId !== undefined && msg.requestId !== session.requestId) return;
      errorMsg = msg.message || 'TTS error';
      if (session) finishGeneration(false);
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

// ─── Queue operations ─────────────────────────────────────────────────────────

function playNow(item: QueueItem): void {
  // Move to the top of the queue and play immediately; keep upcoming intact.
  upcoming = upcoming.filter((i) => i.id !== item.id);
  current = item;
  startCurrent();
}

function enqueue(item: QueueItem): void {
  if (!current) { current = item; startCurrent(); return; }
  if (item.id === current.id || upcoming.some((i) => i.id === item.id)) { broadcast(); return; }
  upcoming.push(item);
  broadcast();
}

function removeFromQueue(id: string): void {
  if (current && current.id === id) { skipCurrent(); return; }
  upcoming = upcoming.filter((i) => i.id !== id);
  broadcast();
}

/** Clear upcoming but keep the current/playing item. */
function clearUpcoming(): void {
  upcoming = [];
  broadcast();
}

/** Advance to the next item, or go idle if none. */
function skipCurrent(): void {
  cancelGeneration();
  const next = upcoming.shift();
  if (next) { current = next; startCurrent(); }
  else { current = null; resetPlayer(); stopStatusTicker(); broadcast(); }
}

/** Current item finished naturally; advance if anything is queued. */
function onItemFinished(): void {
  const next = upcoming.shift();
  if (next) { current = next; startCurrent(); }
  else broadcast(); // leave the player in its 'ended' state; bar shows "Done"
}

/** Stop everything (page ✕): drop current + upcoming, go idle. */
function stopAll(): void {
  cancelGeneration();
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
  errorMsg = null;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
}

// ─── Play the current item ────────────────────────────────────────────────────

async function startCurrent(): Promise<void> {
  const item = current;
  if (!item) return;
  const seq = ++playSeq;

  cancelGeneration();
  resetPlayer();
  rate = (await loadSettings()).rate;
  if (seq !== playSeq) return;

  preState = 'connecting';
  ensureStatusTicker();
  broadcast();

  const settings = await loadSettings();
  if (seq !== playSeq) return;
  const voice = settings.voice;
  const key = await cacheKeyFor(voice, item.text);
  if (seq !== playSeq) return;

  // Cache hit — replay with zero server contact.
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
    if (session.appendCursor >= 1 || session.generationDone || session.seconds >= START_MIN_SECONDS) startPlayback();
    broadcast();
    return;
  }
  if (audio.ended) {
    if (session.bytes > blobBytes) loadBlob(blobBytes / BYTES_PER_SECOND);
    else maybeFinalize();
  }
  broadcast();
}

function startPlayback(): void {
  if (!session) return;
  started = true;
  loadBlob(0);
}

function loadBlob(atSeconds: number): void {
  if (!session) return;
  const blob = buildWav(session.segments, session.bytes);
  blobBytes = session.bytes;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  const onLoaded = () => {
    try {
      audio.currentTime = Math.min(atSeconds, Math.max(0, session!.seconds - SEEK_STEP_GRACE));
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
  if (session.complete) {
    cacheCurrentSession();
    onItemFinished();
    return;
  }
  broadcast();
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
      else if (audio.ended && session.generationDone && session.bytes <= blobBytes) { userPaused = false; loadBlob(0); }
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
      errorMsg = connectErrorMessage((err as Error).message);
      broadcast();
      return;
    }
    const voice = (await loadSettings()).voice;
    send(voice ? { action: 'engine.start', voice } : { action: 'engine.start' });
    broadcast();
  } else {
    if (isConnected()) send({ action: 'engine.stop' });
  }
}

async function doSync(): Promise<void> {
  // Refresh engine state for the popup; don't start anything.
  try { await ensureConnected(); } catch { /* offscreen will report disconnected */ }
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

function computeState(): PlaybackStatus['state'] {
  if (errorMsg) return 'error';
  if (!current || !session) return 'idle';
  if (!started) return preState === 'buffering' ? 'buffering' : preState;
  if (audio.ended) {
    if (session.generationDone && session.bytes <= blobBytes) return 'ended';
    return 'buffering';
  }
  if (audio.paused) return userPaused ? 'paused' : 'buffering';
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
    playback: currentStatus()
  };
  // Mirror for the popup (which reads storage.session + watches onChanged).
  chrome.storage.session.set({ [SNAPSHOT_KEY]: snapshot }).catch(() => { /* ignore */ });
  // Relay to background → content (and anyone else listening).
  chrome.runtime.sendMessage({ target: 'background', cmd: 'snapshot', snapshot }).catch(() => { /* asleep */ });
}

// ─── Audio element events ─────────────────────────────────────────────────────

audio.addEventListener('ended', () => {
  if (!session) return;
  if (session.bytes > blobBytes) loadBlob(blobBytes / BYTES_PER_SECOND);
  else maybeFinalize();
  broadcast();
});

// ─── Message intake ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!raw || (raw as { target?: string }).target !== 'offscreen') return;
  const msg = raw as OffscreenMessage;
  switch (msg.cmd) {
    case 'play': playNow(msg.item); break;
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

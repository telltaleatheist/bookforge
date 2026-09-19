/**
 * Reader Audio Store — server-side PCM buffer for the Bookshelf Reader's
 * "Stream / follow-along" read-aloud, so its audio can be served over HTTP and
 * therefore played by the native iOS AVPlayer (which cannot load the WebView-only
 * `blob:` URLs the client used to build).
 *
 * The ReaderStreamBridge already drives generation and streams PCM16 chunks to the
 * client over the WebSocket. This store TEES those same chunks into an in-memory
 * buffer per block (paragraph). The HTTP route `GET /api/reader/audio` (bookshelf-
 * server.ts) then serves the assembled WAV once the block has finished generating.
 *
 * ── Keying + authorization ───────────────────────────────────────────────────
 * Blocks are keyed by a COMPOUND `${readerId}:${requestId}` (see {@link makeKey}),
 * so (a) two readers can't collide on the same client-supplied requestId and (b) a
 * reader can only ever fetch its OWN blocks: the HTTP route builds the key from the
 * AUTHENTICATED caller's readerId, so requesting another reader's requestId just
 * misses (404). The requestId itself is also made globally unique client-side (a
 * per-session prefix), but the readerId compound is the actual authorization gate.
 *
 * Why buffer-then-serve (not progressive): AVPlayer needs a known Content-Length up
 * front to play + seek a WAV; a live-generating WAV has no known length until the
 * block completes. So a GET waits for the block to SETTLE (complete or cancelled/
 * failed) and then serves the whole thing with Range support. The client only
 * issues the GET after it has seen the block's `complete` over the WS.
 *
 * Memory: bounded by a total-bytes LRU cap. The block currently being served is
 * pinned (never evicted) so a later Range GET / reacquire can't 404 under heavy
 * read-ahead; only non-active settled blocks are evicted.
 */

import { pcm16WavHeader, WAV_HEADER_BYTES } from './pcm16-wav';

// PCM16 mono @ 24 kHz — the reader engine's output (mirrors reader-protocol.ts).
const SAMPLE_RATE = 24000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
// Total resident audio cap across all blocks. Oldest settled blocks are evicted
// first; an evicted block simply re-generates if the client asks for it again.
const CAP_BYTES = 256 * 1024 * 1024;

interface Block {
  segments: Buffer[];
  bytes: number;
  sampleRate: number;
  settled: boolean;
  ok: boolean;
  lastUsed: number;
  waiters: Array<() => void>;
}

const blocks = new Map<string, Block>();
let lru = 0;
// The block currently being SERVED (the playing one, and the last one AVPlayer
// GET'd). Pinned against eviction so a follow-up Range GET / reacquire never 404s.
let activeKey: string | null = null;

/** Compound store key: authorizes by readerId and de-collides across readers. */
export function makeKey(readerId: string, requestId: string): string {
  return `${readerId}:${requestId}`;
}

/** Begin (or reset) buffering a block. Called when the bridge starts a speak
 *  (foreground or read-ahead) so every generated block is captured. */
export function begin(key: string): void {
  const existing = blocks.get(key);
  if (existing) { existing.waiters.forEach((w) => w()); }
  blocks.set(key, {
    segments: [], bytes: 0, sampleRate: SAMPLE_RATE,
    settled: false, ok: false, lastUsed: ++lru, waiters: [],
  });
}

/** Append a decoded PCM16 chunk. No-op if the block was evicted/never began. */
export function feed(key: string, pcm: Buffer, sampleRate: number): void {
  const b = blocks.get(key);
  if (!b || b.settled) return;
  if (sampleRate > 0) b.sampleRate = sampleRate;
  b.segments.push(pcm);
  b.bytes += pcm.length;
}

/**
 * Insert the silence one finished ROW states after itself, at the block's own
 * sample rate. Called from the bridge's sink on that row's `done`, with the
 * number narrator classified for it (`gapSec`).
 *
 * WHY THE ROW AND NOT THE BLOCK. This used to append a flat 0.5 s once, at
 * `settle`, to give paragraphs a pause — the sentences inside a block were
 * separated by the 0.3 s narrator baked into its own audio. Neither number was
 * the book's: `gaps.json` asks the assembler for 0.6 s, or for the voice's
 * measured inject, so the same paragraph read aloud in the app and rendered into
 * an audiobook paced differently. narrator's audio is bare speech now and states
 * what belongs after each row, so every join here — inside a block and at its
 * end — is the book's own number (Owen, 2026-09-18).
 *
 * A non-number is a caller that skipped the scheduler's own refusal, so it is
 * thrown rather than defaulted: silence invented here is heard on every sentence
 * boundary of the read.
 */
export function gap(key: string, seconds: number): void {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `reader-audio-store was asked to insert a gap of ${String(seconds)} seconds. `
      + 'The gap after a row is narrator\'s own classification of it, carried on the '
      + 'row\'s `done`; there is no default to fall back to.',
    );
  }
  const b = blocks.get(key);
  if (!b || b.settled || seconds === 0) return;
  const n = Math.floor(seconds * (b.sampleRate * 2));
  const even = n - (n % 2);          // PCM16 = 2 bytes/sample, keep alignment
  b.segments.push(Buffer.alloc(even));
  b.bytes += even;
}

/** Mark a block done. `ok` = the whole block generated; !ok = cancelled/
 *  preempted/failed (serve whatever partial audio we captured). Nothing is
 *  appended here: the pause after the block's last row is that row's own gap,
 *  inserted by {@link gap} when it finished. */
export function settle(key: string, ok: boolean): void {
  const b = blocks.get(key);
  if (!b || b.settled) return;
  b.settled = true;
  b.ok = ok;
  b.lastUsed = ++lru;
  b.waiters.forEach((w) => w());
  b.waiters = [];
  evictToCap();
}

/** Forget a block (client disconnected / no longer needed), freeing its memory. */
export function drop(key: string): void {
  const b = blocks.get(key);
  if (!b) return;
  b.waiters.forEach((w) => w()); // release any GET blocked on it → 404
  blocks.delete(key);
  if (activeKey === key) activeKey = null;
}

/** Resolve once the block has settled (or is already settled), or after `timeoutMs`.
 *  Returns true if a playable, settled block exists; false if missing/timed out. */
export function waitSettled(key: string, timeoutMs: number): Promise<boolean> {
  const b = blocks.get(key);
  if (!b) return Promise.resolve(false);
  if (b.settled) { b.lastUsed = ++lru; return Promise.resolve(true); }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const cur = blocks.get(key);
      resolve(!!cur && cur.settled);
    };
    const timer = setTimeout(finish, timeoutMs);
    b.waiters.push(finish);
  });
}

/** Assemble the full WAV (44-byte header + PCM) for a settled block, or null when
 *  there's nothing to serve. Marks the block ACTIVE (pinned) so serving it can't be
 *  raced by eviction, and touches lastUsed. */
export function wav(key: string): Buffer | null {
  const b = blocks.get(key);
  if (!b || b.bytes === 0) return null;
  b.lastUsed = ++lru;
  activeKey = key;
  return buildWav(b.segments, b.bytes, b.sampleRate);
}

function buildWav(segments: Buffer[], dataBytes: number, sampleRate: number): Buffer {
  // The header this used to build itself now has ONE owner (./pcm16-wav.ts):
  // the whole-book render turns the same engine's PCM16 into the same files,
  // and having only one of the two writers know the shape is why its sentences
  // shipped with no header at all. The segments are concatenated here rather
  // than joined first so the block's buffers are copied once.
  return Buffer.concat([pcm16WavHeader(dataBytes, sampleRate), ...segments], WAV_HEADER_BYTES + dataBytes);
}

/** Evict oldest SETTLED blocks until under the byte cap. Never drops a block that's
 *  still generating, nor the ACTIVE (currently-served) one. */
function evictToCap(): void {
  let total = 0;
  for (const b of blocks.values()) total += b.bytes;
  while (total > CAP_BYTES) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, b] of blocks) {
      if (k === activeKey || !b.settled) continue; // pin active + still-generating
      if (b.lastUsed < oldest) { oldest = b.lastUsed; oldestKey = k; }
    }
    if (!oldestKey) break; // only pinned/unsettled blocks left — leave them
    total -= blocks.get(oldestKey)!.bytes;
    blocks.delete(oldestKey);
  }
}

export const readerAudioStore = {
  makeKey, begin, feed, gap, settle, drop, waitSettled, wav, BYTES_PER_SECOND,
};

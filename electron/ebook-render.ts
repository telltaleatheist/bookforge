/**
 * Ebook page rendering for the Bookshelf web reader.
 *
 * PDFs are rasterized to PNG via mupdf and streamed to the phone browser, which
 * keeps the client light. EPUBs are NOT handled here — the web reader renders
 * those reflowably with epub.js on the client.
 *
 * ── This is a PROXY, and that is the whole point ─────────────────────────────
 *
 * The mupdf work lives in `ebook-render-worker.ts`, one dedicated worker thread.
 * It used to run right here, in the Electron main process, and every reader
 * request — `readFileSync` of the whole PDF, `openDocument`, `toPixmap`,
 * `asPNG` — is synchronous WASM that blocks whatever thread it is on. So
 * opening a book on the phone froze the DESKTOP window for several seconds
 * while it rendered (Owen, 2026-08-21): the main thread is also the thread that
 * answers the renderer's IPC.
 *
 * It stays DECOUPLED from the desktop PDF editor's worker (pdf-worker-proxy):
 * its own worker, its own mupdf instance, its own lock, so a reader request can
 * never disturb (or be disturbed by) an active editing session. mupdf's WASM
 * state is single-threaded and corrupts under concurrent calls, which is why
 * the isolation matters more than the extra thread costs.
 *
 * The worker is spawned lazily and terminated after five minutes idle, so a
 * library nobody is reading from the phone holds no WASM heap.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── The worker ───────────────────────────────────────────────────────────────

const IDLE_TIMEOUT = 5 * 60 * 1000;

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

let worker: Worker | null = null;
const pending = new Map<string, PendingCall>();
let requestCounter = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function workerPath(): string {
  return path.join(__dirname, 'ebook-render-worker.js');
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || !worker) return;
    console.log('[ebook-render] Worker terminated (idle)');
    const dying = worker;
    worker = null;
    // The open document and its WASM heap go with it; the next call reopens.
    void dying.terminate();
  }, IDLE_TIMEOUT);
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(workerPath());
  console.log('[ebook-render] Worker started');

  w.on('message', (msg: any) => {
    const call = pending.get(msg?.requestId);
    if (!call) return;
    pending.delete(msg.requestId);
    if (msg.type === 'result') call.resolve(msg.result);
    else if (msg.type === 'error') call.reject(new Error(msg.error));
  });

  // A mupdf WASM out-of-memory abort calls process.exit and takes the whole
  // worker with it — no JS error to catch. Every in-flight call must be
  // REJECTED rather than left hanging, or the reader request never answers and
  // the phone spins forever.
  w.on('error', (err) => failAll(w, err));
  w.on('exit', (code) => {
    if (worker === w) worker = null;
    failAll(w, new Error(`Ebook render worker exited unexpectedly (code ${code})`));
  });

  worker = w;
  return w;
}

function failAll(dead: Worker, err: Error): void {
  if (worker === dead) worker = null;
  for (const [id, call] of pending) {
    pending.delete(id);
    call.reject(err);
  }
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  const w = ensureWorker();
  const requestId = `er-${++requestCounter}`;
  resetIdleTimer();
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    w.postMessage({ type: 'call', requestId, method, args });
  });
}

/** Shut the worker down — called from the app's quit path. */
export async function shutdownEbookRender(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const dying = worker;
  worker = null;
  if (dying) await dying.terminate();
}

// ── Document identity ────────────────────────────────────────────────────────

/**
 * A document's cache key: path plus mtime, so an edited file is never served
 * from a stale open handle. The stat is ASYNC — a sync one here would put a
 * (small, but real) filesystem wait back on the thread this whole file exists
 * to keep free, and on a network library that wait is not small.
 */
async function docKey(absPath: string): Promise<string> {
  const st = await fs.stat(absPath);
  return `${absPath}::${st.mtimeMs}`;
}

// ── PNG LRU (keyed by doc key + page + scale) ────────────────────────────────────
//
// On THIS side of the thread boundary: a hit must not cost a round trip, and
// scrolling back over already-rendered pages is the common case.

const PNG_CACHE_MAX = 24;
const pngCache = new Map<string, Buffer>();

function pngCacheGet(key: string): Buffer | null {
  const hit = pngCache.get(key);
  if (!hit) return null;
  pngCache.delete(key); // refresh recency
  pngCache.set(key, hit);
  return hit;
}

function pngCacheSet(key: string, buf: Buffer): void {
  pngCache.set(key, buf);
  while (pngCache.size > PNG_CACHE_MAX) {
    const oldest = pngCache.keys().next().value;
    if (oldest === undefined) break;
    pngCache.delete(oldest);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface PdfOutlineItem {
  title: string;
  page: number; // 0-indexed target page
  depth: number;
}

export interface PdfInfo {
  pages: number;
  /** width / height of the first page, so the client can size page placeholders. */
  aspect: number;
  /** Flattened document outline (chapters), empty when the PDF has none. */
  outline: PdfOutlineItem[];
}

export async function getPdfInfo(absPath: string): Promise<PdfInfo> {
  const key = await docKey(absPath);
  return call<PdfInfo>('info', [absPath, key]);
}

/**
 * Render one page (0-indexed) to a PNG buffer at the given scale (1 = 72 DPI).
 * Scale is clamped to a sane range to bound memory/CPU per request.
 */
export async function renderPdfPage(absPath: string, pageNum: number, scale: number): Promise<Buffer> {
  const safeScale = Math.min(Math.max(scale, 0.5), 4);
  const key = await docKey(absPath);
  const cacheKey = `${key}::${pageNum}::${safeScale}`;
  const cached = pngCacheGet(cacheKey);
  if (cached) return cached;

  const png = await call<Uint8Array>('page', [absPath, key, pageNum, safeScale]);
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  pngCacheSet(cacheKey, buf);
  return buf;
}

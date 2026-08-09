/**
 * PDF Worker Proxy
 *
 * Thin main-thread proxy that spawns pdf-worker.js in Worker threads and
 * forwards IPC calls.  Correlates request ↔ response via a requestId map
 * and routes progress messages to the correct BrowserWindow.
 *
 * Two kinds of workers:
 *  - The main worker holds analyzer state (analysis doc, spans, export) and
 *    handles everything except batch page rendering.
 *  - The render pool: each worker hosts its own mupdf WASM instance, so a
 *    renderPages batch split across the pool renders pages in parallel
 *    instead of serializing behind a single WASM lock.
 *
 * All workers are spawned lazily on first use and auto-terminate after
 * 5 minutes of idle time to free WASM memory.
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { app, type WebContents } from 'electron';
import { getMainLogger } from './rolling-logger.js';
import type { TextLayerReport } from './pdf-analyzer.js';

/**
 * Thrown when a worker process exits mid-call (e.g. a mupdf WASM out-of-memory
 * abort, which calls process.exit and kills the whole worker — JS try/catch
 * can't intercept it). Carries the exit code and is used by call() to decide
 * whether to respawn a fresh worker and retry once.
 */
class WorkerCrashError extends Error {
  readonly workerCrashed = true;
  constructor(public readonly exitCode: number | null) {
    super(`PDF worker exited unexpectedly (code ${exitCode})`);
    this.name = 'WorkerCrashError';
  }
}

/**
 * Methods that are fully self-contained — they (re)open the document from a
 * path or take all their inputs as arguments, so they can be safely re-run on a
 * brand-new worker with a fresh WASM heap. Stateful methods that depend on a
 * prior call's in-worker state (analyzeText, exportText, getSpans, …) are NOT
 * here: retrying them on a fresh worker would just fail differently.
 */
const RETRYABLE_METHODS = new Set<string>([
  'analyze',
  'analyzeQuick',
  // Self-contained: it re-opens the EPUB from the path it is given and keeps
  // nothing from a prior call.
  'layOutEpubTheLegacyWay',
  'renderPage',
  'renderBlankPage',
  'renderAllPagesToFiles',
  'renderAllPagesWithPreviews',
  'renderPages',
  'renderPagesToPgm',
]);

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  sender?: WebContents;
  worker: Worker;
}

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const RENDER_POOL_SIZE = Math.max(2, Math.min(4, os.cpus().length - 2));

let worker: Worker | null = null;
let renderPool: Worker[] = [];
let pending = new Map<string, PendingCall>();
let requestCounter = 0;
let defaultSender: WebContents | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Workers we terminated on purpose (idle timeout, app shutdown).
 *
 * `worker.terminate()` makes the 'exit' event report code 1 — verified, and the same
 * code a mupdf WASM out-of-memory abort produces. Without this set, every routine
 * five-minute idle teardown logged RENDER_POOL_SIZE+1 errors reading "exited
 * unexpectedly", which is what the error log is full of. That defeats the one thing
 * that logging exists for: a real OOM crash looked exactly like a planned shutdown.
 *
 * Membership is the only thing that distinguishes them, so it is recorded at the call
 * to terminate() and consumed by the exit handler.
 */
const intentionallyTerminated = new WeakSet<Worker>();

function workerPath(): string {
  return path.join(__dirname, 'pdf-worker.js');
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return;
    if (worker) {
      console.log('[pdf-worker-proxy] Worker terminated (idle)');
      intentionallyTerminated.add(worker);
      worker.terminate();
      worker = null;
    }
    if (renderPool.length > 0) {
      console.log(`[pdf-worker-proxy] Render pool terminated (idle, ${renderPool.length} workers)`);
      for (const w of renderPool) {
        intentionallyTerminated.add(w);
        w.terminate();
      }
      renderPool = [];
    }
  }, IDLE_TIMEOUT);
}

function spawn(label: string, onExit: (w: Worker) => void): Worker {
  // Worker threads can't reach electron's `app`, so hand them the userData path
  // they need (managed-bins resolves binary locations from it). Without this the
  // worker crashes at startup in packaged builds — 'electron' isn't resolvable
  // in a worker — and every PDF/EPUB fails with "worker exited (code 1)".
  const w = new Worker(workerPath(), { workerData: { userDataPath: app.getPath('userData') } });
  console.log(`[pdf-worker-proxy] ${label} started`);

  w.on('message', (msg: any) => {
    // ── The one request that travels the OTHER way ────────────────────────
    //
    // A worker thread cannot reach Electron's `app` (see the spawn call above),
    // and quire paginates an EPUB in a real BrowserWindow. So the analyzer,
    // which lives in the worker, asks the main thread to lay the book out and
    // waits for the map. Everything else about the analysis stays in the worker.
    if (msg.type === 'quire-request') {
      const { paginateInThisProcess } = require('./quire-service.js') as
        typeof import('./quire-service');
      paginateInThisProcess(msg.stampedPath, msg.geometry)
        .then((result) => w.postMessage({ type: 'quire-response', quireId: msg.quireId, result }))
        .catch((err: unknown) => w.postMessage({
          type: 'quire-response',
          quireId: msg.quireId,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        }));
      return;
    }

    if (msg.type === 'progress') {
      // Forward progress to whichever sender is associated with the *latest*
      // pending call, or to all pending senders, or to the default sender.
      // Progress messages are fire-and-forget — they don't carry a requestId.
      const { channel, data } = msg;
      const sent = new Set<number>(); // track by WebContents id to avoid dups
      // Send to all currently-pending senders
      for (const p of pending.values()) {
        const target = p.sender;
        if (target && !target.isDestroyed() && !sent.has(target.id)) {
          try {
            target.send(channel, data);
            sent.add(target.id);
          } catch { /* window closed */ }
        }
      }
      // Fallback: if no pending sender received it, try defaultSender
      if (sent.size === 0 && defaultSender && !defaultSender.isDestroyed()) {
        try { defaultSender.send(channel, data); } catch { /* ignore */ }
      }
      return;
    }

    const { requestId, type } = msg;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);

    if (type === 'result') {
      entry.resolve(msg.result);
    } else if (type === 'error') {
      entry.reject(new Error(msg.error));
    }

    // Start/reset idle timer when a call completes and nothing is pending
    if (pending.size === 0) {
      resetIdleTimer();
    }
  });

  w.on('error', (err) => {
    console.error(`[pdf-worker-proxy] ${label} error:`, err.message);
    try { getMainLogger().error(`[pdf-worker-proxy] ${label} error`, { message: err.message, stack: err.stack }); } catch { /* logger unavailable */ }
  });

  w.on('exit', (code) => {
    clearIdleTimer();
    if (code !== 0 && !intentionallyTerminated.has(w)) {
      // An UNEXPECTED non-zero exit is almost always a mupdf WASM abort (e.g.
      // out-of-memory "cannot enlarge memory arrays"), which kills the worker via
      // process.exit and can't be caught inside the worker. Surface it to the rolling
      // logger so it's actually diagnosable — console.error alone never reaches the
      // log file in packaged builds.
      //
      // The WeakSet check is load-bearing: terminate() also exits with code 1, so
      // without it this fires on every idle teardown and buries the real crashes.
      const pendingMethods = [...pending.values()].filter(p => p.worker === w).length;
      console.error(`[pdf-worker-proxy] ${label} exited with code ${code}`);
      try {
        getMainLogger().error(`[pdf-worker-proxy] ${label} exited unexpectedly`, {
          code,
          pendingCalls: pendingMethods,
        });
      } catch { /* logger unavailable */ }
    }
    // Reject pending calls belonging to this worker only
    for (const [id, entry] of pending) {
      if (entry.worker === w) {
        entry.reject(new WorkerCrashError(code));
        pending.delete(id);
      }
    }
    onExit(w);
  });

  return w;
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = spawn('Worker', () => { worker = null; });
  }
  return worker;
}

function ensureRenderPool(): Worker[] {
  while (renderPool.length < RENDER_POOL_SIZE) {
    const label = `Render worker ${renderPool.length + 1}/${RENDER_POOL_SIZE}`;
    const w = spawn(label, (exited) => {
      renderPool = renderPool.filter(x => x !== exited);
    });
    renderPool.push(w);
  }
  return renderPool;
}

function callOn(w: Worker, method: string, args: any[], sender?: WebContents): Promise<any> {
  clearIdleTimer();
  const requestId = `r${++requestCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, sender, worker: w });
    w.postMessage({ type: 'call', requestId, method, args });
  });
}

/**
 * Set the default WebContents for progress messages
 * when no specific sender is available.
 */
export function setDefaultSender(sender: WebContents): void {
  defaultSender = sender;
}

/**
 * Call a method on the main PDF worker.
 * @param method  Method name matching the dispatch table in pdf-worker.ts
 * @param args    Positional arguments (will be serialized via structured clone)
 * @param sender  Optional WebContents to receive progress events
 */
export async function call(method: string, args: any[], sender?: WebContents): Promise<any> {
  try {
    return await callOn(ensureWorker(), method, args, sender);
  } catch (err) {
    // If the worker crashed (WASM abort, almost always out-of-memory) during a
    // self-contained call, respawn a fresh worker — and therefore a fresh WASM
    // heap — and retry exactly once. A long-lived worker's WASM heap only ever
    // grows, so a fresh one frequently has the headroom the crashed one lacked.
    if (err instanceof WorkerCrashError && RETRYABLE_METHODS.has(method)) {
      console.warn(`[pdf-worker-proxy] '${method}' crashed the worker (code ${err.exitCode}); retrying on a fresh worker`);
      try {
        getMainLogger().warn(`[pdf-worker-proxy] retrying '${method}' on a fresh worker after crash`, {
          method,
          exitCode: err.exitCode,
        });
      } catch { /* logger unavailable */ }
      // The exit handler already nulled `worker`, so ensureWorker() spawns fresh.
      return await callOn(ensureWorker(), method, args, sender);
    }
    throw err;
  }
}

/**
 * Render a batch of pages in parallel across the render pool.
 * Splits the page list into contiguous chunks, one per pool worker, and
 * merges the pageNum → filePath results. A failed chunk only loses its own
 * pages (they're absent from the result; the renderer retries absent pages).
 */
export async function callRenderPages(
  pdfPath: string,
  pageNumbers: number[],
  quality: 'preview' | 'full',
  sender?: WebContents
): Promise<Record<number, string>> {
  const pool = ensureRenderPool();
  const chunkSize = Math.ceil(pageNumbers.length / pool.length);
  const calls: Promise<Record<number, string>>[] = [];
  for (let i = 0; i < pool.length; i++) {
    const chunk = pageNumbers.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) break;
    calls.push(callOn(pool[i], 'renderPages', [pdfPath, chunk, quality], sender));
  }

  const settled = await Promise.allSettled(calls);
  const merged: Record<number, string> = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      Object.assign(merged, s.value);
    } else {
      console.error('[pdf-worker-proxy] Render pool chunk failed:', s.reason?.message ?? s.reason);
    }
  }
  return merged;
}

/** A PDF's page count, off the main thread like every other mupdf call. */
export async function callCountPages(pdfPath: string): Promise<number> {
  return call('countPages', [pdfPath]);
}

/** Does this PDF carry text of its own? Sampled — see pdf-analyzer. */
export async function callMeasureTextLayer(
  pdfPath: string,
  maxSamples?: number
): Promise<TextLayerReport> {
  return call('measureTextLayer', [pdfPath, maxSamples]);
}

/**
 * Render pages to grayscale PGM across the render pool, for a foundry run.
 *
 * Parallel for the same reason `callRenderPages` is — one mupdf WASM instance
 * per worker, so a book's pages render at pool width instead of serially — but
 * with one difference that matters: a chunk that FAILS is fatal here. The
 * display cache can lose a page and re-render it when you scroll to it; a
 * foundry run cannot, because the pages are handed over as an ordered set and
 * every artifact downstream is keyed to positions in it. A missing page there
 * does not read as a missing page, it reads as every later page's text sitting
 * under the wrong labels.
 */
export async function callRenderPagesToPgm(
  pdfPath: string,
  pageNumbers: number[],
  outDir: string,
  dpi: number,
  onProgress?: (done: number, total: number) => void
): Promise<Array<{ page: number; file: string; width: number; height: number }>> {
  const pool = ensureRenderPool();
  const chunkSize = Math.ceil(pageNumbers.length / pool.length);
  const calls: Promise<Array<{ page: number; file: string; width: number; height: number }>>[] = [];
  let done = 0;
  for (let i = 0; i < pool.length; i++) {
    const chunk = pageNumbers.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) break;
    calls.push(
      callOn(pool[i], 'renderPagesToPgm', [pdfPath, chunk, outDir, dpi]).then((result) => {
        done += chunk.length;
        onProgress?.(done, pageNumbers.length);
        return result;
      })
    );
  }
  const results = await Promise.all(calls);
  return results.flat().sort((a, b) => a.page - b.page);
}

/**
 * Call a method on every *existing* worker (main + render pool) without
 * spawning new ones. Used for closeRenderDoc/close so each worker releases
 * its cached document handle.
 */
export async function broadcast(method: string, args: any[]): Promise<void> {
  const targets: Worker[] = [...renderPool];
  if (worker) targets.push(worker);
  await Promise.allSettled(targets.map(w => callOn(w, method, args)));
}

/**
 * Terminate all workers. Call during app shutdown.
 */
export async function terminate(): Promise<void> {
  clearIdleTimer();
  const targets: Worker[] = [...renderPool];
  if (worker) targets.push(worker);
  worker = null;
  renderPool = [];
  pending.clear();
  if (targets.length > 0) {
    // Same reason as the idle path: terminate() exits with code 1, and an app
    // shutdown must not write a crash report on the way out.
    for (const w of targets) intentionallyTerminated.add(w);
    await Promise.all(targets.map(w => w.terminate()));
    console.log(`[pdf-worker-proxy] ${targets.length} worker(s) terminated`);
  }
}

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
import type { WebContents } from 'electron';

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
      worker.terminate();
      worker = null;
    }
    if (renderPool.length > 0) {
      console.log(`[pdf-worker-proxy] Render pool terminated (idle, ${renderPool.length} workers)`);
      for (const w of renderPool) {
        w.terminate();
      }
      renderPool = [];
    }
  }, IDLE_TIMEOUT);
}

function spawn(label: string, onExit: (w: Worker) => void): Worker {
  const w = new Worker(workerPath());
  console.log(`[pdf-worker-proxy] ${label} started`);

  w.on('message', (msg: any) => {
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
  });

  w.on('exit', (code) => {
    clearIdleTimer();
    if (code !== 0) {
      console.error(`[pdf-worker-proxy] ${label} exited with code ${code}`);
    }
    // Reject pending calls belonging to this worker only
    for (const [id, entry] of pending) {
      if (entry.worker === w) {
        entry.reject(new Error(`PDF worker exited unexpectedly (code ${code})`));
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
export function call(method: string, args: any[], sender?: WebContents): Promise<any> {
  return callOn(ensureWorker(), method, args, sender);
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
    await Promise.all(targets.map(w => w.terminate()));
    console.log(`[pdf-worker-proxy] ${targets.length} worker(s) terminated`);
  }
}

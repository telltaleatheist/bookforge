/**
 * PDF Worker Proxy
 *
 * Thin main-thread proxy that spawns pdf-worker.js in a Worker thread and
 * forwards IPC calls.  Correlates request ↔ response via a requestId map
 * and routes progress messages to the correct BrowserWindow.
 *
 * The worker is spawned lazily on first call() and auto-terminates after
 * 5 minutes of idle time to free ~200MB of memory.
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
import type { WebContents } from 'electron';

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  sender?: WebContents;
}

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

let worker: Worker | null = null;
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
    if (worker && pending.size === 0) {
      console.log('[pdf-worker-proxy] Worker terminated (idle)');
      worker.terminate();
      worker = null;
    }
  }, IDLE_TIMEOUT);
}

function spawn(): Worker {
  const w = new Worker(workerPath());
  console.log('[pdf-worker-proxy] Worker started');

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
    console.error('[pdf-worker-proxy] Worker error:', err.message);
  });

  w.on('exit', (code) => {
    clearIdleTimer();
    if (code !== 0) {
      console.error(`[pdf-worker-proxy] Worker exited with code ${code}`);
    }
    // Reject all pending calls
    for (const [id, entry] of pending) {
      entry.reject(new Error(`PDF worker exited unexpectedly (code ${code})`));
      pending.delete(id);
    }
    worker = null;
  });

  return w;
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = spawn();
  }
  return worker;
}

/**
 * Set the default WebContents for progress messages
 * when no specific sender is available.
 */
export function setDefaultSender(sender: WebContents): void {
  defaultSender = sender;
}

/**
 * Call a method on the PDF worker.
 * @param method  Method name matching the dispatch table in pdf-worker.ts
 * @param args    Positional arguments (will be serialized via structured clone)
 * @param sender  Optional WebContents to receive progress events
 */
export function call(method: string, args: any[], sender?: WebContents): Promise<any> {
  const w = ensureWorker();
  // Any active call means the worker is not idle
  clearIdleTimer();
  const requestId = `r${++requestCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, sender });
    w.postMessage({ type: 'call', requestId, method, args });
  });
}

/**
 * Terminate the worker. Call during app shutdown.
 */
export async function terminate(): Promise<void> {
  clearIdleTimer();
  if (worker) {
    await worker.terminate();
    worker = null;
    pending.clear();
    console.log('[pdf-worker-proxy] Worker terminated');
  }
}

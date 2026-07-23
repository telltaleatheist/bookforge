/**
 * GPU arbiter — guarantees the local AI-cleanup LLM (llama-server) and the TTS
 * engine never occupy GPU VRAM at the same time, and offers a VRAM preflight for
 * GPU users this process can't see.
 *
 * Why this exists: both consumers load multi-GB models onto the same GPU. On a
 * 24 GB card the 14B cleanup LLM (~12 GB) + Orpheus/XTTS (~16 GB at vLLM's
 * gpu_memory_utilization=0.70) exceed VRAM, so the TTS worker OOM-crashes at
 * model load — observed as a 3-retry "max out → drop" sawtooth that ends with the
 * job dying. The TTS queue runs one job at a time, but the cleanup LLM is a
 * SEPARATE long-lived GPU server outside that queue, so nothing stopped them from
 * co-residing.
 *
 * Two independent mechanisms:
 *
 * 1. An in-process mutex (both consumers live in the Electron main process): one
 *    GPU holder at a time. The cleanup LLM is the LOW-priority holder — it
 *    registers a YIELD handler and steps off the GPU when a TTS job asks for it
 *    (after its current generation finishes, so no cleanup work is lost). TTS
 *    holds without yielding until its job ends. This is the hard guarantee.
 *
 * 2. waitForFreeVram() — a best-effort preflight the TTS path runs AFTER taking
 *    the mutex, to wait out GPU users OUTSIDE this process (a separate training
 *    run, ollama, another app) that the mutex cannot coordinate. It never fails a
 *    job: on timeout it proceeds and lets the worker's own OOM-retry be the
 *    backstop.
 *
 * The mutex is an OPTIMIZATION for correctness-of-placement, not a scarce
 * resource that must never be double-held: acquire takes a timeout so a stuck
 * holder can never wedge TTS forever, and release is idempotent.
 */

import { spawn } from 'child_process';

// Stable owner labels (for logging / holder identification).
export const GPU_OWNER_LLAMA = 'llama:cleanup';
export function gpuOwnerForTts(jobId: string): string {
  return `tts:${jobId}`;
}

type YieldHandler = () => void;

interface Holder {
  owner: string;
  onYield?: YieldHandler;
}

interface Waiter {
  owner: string;
  onYield?: YieldHandler;
  resolve: () => void;
  timer?: NodeJS.Timeout;
  /** Set when this waiter gave up (timed out) — its later release is a no-op. */
  abandoned?: boolean;
}

let holder: Holder | null = null;
const waiters: Waiter[] = [];

export function gpuHolder(): string | null {
  return holder?.owner ?? null;
}

export function isGpuBusy(): boolean {
  return holder !== null;
}

/**
 * Acquire the GPU. Resolves when this owner holds it.
 *
 * If another owner holds it, the current holder's `onYield` is invoked (once per
 * waiter added) to ask it to step off — e.g. the cleanup LLM unloads so a TTS job
 * can load. `timeoutMs` is a deadlock backstop: if the holder never yields within
 * the deadline, the waiter PROCEEDS WITHOUT owning the lock (logged) rather than
 * hanging forever; its later releaseGpu() is then a no-op.
 */
export function acquireGpu(
  owner: string,
  opts?: { onYield?: YieldHandler; timeoutMs?: number },
): Promise<void> {
  if (!holder) {
    holder = { owner, onYield: opts?.onYield };
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const waiter: Waiter = { owner, onYield: opts?.onYield, resolve };
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        waiter.abandoned = true;
        console.warn(
          `[gpu-arbiter] ${owner} timed out after ${Math.round(opts.timeoutMs! / 1000)}s ` +
          `waiting for GPU (held by ${holder?.owner ?? 'none'}); proceeding WITHOUT the lock`,
        );
        resolve();
      }, opts.timeoutMs);
    }
    waiters.push(waiter);
    // Nudge the current holder to give up the GPU.
    try { holder?.onYield?.(); } catch { /* a yield handler must never break acquire */ }
  });
}

/** Release the GPU. No-op unless `owner` is the current holder (idempotent). */
export function releaseGpu(owner: string): void {
  if (!holder || holder.owner !== owner) return;
  // Hand off to the next waiter that hasn't abandoned its wait.
  let next: Waiter | undefined;
  while ((next = waiters.shift())) {
    if (next.abandoned) continue;
    if (next.timer) clearTimeout(next.timer);
    holder = { owner: next.owner, onYield: next.onYield };
    next.resolve();
    return;
  }
  holder = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VRAM preflight (external-process safety net)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the primary NVIDIA GPU's memory via nvidia-smi. Returns null when
 * nvidia-smi is unavailable (no NVIDIA GPU / CPU-only / Apple) so callers skip
 * the check gracefully rather than blocking.
 */
export async function getGpuMemMB(): Promise<{ freeMB: number; totalMB: number } | null> {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
    let out = '';
    let done = false;
    const finish = (v: { freeMB: number; totalMB: number } | null) => {
      if (!done) { done = true; resolve(v); }
    };
    let proc;
    try {
      proc = spawn(exe, ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'], {
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => finish(null));
    proc.on('close', () => {
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (!first) { finish(null); return; }
      const parts = first.split(',').map((s) => parseInt(s.trim(), 10));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        finish({ freeMB: parts[0], totalMB: parts[1] });
      } else {
        finish(null);
      }
    });
    setTimeout(() => { try { proc?.kill(); } catch { /* ignore */ } finish(null); }, 5000);
  });
}

/** Free VRAM in MB (or null if nvidia-smi is unavailable). */
export async function getFreeVramMB(): Promise<number | null> {
  const mem = await getGpuMemMB();
  return mem ? mem.freeMB : null;
}

// Leave this much VRAM for the Windows compositor / browser / Electron GPU process
// and for moment-to-moment desktop fluctuation, so vLLM's reservation never reaches
// physical-full (which on WDDM spills into system RAM and freezes the machine).
export const DESKTOP_VRAM_MARGIN_MB = 3072;
// Orpheus-3B fp16 weights (~6.6 GiB) + a minimum working KV cache. Below this the
// engine genuinely can't load without spilling, so the caller should abort.
export const ORPHEUS_MIN_VRAM_MB = 8200;

/**
 * Size vLLM's `gpu_memory_utilization` (a fraction of TOTAL VRAM it reserves up
 * front and holds) so Orpheus takes a BOUNDED, absolute slice and leaves the rest of
 * the card free for Chrome / the desktop.
 *
 * The reservation is `min(capMB, free − marginMB)`:
 *   - `capMB` (from the memory tier) is the real limiter — however empty the GPU
 *     looks at launch, Orpheus never grabs more than this, so the browser always has
 *     room to grow. This is what fixes "auto still killed Chrome": the old code sized
 *     to free−margin and grabbed almost the whole card whenever Chrome's GPU process
 *     was still idle, then starved it when it woke up.
 *   - `free − marginMB` ensures we never reserve past currently-free VRAM (reserving
 *     past free is what WDDM backs with system RAM → whole-machine freeze).
 *
 * The util is `reservation / total`, additionally clamped by `ceiling` as a backstop.
 * Returns `sufficient:false` when the reservation can't even hold weights+KV, so the
 * caller refuses to launch (clean message) instead of crashing. With no NVIDIA GPU
 * visible, returns a conservative util and `sufficient:true` (nothing to size).
 */
export async function computeSafeGpuUtil(
  capMB: number,
  marginMB: number = DESKTOP_VRAM_MARGIN_MB,
  ceiling = 0.9,
): Promise<{ util: number; freeMB: number | null; totalMB: number | null; sufficient: boolean; reserveMB: number | null }> {
  const mem = await getGpuMemMB();
  if (!mem) {
    const util = Math.min(Math.max(ceiling, 0.1), 0.9);
    return { util, freeMB: null, totalMB: null, sufficient: true, reserveMB: null };
  }

  const cap = Math.min(Math.max(ceiling, 0.1), 0.95);
  // The bounded reservation: never more than the tier cap, never past free−margin.
  const reserveMB = Math.min(capMB, mem.freeMB - marginMB);
  const sufficient = reserveMB >= ORPHEUS_MIN_VRAM_MB;
  // util is a fraction of TOTAL; clamp to [0.05, ceiling]. Never above the reservation
  // (which is ≤ free), so vLLM can't over-commit and spill.
  const util = Math.max(Math.min(reserveMB / mem.totalMB, cap), 0.05);
  return {
    util: Math.round(util * 100) / 100,
    freeMB: mem.freeMB,
    totalMB: mem.totalMB,
    sufficient,
    reserveMB: Math.round(reserveMB),
  };
}

/**
 * Poll until at least `minMB` of VRAM is free, or `timeoutMs` elapses. Returns
 * `ok:true` immediately when no NVIDIA GPU is present (nothing to wait on). This
 * is a SAFETY NET for GPU users outside this process; it never throws.
 */
export async function waitForFreeVram(
  minMB: number,
  opts?: { timeoutMs?: number; pollMs?: number; onWait?: (freeMB: number, neededMB: number) => void },
): Promise<{ ok: boolean; freeMB: number | null }> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const pollMs = opts?.pollMs ?? 4000;
  const deadline = Date.now() + timeoutMs;

  let free = await getFreeVramMB();
  if (free === null) return { ok: true, freeMB: null }; // no NVIDIA GPU → nothing to gate on

  while (free !== null && free < minMB && Date.now() < deadline) {
    opts?.onWait?.(free, minMB);
    await new Promise((r) => setTimeout(r, pollMs));
    free = await getFreeVramMB();
  }
  return { ok: free === null || free >= minMB, freeMB: free };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama eviction (external-process VRAM release)
// ─────────────────────────────────────────────────────────────────────────────

// The AI-cleanup step can run its model through a local Ollama server, which is a
// SEPARATE process the in-process GPU mutex (mechanism #1 above) cannot coordinate:
// Ollama pins the model in VRAM for its `keep_alive` window (BookForge sets 5m) AFTER
// the last request, so a cleanup→TTS handoff finds ~9 GB still held and Orpheus/vLLM
// OOM-crashes at model load. Releasing the mutex frees the LOCK, not Ollama's VRAM —
// only telling Ollama to unload (or waiting out 5 minutes) does that. So the TTS path
// actively evicts Ollama's resident models before sizing/loading onto the GPU.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

/** Names of models Ollama currently holds in memory (empty if Ollama isn't running). */
async function loadedOllamaModels(timeoutMs = 3000): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name?: string; model?: string }> };
    return (data.models || [])
      .map((m) => m.name || m.model)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return []; // Ollama not running / unreachable → nothing to evict
  } finally {
    clearTimeout(timer);
  }
}

/** Ask Ollama to unload one model immediately (keep_alive:0 with an empty prompt). */
export async function unloadOllamaModel(model: string, timeoutMs = 8000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: ctrl.signal,
    });
  } catch {
    /* best-effort: the VRAM floor gate is the backstop if this fails */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evict every model Ollama currently holds in VRAM and return how many were unloaded.
 * Best-effort and never throws: if Ollama isn't running, or a request fails, the caller's
 * VRAM preflight still gates the launch. Call this before a GPU TTS job loads so the
 * cleanup model's VRAM is actually released rather than lingering for its keep_alive window.
 */
export async function unloadOllamaModels(): Promise<number> {
  const models = await loadedOllamaModels();
  if (models.length === 0) return 0;
  await Promise.all(models.map((m) => unloadOllamaModel(m)));
  return models.length;
}

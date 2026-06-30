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
 * front) to what is ACTUALLY FREE right now, minus a desktop margin — instead of a
 * fixed fraction of total. On a desktop-shared GPU a fixed fraction over-commits:
 * the compositor/browser already hold several GB, so e.g. 0.70×24=16.8 GiB plus the
 * desktop exceeds 24, and Windows WDDM backs the overflow with system RAM and
 * thrashes (whole-machine freeze) rather than OOM-ing cleanly. Sizing to free-minus-
 * margin keeps vLLM's reservation strictly under physical VRAM, so it either fits
 * (no spill) or fails fast with a clean OOM — never a freeze.
 *
 * `ceiling` caps the result (an explicit ORPHEUS_GPU_MEM_UTIL override, or 0.70).
 * Returns `sufficient:false` when free-minus-margin can't even hold weights+KV, so
 * the caller can refuse with a clear message. With no NVIDIA GPU visible, returns the
 * ceiling unchanged and `sufficient:true` (nothing to size).
 */
export async function computeSafeGpuUtil(
  ceiling: number,
): Promise<{ util: number; freeMB: number | null; totalMB: number | null; sufficient: boolean }> {
  const mem = await getGpuMemMB();
  if (!mem) return { util: ceiling, freeMB: null, totalMB: null, sufficient: true };

  const cap = Math.min(Math.max(ceiling, 0.1), 0.95);
  const budgetMB = mem.freeMB - DESKTOP_VRAM_MARGIN_MB;
  const sufficient = budgetMB >= ORPHEUS_MIN_VRAM_MB;
  // Size to the free budget, capped by the ceiling, floored so vLLM is at least asked
  // for weights+KV (when insufficient this still under-shoots free, yielding a clean
  // vLLM OOM rather than a spill; the caller aborts on !sufficient anyway).
  const sized = budgetMB / mem.totalMB;
  const floor = Math.min(ORPHEUS_MIN_VRAM_MB / mem.totalMB, cap);
  const util = Math.max(Math.min(sized, cap), floor);
  return {
    util: Math.round(util * 100) / 100,
    freeMB: mem.freeMB,
    totalMB: mem.totalMB,
    sufficient,
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

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
 *
 * WHICH IS EXACTLY WHY ACQUIRE MUST ANSWER STRAIGHT. Because proceeding without
 * the lease is legal here, the caller has to be TOLD that is what happened —
 * crucible/docs/ARCHITECTURE.md R3, "you either hold the card or you do not; a
 * caller is never handed an ambiguous answer." Until 2026-09-13 the timeout path
 * `resolve()`d exactly like the success path, and three call sites then recorded
 * `holdsGpu = true` for a lease they did not have, whose later release was a
 * silent no-op. `acquireGpu` now returns a `GpuLease` verdict; double-holding
 * stays permitted, pretending does not.
 *
 * UNLEASED OCCUPANTS. The same timeout dropped the waiter's `onYield`: a handler
 * is only ever attached to a HOLDER, so a caller that gave up waiting and started
 * anyway became un-preemptable — the text server up on ~20 GB with nothing left
 * that could ask it to step off (text-server.ts's whole low-priority posture,
 * evaporated). A timed-out waiter is therefore registered in `unleased` with its
 * yield handler, every acquire nudges those occupants as well as the holder, and
 * `releaseGpu` clears the registration by the same door. It is a NUDGE, not a
 * wait: an acquirer never blocks on an unleased occupant stepping off (it holds
 * no lease to wait on), so the thing that actually rides out the shutdown is the
 * caller's own waitForFreeVram() preflight below.
 */

import { spawn } from 'child_process';

// Stable owner labels (for logging / holder identification).
export const GPU_OWNER_LLAMA = 'llama:cleanup';
export function gpuOwnerForTts(jobId: string): string {
  return `tts:${jobId}`;
}

type YieldHandler = () => void;

interface Occupant {
  owner: string;
  onYield?: YieldHandler;
}

interface Waiter {
  owner: string;
  onYield?: YieldHandler;
  resolve: (lease: GpuLease) => void;
  timer?: NodeJS.Timeout;
  startedAt: number;
  /** Set when this waiter gave up (timed out) — release must skip it on handoff. */
  abandoned?: boolean;
}

/**
 * ACQUIRE'S VERDICT — the whole point of this type is that there is no third answer.
 *
 * `held:true`  — this owner is the holder. Its `onYield` (if any) is live, and
 *                `releaseGpu(owner)` hands the card to the next waiter.
 * `held:false` — the wait ran out and the caller is free to start anyway (which is
 *                what every call site in this app chooses — a ten-minute timeout
 *                must never silently cancel a nine-hour render), but it is NOT the
 *                holder and must not record that it is. `heldBy` names who had the
 *                card when the deadline passed, for the log line and nothing else.
 *
 * There is deliberately no `release()` closure on the held arm. Release is keyed by
 * OWNER because the teardown that has to call it is usually somewhere the lease
 * object never reached — a child process's 'exit' handler, a class's private
 * `stop()`, a `finally` three functions up. One door, `releaseGpu(owner)`, and it
 * is idempotent for a caller that holds nothing.
 */
export type GpuLease =
  | { readonly held: true; readonly owner: string }
  | {
      readonly held: false;
      readonly owner: string;
      readonly reason: 'timeout';
      readonly waitedMs: number;
      readonly heldBy: string | null;
    };

let holder: Occupant | null = null;
const waiters: Waiter[] = [];
/**
 * Owners that are ON the card WITHOUT the lease — they asked, the wait ran out, and
 * they started anyway. They are not holders and never become holders; they are here
 * so their `onYield` can still be reached (see the header). Keyed by owner so the
 * registration is cleared by the same `releaseGpu(owner)` every teardown already calls.
 */
const unleased = new Map<string, Occupant>();

export function gpuHolder(): string | null {
  return holder?.owner ?? null;
}

export function isGpuBusy(): boolean {
  return holder !== null;
}

/** Owners known to be on the card without the lease (diagnostics and keepers). */
export function unleasedGpuOccupants(): string[] {
  return [...unleased.keys()];
}

/**
 * Ask everyone on the card EXCEPT `owner` to step off: the holder, and every
 * occupant that timed out and started anyway. Never throws — a yield handler that
 * blows up must not take the acquire with it.
 */
function nudgeOccupantsOtherThan(owner: string): void {
  if (holder !== null && holder.owner !== owner) {
    try { holder.onYield?.(); } catch { /* a yield handler must never break acquire */ }
  }
  for (const occupant of unleased.values()) {
    if (occupant.owner === owner) continue;
    try { occupant.onYield?.(); } catch { /* ditto */ }
  }
}

/**
 * Acquire the GPU. Resolves with the VERDICT — see `GpuLease`; the caller branches
 * on `held` and never assumes.
 *
 * Every occupant other than this one is nudged to step off (`onYield`) whether or
 * not the lock was free, because "free" only means nobody holds the LEASE — an
 * unleased occupant can still have the card's VRAM.
 *
 * `timeoutMs` is a deadlock backstop: if the holder never yields within the deadline
 * the waiter is answered `held:false` rather than hanging forever, and is registered
 * as an unleased occupant so it stays preemptable. Without `timeoutMs` this waits
 * indefinitely and can therefore only ever resolve `held:true`.
 */
export function acquireGpu(
  owner: string,
  opts?: { onYield?: YieldHandler; timeoutMs?: number },
): Promise<GpuLease> {
  if (!holder) {
    holder = { owner, onYield: opts?.onYield };
    // Promoted out of the unleased set if a previous acquire by this owner timed out.
    unleased.delete(owner);
    nudgeOccupantsOtherThan(owner);
    return Promise.resolve({ held: true, owner });
  }

  return new Promise<GpuLease>((resolve) => {
    const waiter: Waiter = { owner, onYield: opts?.onYield, resolve, startedAt: Date.now() };
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        waiter.abandoned = true;
        const heldBy = holder?.owner ?? null;
        // Not a holder — but on the card all the same if the caller proceeds, so its
        // yield handler is kept reachable. Dropping it here is what made a timed-out
        // text server un-preemptable for the rest of its life.
        unleased.set(owner, { owner, onYield: opts?.onYield });
        console.warn(
          `[gpu-arbiter] ${owner} timed out after ${Math.round(opts.timeoutMs! / 1000)}s ` +
          `waiting for GPU (held by ${heldBy ?? 'none'}); answered held:false — the caller ` +
          'decides whether to proceed',
        );
        resolve({ held: false, owner, reason: 'timeout', waitedMs: Date.now() - waiter.startedAt, heldBy });
      }, opts.timeoutMs);
    }
    waiters.push(waiter);
    nudgeOccupantsOtherThan(owner);
  });
}

/**
 * Give up whatever claim `owner` has on the card: the lease if it holds it, and its
 * unleased registration if it timed out and started anyway. Idempotent, and a no-op
 * for an owner with neither — which is why every teardown may call it unconditionally
 * rather than gating on a bookkeeping flag that could itself be wrong.
 */
export function releaseGpu(owner: string): void {
  unleased.delete(owner);
  if (!holder || holder.owner !== owner) return;
  // Hand off to the next waiter that hasn't abandoned its wait.
  let next: Waiter | undefined;
  while ((next = waiters.shift())) {
    if (next.abandoned) continue;
    if (next.timer) clearTimeout(next.timer);
    holder = { owner: next.owner, onYield: next.onYield };
    unleased.delete(next.owner);
    next.resolve({ held: true, owner: next.owner });
    return;
  }
  holder = null;
}

/**
 * Say out loud that a caller is starting on the card WITHOUT the lease.
 *
 * PRESERVING TODAY'S BEHAVIOUR IS THE POINT. Every acquirer in this app proceeds on
 * a timeout and that is not this change's decision to revisit — a ten-minute wait
 * must not cancel hours of work, and whether it should is Owen's ruling, not a side
 * effect of a promise shape. What changes is that proceeding is now a CHOICE the
 * call site makes in one visible line, with the contention it accepted named.
 */
export function warnProceedingWithoutGpu(lease: GpuLease, what: string): void {
  if (lease.held) return;
  console.warn(
    `[gpu-arbiter] ${what} is starting WITHOUT the GPU lease: ${lease.owner} waited ` +
    `${Math.round(lease.waitedMs / 1000)}s and ${lease.heldBy ?? 'nobody'} held the card at the ` +
    'deadline. Proceeding is the deliberate choice (a timeout never cancels the work); the two ' +
    'may now contend for VRAM and whichever loses OOMs at model load.',
  );
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
 * Which artifact form an Orpheus spawn will serve. Sizing differs — see below.
 */
export type OrpheusServeArtifact = 'merged' | 'adapter';

/**
 * VRAM (MB) an ADAPTER-mode spawn needs OUTSIDE vLLM's own reservation.
 *
 * MEASURED (step-1 A/B, 2026-08-03): vLLM 0.7.3 profiles IDENTICAL weights and KV
 * budgets in merged and adapter mode — it does not account for the resident LoRA
 * (~0.39 GB per adapter) or the punica kernel workspace at all. Those allocations
 * therefore come out of whatever slack is left INSIDE the reservation, and the first
 * thing to run out of slack is SNAC decode: the adapter run took a recoverable
 * SNAC-decode CUDA OOM (freed cache, retried, output complete) at
 * GPU_MEM_UTIL = 0.70 with max_loras = 1. A recoverable OOM is a warning, not a
 * result — on a tighter card, or with max_loras > 1 for per-character casting, that
 * becomes a routine first-batch failure.
 *
 * So an adapter spawn RESERVES 1.0 GiB LESS for vLLM than the equivalent merged
 * spawn, leaving that GiB physically free for the adapter + punica + SNAC's slack.
 * 1.0 GiB covers 0.4 GiB × max_loras=1 plus the workspace with real margin; revisit
 * (0.4 GiB per extra resident adapter) when max_loras rises above 1.
 *
 * MERGED SPAWNS ARE COMPLETELY UNAFFECTED: headroom is 0 and every number below
 * resolves to what it was before.
 */
export const ORPHEUS_ADAPTER_HEADROOM_MB = 1024;

/**
 * vLLM's OWN weights+KV floor in adapter mode — HIGHER than merged, never lower.
 *
 * There is no "the base is smaller than a merged fine-tune" saving to bank: the base
 * and every deployed merge ship the SAME two bf16 shards, byte-for-byte identical in
 * size (4,991,037,968 + 1,610,725,592). A LoRA merge changes weight VALUES, not the
 * tensor shapes, so adapter mode loads exactly the weights merged mode loads. The
 * merged floor (ORPHEUS_MIN_VRAM_MB, weights + a minimum working KV) therefore applies
 * unchanged, and adapter mode needs MORE on top of it.
 *
 * 8824 = 8200 (merged floor) + 624, the measured out-of-budget slack an adapter spawn
 * consumes inside the reservation: vLLM 0.7.3 profiles identical weights/KV budgets in
 * both modes, so the resident LoRA + punica workspace + the extra SNAC-decode pressure
 * come out of whatever slack is left — and in the step-1 A/B (2026-08-03) that slack
 * ran out, producing a recoverable SNAC-decode CUDA OOM at GPU_MEM_UTIL = 0.70 with
 * max_loras = 1. The 1.0 GiB carved off the reservation (ORPHEUS_ADAPTER_HEADROOM_MB)
 * covers the allocations that live wholly outside the budget; this 624 MB covers the
 * part that does not.
 */
export const ORPHEUS_ADAPTER_MIN_VRAM_MB = 8824;

/** The floor vLLM's own reservation must clear, per artifact form. */
export function orpheusMinVllmVramMB(artifact: OrpheusServeArtifact = 'merged'): number {
  return artifact === 'adapter' ? ORPHEUS_ADAPTER_MIN_VRAM_MB : ORPHEUS_MIN_VRAM_MB;
}

/** Total free VRAM a spawn needs: vLLM's reservation floor PLUS anything that lives
 *  outside it. Merged ⇒ exactly ORPHEUS_MIN_VRAM_MB, unchanged. */
export function orpheusMinFreeVramMB(artifact: OrpheusServeArtifact = 'merged'): number {
  return orpheusMinVllmVramMB(artifact) + (artifact === 'adapter' ? ORPHEUS_ADAPTER_HEADROOM_MB : 0);
}

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
  artifact: OrpheusServeArtifact = 'merged',
): Promise<{ util: number; freeMB: number | null; totalMB: number | null; sufficient: boolean; reserveMB: number | null }> {
  const mem = await getGpuMemMB();
  if (!mem) {
    const util = Math.min(Math.max(ceiling, 0.1), 0.9);
    return { util, freeMB: null, totalMB: null, sufficient: true, reserveMB: null };
  }

  const cap = Math.min(Math.max(ceiling, 0.1), 0.95);
  // The bounded reservation: never more than the tier cap, never past free−margin,
  // MINUS whatever this artifact form allocates outside vLLM's budget (adapter +
  // punica workspace — see ORPHEUS_ADAPTER_HEADROOM_MB). Merged subtracts 0.
  const headroomMB = artifact === 'adapter' ? ORPHEUS_ADAPTER_HEADROOM_MB : 0;
  const reserveMB = Math.min(capMB, mem.freeMB - marginMB) - headroomMB;
  const sufficient = reserveMB >= orpheusMinVllmVramMB(artifact);
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

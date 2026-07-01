/**
 * Orpheus batch width — how many sentences run concurrently in ONE generate()
 * call (MLX BatchGenerator on Mac, vLLM on NVIDIA). Single source of truth used
 * by BOTH Orpheus pipelines so each gets real continuous batching, not one-at-a-
 * time generation:
 *   - processing / audiobook   → electron/parallel-tts-bridge.ts (worker spawn env)
 *   - streaming / live reading → electron/orpheus-worker-pool.ts (read-ahead coalescing cap)
 *
 * Mac and NVIDIA are deliberately SEPARATE branches: the two backends saturate
 * for different reasons and are tuned independently. Change one without touching
 * the other. ORPHEUS_BATCH_SIZE in the environment overrides both branches.
 *
 * Mac is capped at 64 (below its 96 throughput peak) to bound unified-memory use
 * — ~16 GB vs ~21 GB at 96, for only ~12% less throughput. NVIDIA stays at 96:
 * vLLM batches inside a fixed pre-reserved KV pool, so a wider batch there costs
 * no extra VRAM (see the NVIDIA branch below).
 */

const MAC_ORPHEUS_BATCH = '64';
const NVIDIA_ORPHEUS_BATCH = '96';

/**
 * Resolve the default Orpheus batch width for THIS machine, as a string (the
 * form the worker env / Python `os.environ` expects). Honors an explicit
 * ORPHEUS_BATCH_SIZE override before falling back to the per-platform default.
 */
export function defaultOrpheusBatchSize(): string {
  const override = process.env.ORPHEUS_BATCH_SIZE;
  if (override && override.trim()) return override.trim();

  if (process.platform === 'darwin') {
    // Mac → Orpheus MLX (mlx_lm.BatchGenerator). Benchmarked on M1 Ultra the
    // throughput curve is 16→13.8, 32→19.0, 64→24.7, 96→28.2 sent/min (peaks at
    // 96; 128 regresses to 27.3 on the drain tail). Capped at 64 for memory:
    // ~16 GB peak vs ~21 GB at 96, giving up ~12% throughput.
    return MAC_ORPHEUS_BATCH;
  }

  // NVIDIA → Orpheus vLLM (CUDA; via WSL on Windows). The KV-cache pool is fixed
  // by gpu_memory_utilization, so a wider batch consumes MORE of the already-
  // reserved pool WITHOUT allocating extra VRAM — no memory reason to cap it, so
  // it stays at 96. That keeps a bandwidth-bound GPU fed (a ~9 GiB pool holds
  // ~50–125 typical sentences; vLLM queues any overflow — no crash, no extra
  // VRAM). At 96/batch a flush is ~2.4 min, under the 5-min
  // WORKER_PROGRESS_TIMEOUT_MS, so no false stall-kill.
  return NVIDIA_ORPHEUS_BATCH;
}

/** Same value as {@link defaultOrpheusBatchSize} but parsed to a positive int. */
export function defaultOrpheusBatchSizeInt(): number {
  const n = parseInt(defaultOrpheusBatchSize(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

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
 * Capped at 64 (not the 96 throughput peak) to bound peak memory: on M1 Ultra
 * 96 peaks ~21 GB vs ~16 GB at 64, for only ~12% more throughput (28.2 vs 24.7
 * sent/min). 64 is the memory/throughput sweet spot for both pipelines.
 */

const MAC_ORPHEUS_BATCH = '64';
const NVIDIA_ORPHEUS_BATCH = '64';

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
  // reserved pool WITHOUT allocating extra VRAM. 64 keeps a bandwidth-bound GPU
  // fed (a ~9 GiB pool holds ~50–125 typical sentences; vLLM queues any overflow
  // — no crash, no extra VRAM) while matching the Mac cap for one predictable
  // memory ceiling across platforms.
  return NVIDIA_ORPHEUS_BATCH;
}

/** Same value as {@link defaultOrpheusBatchSize} but parsed to a positive int. */
export function defaultOrpheusBatchSizeInt(): number {
  const n = parseInt(defaultOrpheusBatchSize(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

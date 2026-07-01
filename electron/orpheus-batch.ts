/**
 * Orpheus batch width — how many sentences run concurrently in ONE generate()
 * call (MLX BatchGenerator on Mac, vLLM on NVIDIA). Single source of truth used
 * by BOTH Orpheus pipelines:
 *   - processing / audiobook   → parallel-tts-bridge.ts uses it as the fixed batch
 *   - streaming / live reading → orpheus-worker-pool.ts / stream-scheduler.ts use
 *     it as the CEILING the streaming ramp climbs to (opener streams, then batches
 *     widen 1→2→4→…→max as buffer builds).
 *
 * The value is the per-machine MAX, user-configurable in Settings → Streaming
 * engine (persisted to orpheus-batch.json in userData). Resolution order:
 *   1. ORPHEUS_BATCH_SIZE env var (explicit override, wins)
 *   2. persisted user max (Settings)
 *   3. per-platform default below
 *
 * Mac defaults to 64 (below its 96 throughput peak) to bound unified-memory use
 * — ~16 GB vs ~21 GB at 96, for ~12% less throughput. NVIDIA defaults to 96:
 * vLLM batches inside a fixed pre-reserved KV pool, so a wider batch there costs
 * no extra VRAM.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAC_ORPHEUS_BATCH = 64;
const NVIDIA_ORPHEUS_BATCH = 96;

// Clamp range for a user-set max. Below 1 is nonsensical; above 256 buys nothing
// (throughput peaks well before then) and only risks memory/latency.
const MIN_BATCH = 1;
const MAX_BATCH = 256;

/** The per-platform default max (used when neither env nor a user setting is set). */
export function platformDefaultBatchSize(): number {
  return process.platform === 'darwin' ? MAC_ORPHEUS_BATCH : NVIDIA_ORPHEUS_BATCH;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'orpheus-batch.json');
}

// Cached so the hot streaming path (getMaxConcurrentSentences per pump) doesn't
// stat/parse the file every call. `undefined` = not yet loaded; `null` = loaded,
// no user override. Invalidated by setOrpheusMaxBatch.
let cachedUserMax: number | null | undefined = undefined;

function readUserMax(): number | null {
  if (cachedUserMax !== undefined) return cachedUserMax;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    const n = Number(cfg?.maxBatch);
    cachedUserMax = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    cachedUserMax = null; // first run / unreadable
  }
  return cachedUserMax;
}

/**
 * Persist the user's Orpheus max batch for THIS machine. Pass null to clear the
 * override and fall back to the platform default. Values are clamped to
 * [MIN_BATCH, MAX_BATCH].
 */
export function setOrpheusMaxBatch(value: number | null): void {
  try {
    if (value == null) {
      fs.writeFileSync(configPath(), JSON.stringify({}, null, 2));
      cachedUserMax = null;
      return;
    }
    const v = Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.floor(value)));
    fs.writeFileSync(configPath(), JSON.stringify({ maxBatch: v }, null, 2));
    cachedUserMax = v;
  } catch (err) {
    console.error('[orpheus-batch] Failed to persist orpheus-batch.json:', err);
  }
}

/**
 * Resolve the effective Orpheus batch max for THIS machine, as a string (the form
 * the worker env / Python `os.environ` expects). env override > user setting >
 * platform default.
 */
export function defaultOrpheusBatchSize(): string {
  const override = process.env.ORPHEUS_BATCH_SIZE;
  if (override && override.trim()) return override.trim();
  const user = readUserMax();
  if (user != null) return String(user);
  return String(platformDefaultBatchSize());
}

/** Same value as {@link defaultOrpheusBatchSize} but parsed to a positive int. */
export function defaultOrpheusBatchSizeInt(): number {
  const n = parseInt(defaultOrpheusBatchSize(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Snapshot for the Settings UI: what's effective, what the user set (if any),
 *  the platform default, and whether an env override is forcing the value. */
export interface OrpheusBatchConfig {
  /** Effective max in use right now. */
  value: number;
  /** User-set max, or null when using the platform default. */
  userMax: number | null;
  /** Per-platform default (shown as the reset target / placeholder). */
  platformDefault: number;
  /** 'mac' (MLX) or 'nvidia' (vLLM). */
  platform: 'mac' | 'nvidia';
  /** True when ORPHEUS_BATCH_SIZE env is forcing the value (UI should note it). */
  envOverride: boolean;
  /** Clamp bounds for the input. */
  min: number;
  max: number;
}

export function getOrpheusBatchConfig(): OrpheusBatchConfig {
  const env = process.env.ORPHEUS_BATCH_SIZE;
  return {
    value: defaultOrpheusBatchSizeInt(),
    userMax: readUserMax(),
    platformDefault: platformDefaultBatchSize(),
    platform: process.platform === 'darwin' ? 'mac' : 'nvidia',
    envOverride: !!(env && env.trim()),
    min: MIN_BATCH,
    max: MAX_BATCH,
  };
}

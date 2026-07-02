/**
 * Orpheus memory tier — how aggressively Orpheus may claim memory, traded against
 * how much it leaves free for the desktop/browser/other apps. Same four tiers on
 * every platform, but the underlying lever is PLATFORM-SPECIFIC:
 *
 *  • Windows/Linux (vLLM): `marginMB` = VRAM to keep FREE. vLLM reserves
 *    `gpu_memory_utilization × TOTAL` up front, and on Windows WDDM an over-
 *    reservation spills into system RAM and thrashes the machine (this is what
 *    crashes Chrome mid-job). Sizing the reservation to `free − marginMB` keeps it
 *    strictly under physical VRAM. Bigger margin ⇒ vLLM takes less ⇒ more headroom,
 *    at the cost of a smaller KV pool (a bit slower). `ceiling` caps the fraction.
 *
 *  • macOS (MLX): there is no VRAM reservation — MLX uses UNIFIED memory shared with
 *    the system. The lever there is the batch width (how many sentences run at once):
 *    ~16 GB at 64, ~21 GB at 96. So the Mac tier maps to `batchSize`.
 *
 * Persisted per machine (orpheus-memory.json in userData) — a Mac install and a
 * Windows install each keep their own tier. The buttons on the TTS processing page
 * set it; the TTS paths read the platform-appropriate field at acquire time.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export type OrpheusMemoryTier = 'extreme' | 'fast' | 'moderate' | 'light';

export interface OrpheusMemoryProfile {
  tier: OrpheusMemoryTier;
  /** vLLM only (win/linux): VRAM (MB) to leave free for everything else. */
  marginMB: number;
  /** vLLM only: cap on gpu_memory_utilization (fraction of TOTAL VRAM). */
  ceiling: number;
  /** MLX only (mac): Orpheus batch width — bounds unified-memory use. */
  batchSize: number;
}

// vLLM levers (Windows/Linux). marginMB grows as the tier gets lighter (leaves more
// for everything else). 'moderate' reproduces the prior fixed default (3072 / 0.70).
const VLLM_TIERS: Record<OrpheusMemoryTier, { marginMB: number; ceiling: number }> = {
  extreme: { marginMB: 512, ceiling: 0.95 },
  fast: { marginMB: 1536, ceiling: 0.88 },
  moderate: { marginMB: 3072, ceiling: 0.70 },
  light: { marginMB: 6144, ceiling: 0.55 },
};

// MLX lever (macOS): batch width, which drives unified-memory footprint.
const MLX_TIERS: Record<OrpheusMemoryTier, { batchSize: number }> = {
  extreme: { batchSize: 96 },
  fast: { batchSize: 72 },
  moderate: { batchSize: 48 },
  light: { batchSize: 24 },
};

export const ORPHEUS_MEMORY_TIERS = VLLM_TIERS; // back-compat alias

export const DEFAULT_ORPHEUS_MEMORY_TIER: OrpheusMemoryTier = 'moderate';

function isTier(v: unknown): v is OrpheusMemoryTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VLLM_TIERS, v);
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'orpheus-memory.json');
}

let cached: OrpheusMemoryTier | undefined;

/** The persisted tier for this machine (default 'moderate'). */
export function getOrpheusMemoryTier(): OrpheusMemoryTier {
  if (cached !== undefined) return cached;
  let resolved: OrpheusMemoryTier = DEFAULT_ORPHEUS_MEMORY_TIER;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    if (isTier(cfg?.tier)) resolved = cfg.tier;
  } catch {
    /* first run / unreadable — keep default */
  }
  cached = resolved;
  return resolved;
}

/** Persist the tier for this machine. Ignores unknown values. */
export function setOrpheusMemoryTier(tier: OrpheusMemoryTier): void {
  if (!isTier(tier)) return;
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ tier }, null, 2));
    cached = tier;
  } catch (err) {
    console.error('[orpheus-memory] Failed to persist orpheus-memory.json:', err);
  }
}

/** The full profile for the given (or current) tier. vLLM callers read marginMB +
 *  ceiling; MLX callers read batchSize. */
export function orpheusMemoryProfile(tier?: OrpheusMemoryTier): OrpheusMemoryProfile {
  const t = tier ?? getOrpheusMemoryTier();
  return { tier: t, ...VLLM_TIERS[t], ...MLX_TIERS[t] };
}

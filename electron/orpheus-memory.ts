/**
 * Orpheus memory tier — how aggressively Orpheus may claim memory, traded against
 * how much it leaves free for the desktop/browser/other apps. Four concrete tiers
 * on every platform, plus an **auto** tier (the default) that picks the highest
 * concrete tier the machine can actually sustain. The underlying lever is
 * PLATFORM-SPECIFIC:
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
 * **Auto tier.** "extreme" is fragile on a desktop-shared GPU: even when there's
 * enough VRAM at launch, a mid-job browser/desktop spike spills the pre-reserved
 * pool and freezes the machine. So auto (a) picks the highest concrete tier that
 * fits the CURRENT free VRAM with headroom, and (b) never exceeds a persisted
 * `autoCeiling` that ratchets DOWN whenever an Orpheus job hits an out-of-memory
 * failure. Over a run or two the machine converges on the fastest tier it can
 * actually hold — which is exactly "pick the highest speed it can handle".
 *
 * Persisted per machine (orpheus-memory.json in userData) — a Mac install and a
 * Windows install each keep their own tier + learned ceiling. The buttons on the
 * TTS processing page set the tier; the TTS paths call `resolveConcreteOrpheusTier`
 * at spawn time to turn 'auto' into a concrete tier.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ORPHEUS_MIN_VRAM_MB } from './gpu-arbiter';

/** The concrete memory levels, plus the self-tuning 'auto'. */
export type OrpheusMemoryTier = 'auto' | 'extreme' | 'fast' | 'moderate' | 'light';
/** The four levels that map to a real profile (everything except 'auto'). */
export type ConcreteOrpheusTier = Exclude<OrpheusMemoryTier, 'auto'>;

export interface OrpheusMemoryProfile {
  tier: ConcreteOrpheusTier;
  /** vLLM only (win/linux): ABSOLUTE VRAM (MB) Orpheus is allowed to use — weights
   *  (~6.6 GiB) plus a bounded KV cache. This is the real limiter: whatever the card
   *  has, Orpheus never reserves more than this, so the rest stays free for Chrome /
   *  the desktop. `gpu_memory_utilization` is derived from it (capMB / total). */
  capMB: number;
  /** vLLM only: a small safety floor subtracted from FREE so we never reserve the
   *  literal last MB when free is below capMB. Secondary to capMB. */
  marginMB: number;
  /** vLLM only: hard cap on gpu_memory_utilization (fraction of TOTAL) — a backstop
   *  in case capMB/total is somehow larger than intended. */
  ceiling: number;
  /** MLX only (mac): Orpheus batch width — bounds unified-memory use. */
  batchSize: number;
  /** vLLM only (win/linux): how many sentences to submit at once. This is DECOUPLED
   *  from VRAM — vLLM never allocates past gpu_memory_utilization no matter the batch,
   *  so a big batch can't OOM; it only risks preemption if a batch's sentences are
   *  collectively too long for the KV cache. Real narration sentences are far shorter
   *  than the 4096-token max, so many more than the worst-case "12x concurrency" fit —
   *  a big batch keeps vLLM saturated (the throughput lever). Bigger cap ⇒ bigger KV ⇒
   *  bigger safe batch. */
  vllmBatch: number;
}

// vLLM levers (Windows/Linux). The primary lever is now an ABSOLUTE cap on how much
// VRAM Orpheus may take, so it leaves the rest of the card free regardless of how
// empty the GPU looks at launch (the old "free − margin" grabbed almost everything
// when Chrome's GPU process was still idle, then starved it). Orpheus-3B weights are
// ~6.6 GiB; the cap adds a KV budget on top. 'moderate' ≈ 10 GiB is ample for a 3B
// model; heavier tiers just buy more concurrent KV on a card with room to spare.
// vllmBatch is matched to the KV-cache concurrency each cap provides (measured: at the
// ~10 GiB 'moderate' cap vLLM reports ~5.4x concurrency for 4096-token requests, KV ≈
// 2.4 GiB after ~7.7 GiB fixed weights+activation). Submitting more than that just makes
// vLLM admit-then-evict (RECOMPUTE preemption) — wasted work, not more parallelism.
// vllmBatch is the THROUGHPUT lever (submission width), NOT a memory lever — VRAM is
// bounded by the cap regardless. The worst-case "12x concurrency at 4096 tokens" is
// pessimistic: narration sentences are far shorter, so vLLM runs many more at once, and
// a batch matched to worst-case (the old 11) throttled it (measured 43 vs ~150 sent/min
// with the original batch-96). So batch is set generously per KV size — big enough to
// keep vLLM saturated with short sentences, accepting occasional preemption on a rare
// long-sentence batch (a small speed cost, never OOM). Mirrors the Mac/MLX widths.
const VLLM_TIERS: Record<ConcreteOrpheusTier, { capMB: number; marginMB: number; ceiling: number; vllmBatch: number }> = {
  extreme: { capMB: 18432, marginMB: 1024, ceiling: 0.95, vllmBatch: 96 }, // 18 GiB — KV ~10 GiB
  fast: { capMB: 13312, marginMB: 2048, ceiling: 0.88, vllmBatch: 64 },    // 13 GiB — KV ~5 GiB
  moderate: { capMB: 10240, marginMB: 2048, ceiling: 0.70, vllmBatch: 40 },// 10 GiB — KV ~2.4 GiB
  light: { capMB: 8704, marginMB: 2048, ceiling: 0.55, vllmBatch: 20 },    // 8.5 GiB — smaller KV
};

// How much VRAM to leave FREE for the rest of the machine. This must cover the PEAK
// (not current) usage of everything else on a desktop-shared GPU: Windows, the
// BookForge app's own Chromium GPU process, AND the user's browser (Chrome with
// GPU-accelerated tabs/video can spike to several GB on its own). The trap: Windows
// WDDM does NOT cleanly fail when the GPU is oversubscribed — it silently pages GPU
// memory into system RAM ("shared GPU memory"), which thrashes and crashes the machine.
// So vLLM + peak-desktop must stay comfortably under physical VRAM. Measured on the
// user's 24 GB 3090 Ti: 10 GB reserved (≈ Chrome/app/desktop peak) keeps the cap in the
// safe zone (~13 GB) — 16-19 GB crashed via exactly this WDDM spill.
const DESKTOP_HEADROOM_MB = 10240;

// MLX lever (macOS): batch width, which drives unified-memory footprint.
const MLX_TIERS: Record<ConcreteOrpheusTier, { batchSize: number }> = {
  extreme: { batchSize: 96 },
  fast: { batchSize: 72 },
  moderate: { batchSize: 48 },
  light: { batchSize: 24 },
};

/** Aggression order, highest → lowest (index 0 = most memory-hungry / fastest). */
const TIER_ORDER: ConcreteOrpheusTier[] = ['extreme', 'fast', 'moderate', 'light'];

export const ORPHEUS_MEMORY_TIERS = VLLM_TIERS; // back-compat alias

// Default is auto: the app finds the fastest tier the machine can hold.
export const DEFAULT_ORPHEUS_MEMORY_TIER: OrpheusMemoryTier = 'auto';

function isTier(v: unknown): v is OrpheusMemoryTier {
  return v === 'auto' || (typeof v === 'string' && Object.prototype.hasOwnProperty.call(VLLM_TIERS, v));
}
function isConcrete(v: unknown): v is ConcreteOrpheusTier {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VLLM_TIERS, v);
}

/** The LOWER (safer) of two concrete tiers, by aggression order. */
function lowerOf(a: ConcreteOrpheusTier, b: ConcreteOrpheusTier): ConcreteOrpheusTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
/** The concrete tier one step lighter than `t` (clamped at 'light'). */
function tierBelow(t: ConcreteOrpheusTier): ConcreteOrpheusTier {
  const i = TIER_ORDER.indexOf(t);
  return TIER_ORDER[Math.min(i + 1, TIER_ORDER.length - 1)];
}

interface OrpheusMemoryConfig {
  tier: OrpheusMemoryTier;
  /** Auto mode only: the highest tier auto is allowed to pick (learned from OOMs). */
  autoCeiling?: ConcreteOrpheusTier;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'orpheus-memory.json');
}

let cached: OrpheusMemoryConfig | undefined;

function readConfig(): OrpheusMemoryConfig {
  if (cached !== undefined) return cached;
  let resolved: OrpheusMemoryConfig = { tier: DEFAULT_ORPHEUS_MEMORY_TIER };
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    if (isTier(cfg?.tier)) resolved.tier = cfg.tier;
    if (isConcrete(cfg?.autoCeiling)) resolved.autoCeiling = cfg.autoCeiling;
  } catch {
    /* first run / unreadable — keep default */
  }
  cached = resolved;
  return resolved;
}

function writeConfig(cfg: OrpheusMemoryConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    cached = cfg;
  } catch (err) {
    console.error('[orpheus-memory] Failed to persist orpheus-memory.json:', err);
  }
}

/** The persisted tier for this machine (may be 'auto'; default 'auto'). */
export function getOrpheusMemoryTier(): OrpheusMemoryTier {
  return readConfig().tier;
}

/** Persist the tier for this machine. Ignores unknown values. Switching TO auto
 *  clears any learned ceiling so it can re-probe from the top. */
export function setOrpheusMemoryTier(tier: OrpheusMemoryTier): void {
  if (!isTier(tier)) return;
  const cur = readConfig();
  writeConfig({ tier, autoCeiling: tier === 'auto' ? undefined : cur.autoCeiling });
}

/** The learned auto ceiling for this machine, or undefined (no OOM seen yet). */
export function getOrpheusAutoCeiling(): ConcreteOrpheusTier | undefined {
  return readConfig().autoCeiling;
}

/**
 * Record that an Orpheus job hit an out-of-memory failure while running at
 * `usedTier`. Lowers the auto ceiling to one step below that tier so future auto
 * runs stay under it. No-op below 'light'. Safe to call regardless of mode; it only
 * affects auto resolution.
 */
export function noteOrpheusOom(usedTier: ConcreteOrpheusTier): void {
  if (!isConcrete(usedTier)) return;
  const cur = readConfig();
  const next = tierBelow(usedTier);
  const ceiling = cur.autoCeiling ? lowerOf(cur.autoCeiling, next) : next;
  if (ceiling === cur.autoCeiling) return; // already at/below — nothing to learn
  console.warn(`[orpheus-memory] OOM at tier '${usedTier}' → auto ceiling lowered to '${ceiling}'`);
  writeConfig({ tier: cur.tier, autoCeiling: ceiling });
}

/** Full profile for a CONCRETE tier. vLLM callers read capMB + marginMB + ceiling;
 *  MLX callers read batchSize. */
export function orpheusMemoryProfile(tier: ConcreteOrpheusTier): OrpheusMemoryProfile {
  const t = isConcrete(tier) ? tier : 'moderate';
  return { tier: t, ...VLLM_TIERS[t], ...MLX_TIERS[t] };
}

// ── Auto resolution ──────────────────────────────────────────────────────────
//
// Orpheus takes an ABSOLUTE, bounded slice of VRAM (its tier cap) and leaves the
// rest for Chrome/the desktop. So auto just picks the largest tier whose cap still
// leaves DESKTOP_HEADROOM_MB free — plus 'extreme' under a strict idle gate (cap +
// slack free right now), since that's the proven max-throughput config for overnight
// runs. If the card is too full to even hold Orpheus's weights+KV floor, it reports
// viable:false so the caller refuses to launch instead of crashing.

/** Can we actually fit this tier's reservation right now? min(cap, free − margin) must
 *  still cover weights+KV. */
function reservationMB(t: ConcreteOrpheusTier, freeMB: number): number {
  return Math.min(VLLM_TIERS[t].capMB, freeMB - VLLM_TIERS[t].marginMB);
}
function fits(t: ConcreteOrpheusTier, freeMB: number): boolean {
  return reservationMB(t, freeMB) >= ORPHEUS_MIN_VRAM_MB;
}

/**
 * A full auto suggestion for the current GPU: which concrete tier to use, whether the
 * GPU can run Orpheus at all, and the raw numbers (for the UI). `viable:false` means
 * even the smallest tier can't hold weights+KV right now — the caller must NOT launch
 * on GPU (offer CPU / "close apps" instead of crashing). When VRAM is unknown (mac /
 * no nvidia-smi) fall back to system RAM (mac) or a safe 'moderate' and assume viable.
 */
export function orpheusAutoSuggestion(freeMB: number | null, totalMB: number | null): {
  tier: ConcreteOrpheusTier;
  viable: boolean;
  freeMB: number | null;
  usedMB: number | null;
  /** The absolute VRAM (MB) Orpheus will reserve at this tier, for the UI. */
  reserveMB: number | null;
} {
  // No VRAM reading: mac uses unified-RAM bands; elsewhere pick a safe middle.
  if (freeMB == null || totalMB == null) {
    if (process.platform === 'darwin') {
      const ram = Math.round(os.totalmem() / (1024 * 1024));
      const t = ram >= 48_000 ? 'fast' : ram >= 24_000 ? 'moderate' : 'light';
      return { tier: t, viable: true, freeMB: null, usedMB: null, reserveMB: null };
    }
    return { tier: 'moderate', viable: true, freeMB: null, usedMB: null, reserveMB: null };
  }

  const usedMB = Math.max(0, totalMB - freeMB);
  // 'extreme' (18 GiB cap, batch 96) is the measured ~150 sent/min configuration on a
  // 24 GB card, but it can never satisfy the DESKTOP_HEADROOM guarantee below
  // (24 − 18 < 10 GiB), so auto may pick it ONLY under a strict idle gate: the whole
  // cap plus EXTREME_IDLE_SLACK_MB must be free RIGHT NOW. That is true on an idle
  // desktop (overnight batch, browser closed) and false the moment Chrome or heavy
  // desktop use holds a few GB. Even then vLLM never grows past the cap, so ~5-6 GiB
  // of a 24 GB card stays free — enough for an idle desktop, and a mid-run OOM still
  // ratchets the autoCeiling down like any other auto pick. Daytime/loaded runs fall
  // through to the headroom-guaranteed tiers.
  const EXTREME_IDLE_SLACK_MB = 4096;
  if (freeMB >= VLLM_TIERS.extreme.capMB + EXTREME_IDLE_SLACK_MB && fits('extreme', freeMB)) {
    return { tier: 'extreme', viable: true, freeMB, usedMB, reserveMB: Math.max(0, reservationMB('extreme', freeMB)) };
  }
  // Largest tier whose cap leaves DESKTOP_HEADROOM_MB free AND still holds the floor.
  // Auto otherwise tops out at 'fast' (~13 GiB): on a desktop-shared 24 GB GPU that
  // leaves ~11 GiB for Windows + the app + the browser at their PEAK — 16-19 GiB
  // oversubscribed the shared card while loaded and Windows WDDM spilled GPU memory
  // into system RAM, crashing the machine.
  const AUTO_TIERS: ConcreteOrpheusTier[] = ['fast', 'moderate', 'light'];
  let tier: ConcreteOrpheusTier = 'light';
  for (const t of AUTO_TIERS) {
    const cap = VLLM_TIERS[t].capMB;
    // (a) TOTAL − cap ≥ headroom: because vLLM never takes more than `cap`, this much of
    //     the card ALWAYS stays free for the desktop — a hard guarantee against overflow.
    // (b) free ≥ cap: enough is free RIGHT NOW to grab the whole cap (else we'd reserve
    //     less and the guarantee wouldn't hold), so pick a smaller tier when busy.
    if (totalMB - cap >= DESKTOP_HEADROOM_MB && freeMB >= cap && fits(t, freeMB)) { tier = t; break; }
  }
  const viable = fits(tier, freeMB);
  return { tier, viable, freeMB, usedMB, reserveMB: Math.max(0, reservationMB(tier, freeMB)) };
}

/**
 * Resolve the effective concrete tier for a spawn. A user-picked concrete tier is
 * used verbatim; in auto mode we take the headroom-sized suggestion and clamp it to
 * the learned ceiling. (Viability is enforced separately by the GPU preflight.)
 */
export function resolveConcreteOrpheusTier(freeMB: number | null, totalMB: number | null): ConcreteOrpheusTier {
  const cfg = readConfig();
  if (cfg.tier !== 'auto') return cfg.tier;
  const { tier } = orpheusAutoSuggestion(freeMB, totalMB);
  return cfg.autoCeiling ? lowerOf(tier, cfg.autoCeiling) : tier;
}

/** Human label for a tier ('light' → 'Light'). */
export function orpheusTierLabel(tier: ConcreteOrpheusTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Step DOWN from `start` (or lighter) to the highest tier whose bounded reservation
 * still holds Orpheus's weights+KV floor at the current free VRAM — so instead of
 * refusing a too-full GPU, we run at the best level it can actually manage. `fits`
 * is false only when even the lightest tier can't hold the floor (the caller may run
 * it anyway and let vLLM fail cleanly, but should warn). VRAM unknown ⇒ keep `start`.
 */
export function fitOrpheusTier(
  start: ConcreteOrpheusTier,
  freeMB: number | null,
  totalMB: number | null,
): { tier: ConcreteOrpheusTier; reserveMB: number | null; fits: boolean; steppedDown: boolean } {
  if (freeMB == null || totalMB == null) {
    return { tier: start, reserveMB: null, fits: true, steppedDown: false };
  }
  const startIdx = Math.max(0, TIER_ORDER.indexOf(start));
  for (let i = startIdx; i < TIER_ORDER.length; i++) {
    const t = TIER_ORDER[i];
    if (fits(t, freeMB)) {
      return { tier: t, reserveMB: Math.round(reservationMB(t, freeMB)), fits: true, steppedDown: i > startIdx };
    }
  }
  const t: ConcreteOrpheusTier = 'light';
  return { tier: t, reserveMB: Math.max(0, Math.round(reservationMB(t, freeMB))), fits: false, steppedDown: true };
}

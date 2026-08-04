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
 *    the system. Two levers: batch width (peak ACTIVE ≈ 6.9 GB weights + 0.153 GB per
 *    slot — measured) and the MLX buffer-cache limit (the allocator's freed-buffer
 *    cache otherwise balloons to ~46 GB per chunk). The Mac tier maps to `batchSize`
 *    + `mlxCacheLimitGB`.
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
import {
  ORPHEUS_ADAPTER_HEADROOM_MB,
  orpheusMinVllmVramMB,
  type OrpheusServeArtifact,
} from './gpu-arbiter';

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
  /** MLX only (mac): MLX buffer-cache limit (GB) → ORPHEUS_MLX_CACHE_LIMIT_GB.
   *  Bounds the allocator's freed-buffer cache, which otherwise grows ~46 GB
   *  over a batched chunk (the real Mac memory-pressure source). */
  mlxCacheLimitGB: number;
  /** MLX only (mac): total unified-memory budget (GB) a batch may occupy →
   *  ORPHEUS_MLX_MEM_BUDGET_GB. orpheus.py narrows batch WIDTH from the batch's
   *  own token depth to stay inside it (see the MLX_TIERS note). */
  mlxMemBudgetGB: number;
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
//
// The numbers below are the MERGED-mode tiers and are unchanged. ADAPTER-mode spawns
// do not get their own table — they take these, shrink the RESERVATION by
// ORPHEUS_ADAPTER_HEADROOM_MB (see artifactHeadroomMB below and the identical
// subtraction in gpu-arbiter's computeSafeGpuUtil), because the resident LoRA
// and the punica workspace are allocated OUTSIDE vLLM's `gpu_memory_utilization`
// budget and would otherwise eat SNAC decode's slack (measured: a recoverable
// SNAC-decode OOM at util 0.70 with max_loras=1, step-1 A/B 2026-08-03) — and lift
// the CAP to ADAPTER_MIN_CAP_MB where the table value is below what that subtraction
// leaves servable (only 'light' is; see the arithmetic there).
const VLLM_TIERS: Record<ConcreteOrpheusTier, { capMB: number; marginMB: number; ceiling: number; vllmBatch: number }> = {
  extreme: { capMB: 18432, marginMB: 1024, ceiling: 0.95, vllmBatch: 96 }, // 18 GiB — KV ~10 GiB
  fast: { capMB: 13312, marginMB: 2048, ceiling: 0.88, vllmBatch: 64 },    // 13 GiB — KV ~5 GiB
  moderate: { capMB: 10240, marginMB: 2048, ceiling: 0.70, vllmBatch: 40 },// 10 GiB — KV ~2.4 GiB
  light: { capMB: 8704, marginMB: 2048, ceiling: 0.55, vllmBatch: 20 },    // 8.5 GiB — smaller KV
};

/**
 * VRAM this artifact form allocates OUTSIDE vLLM's reservation, and which therefore
 * has to be carved OFF the reservation. Merged = 0, so every merged number below is
 * literally unchanged. Kept in lockstep with computeSafeGpuUtil, which applies the
 * identical subtraction — the two must agree or the tier that "fits" here would OOM
 * at spawn.
 *
 * `vllmBatch` is deliberately NOT scaled down for adapters: it is the submission-width
 * THROUGHPUT lever, not a memory lever — vLLM never allocates past its reservation
 * regardless of batch (see the long note above), so a 1 GiB smaller KV pool costs
 * occasional preemption, never an OOM.
 */
function artifactHeadroomMB(artifact: OrpheusServeArtifact): number {
  return artifact === 'adapter' ? ORPHEUS_ADAPTER_HEADROOM_MB : 0;
}

/**
 * The SMALLEST total slice an adapter spawn can be given, and hence the floor under
 * every tier cap in adapter mode. The arithmetic is forced, not chosen:
 *
 *   reservation = min(capMB, free − marginMB) − ORPHEUS_ADAPTER_HEADROOM_MB
 *   fits ⟺ reservation ≥ orpheusMinVllmVramMB('adapter') = 8824
 *   ⇒ capMB ≥ 8824 + 1024 = 9848
 *
 * 'light' is capped at 8704 MB for merged, which is BELOW that — so with the merged
 * table alone `fits('light', …, 'adapter')` is unsatisfiable at ANY amount of free
 * VRAM and the lightest tier could never run an adapter voice. 9984 MB (9.75 GiB)
 * clears the bound with 136 MB to spare and is the only cap this raises; moderate
 * (10240), fast (13312) and extreme (18432) already clear it.
 *
 * MERGED SPAWNS ARE UNTOUCHED — this floor is applied only when artifact==='adapter',
 * so 'light' still reserves at most 8704 MB for a merged voice exactly as before.
 */
const ADAPTER_MIN_CAP_MB = 9984;

/**
 * A tier's absolute VRAM cap for the artifact form being served. Merged returns the
 * table value verbatim; adapter lifts it to ADAPTER_MIN_CAP_MB when the table value
 * is below the satisfiability bound (only 'light' is).
 */
function tierCapMB(t: ConcreteOrpheusTier, artifact: OrpheusServeArtifact): number {
  const cap = VLLM_TIERS[t].capMB;
  return artifact === 'adapter' ? Math.max(cap, ADAPTER_MIN_CAP_MB) : cap;
}

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

// MLX levers (macOS): batch width + buffer-cache limit, which together bound the
// unified-memory footprint. MEASURED (M1 Ultra 64 GB, Jul 2026, real book
// sentences): peak ACTIVE memory ≈ 6.9 GB weights + 0.153 GB per batch slot, and
// throughput 12.4 sent/min at width 16 → 22.8 at 48 → 27-28 at 96, with the KNEE
// at 96 (width 128 measured SLOWER — 24.1 — with worse SNAC-decode overhead). So
// 'extreme' stays 96 and heavier widths are pointless on any Mac.
// cacheLimitGB feeds ORPHEUS_MLX_CACHE_LIMIT_GB → mx.set_cache_limit at engine
// load: without it the MLX allocator's freed-buffer cache balloons to ~46 GB over
// a single chunk (the real memory-pressure spike — active memory was never the
// problem). Bounding it is throughput-NEUTRAL-to-positive (28.1 sent/min at
// width 96 with an 8 GB cap vs 27.2 with the old per-chunk full flush).
//
// CORRECTION (Jul 2026): the "0.153 GB per batch slot" above is ~2x understated
// for real books. It was measured on chunks that never approached the token cap;
// KV actually costs a MEASURED 0.1147 MB per generated token per row, so the
// footprint scales with width × DEPTH, and a 75-row batch at the 3700-token cap
// really peaked at 36.8 GB. The old formula would have promised ~30 GB for
// 'extreme' — every Mac tier was overcommitted by roughly 2x.
//
// Rather than shrink batchSize (which would cost throughput on the SHORT batches
// that were never the problem), the fork now derives each batch's width from that
// batch's own token depth against a memory budget — memBudgetGB below, passed as
// ORPHEUS_MLX_MEM_BUDGET_GB and consumed by orpheus.py `_mlx_width_for_depth`:
//
//   width × depth × 0.1147 MB + 6.9 GB weights + cacheLimitGB ≤ memBudgetGB
//
// batchSize stays the CEILING (throughput knee, still 96 — width 128 measured
// slower), and a deep batch narrows itself. At the full 3700-token depth that
// yields: extreme 96 rows (~55 GB worst case), fast 46 (~34), moderate 22 (~22),
// light 7 (~13). Shallow batches keep the full tier width.
//
// Budgets are set against the RAM band that selects the tier (≥60 / ≥44 / ≥28 /
// below), leaving room for the desktop: a budget above the machine's RAM is not a
// budget, and this is unified memory — overshoot means swap, not a clean failure.
//
// extreme = 55, not 45: 55 is exactly the budget where full width 96 survives even
// at worst-case depth, and the worst case is a bound the fleet never reaches — the
// depth term assumes EVERY row generates to its cap, but rows EOS far earlier
// (measured real-book peak at width 96: 26.9 GB vs the 55 GB bound, 42.1 vs 38.1
// sent/min against the width-48 conservative config, same WER). A ≥60 GB machine
// accepts a ≤55 GB worst case; owner-confirmed tradeoff (Jul 2026).
const MLX_TIERS: Record<
  ConcreteOrpheusTier,
  { batchSize: number; cacheLimitGB: number; memBudgetGB: number }
> = {
  extreme: { batchSize: 96, cacheLimitGB: 8, memBudgetGB: 55 },
  fast: { batchSize: 72, cacheLimitGB: 8, memBudgetGB: 34 },
  moderate: { batchSize: 48, cacheLimitGB: 6, memBudgetGB: 22 },
  light: { batchSize: 24, cacheLimitGB: 3, memBudgetGB: 13 },
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
  // CLI/dev seam: ORPHEUS_MEMORY_TIER forces the tier for this process without touching
  // the user's persisted orpheus-memory.json (mirrors BOOKFORGE_ORPHEUS_MODELS_DIR).
  // Never cached, never persisted. Invalid value fails loud — no silent fallback.
  const envTier = process.env.ORPHEUS_MEMORY_TIER?.trim();
  if (envTier) {
    if (!isTier(envTier)) {
      throw new Error(`ORPHEUS_MEMORY_TIER='${envTier}' is not a valid tier (auto|extreme|fast|moderate|light)`);
    }
    return { tier: envTier as OrpheusMemoryTier };
  }
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
export function orpheusMemoryProfile(
  tier: ConcreteOrpheusTier,
  artifact: OrpheusServeArtifact = 'merged',
): OrpheusMemoryProfile {
  const t = isConcrete(tier) ? tier : 'moderate';
  const mlx = MLX_TIERS[t];
  return {
    tier: t, ...VLLM_TIERS[t],
    // Adapter mode lifts 'light' to the satisfiability floor (see ADAPTER_MIN_CAP_MB);
    // every other tier and every merged spawn gets the table value unchanged.
    capMB: tierCapMB(t, artifact),
    batchSize: mlx.batchSize,
    mlxCacheLimitGB: mlx.cacheLimitGB,
    mlxMemBudgetGB: mlx.memBudgetGB,
  };
}

// ── Auto resolution ──────────────────────────────────────────────────────────
//
// Orpheus takes an ABSOLUTE, bounded slice of VRAM (its tier cap) and leaves the
// rest for Chrome/the desktop. So auto just picks the largest tier whose cap still
// leaves DESKTOP_HEADROOM_MB free — plus 'extreme' under a strict idle gate (cap +
// slack free right now), since that's the proven max-throughput config for overnight
// runs. If the card is too full to even hold Orpheus's weights+KV floor, it reports
// viable:false so the caller refuses to launch instead of crashing.

/** Can we actually fit this tier's reservation right now? min(cap, free − margin),
 *  less anything this artifact form allocates outside the reservation, must still
 *  cover weights+KV. Merged subtracts 0 and compares against the same 8200 MB floor
 *  as before. */
function reservationMB(t: ConcreteOrpheusTier, freeMB: number, artifact: OrpheusServeArtifact = 'merged'): number {
  return Math.min(tierCapMB(t, artifact), freeMB - VLLM_TIERS[t].marginMB) - artifactHeadroomMB(artifact);
}
function fits(t: ConcreteOrpheusTier, freeMB: number, artifact: OrpheusServeArtifact = 'merged'): boolean {
  return reservationMB(t, freeMB, artifact) >= orpheusMinVllmVramMB(artifact);
}

/**
 * A full auto suggestion for the current GPU: which concrete tier to use, whether the
 * GPU can run Orpheus at all, and the raw numbers (for the UI). `viable:false` means
 * even the smallest tier can't hold weights+KV right now — the caller must NOT launch
 * on GPU (offer CPU / "close apps" instead of crashing). When VRAM is unknown (mac /
 * no nvidia-smi) fall back to system RAM (mac) or a safe 'moderate' and assume viable.
 */
export function orpheusAutoSuggestion(
  freeMB: number | null,
  totalMB: number | null,
  artifact: OrpheusServeArtifact = 'merged',
): {
  tier: ConcreteOrpheusTier;
  viable: boolean;
  freeMB: number | null;
  usedMB: number | null;
  /** The absolute VRAM (MB) Orpheus will reserve at this tier, for the UI. */
  reserveMB: number | null;
} {
  // No VRAM reading: mac uses unified-RAM bands; elsewhere pick a safe middle.
  // Mac bands sized from the measured footprint (≈ 6.9 GB weights + 0.153 GB ×
  // batch + cache limit): extreme ≈ 30 GB → needs a 64 GB machine; fast ≈ 26 GB
  // → 48 GB; moderate ≈ 20 GB → 32 GB; light ≈ 14.5 GB below that. Width 96 is
  // the measured throughput knee, so extreme is the fastest config, full stop —
  // a 64 GB Mac should get it (the old bands topped out at 'fast', leaving ~10%
  // throughput on the table).
  if (freeMB == null || totalMB == null) {
    if (process.platform === 'darwin') {
      const ram = Math.round(os.totalmem() / (1024 * 1024));
      const t = ram >= 60_000 ? 'extreme' : ram >= 44_000 ? 'fast' : ram >= 28_000 ? 'moderate' : 'light';
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
  if (freeMB >= tierCapMB('extreme', artifact) + EXTREME_IDLE_SLACK_MB && fits('extreme', freeMB, artifact)) {
    return { tier: 'extreme', viable: true, freeMB, usedMB, reserveMB: Math.max(0, reservationMB('extreme', freeMB, artifact)) };
  }
  // Largest tier whose cap leaves DESKTOP_HEADROOM_MB free AND still holds the floor.
  // Auto otherwise tops out at 'fast' (~13 GiB): on a desktop-shared 24 GB GPU that
  // leaves ~11 GiB for Windows + the app + the browser at their PEAK — 16-19 GiB
  // oversubscribed the shared card while loaded and Windows WDDM spilled GPU memory
  // into system RAM, crashing the machine.
  const AUTO_TIERS: ConcreteOrpheusTier[] = ['fast', 'moderate', 'light'];
  let tier: ConcreteOrpheusTier = 'light';
  for (const t of AUTO_TIERS) {
    const cap = tierCapMB(t, artifact);
    // (a) TOTAL − cap ≥ headroom: because vLLM never takes more than `cap`, this much of
    //     the card ALWAYS stays free for the desktop — a hard guarantee against overflow.
    // (b) free ≥ cap: enough is free RIGHT NOW to grab the whole cap (else we'd reserve
    //     less and the guarantee wouldn't hold), so pick a smaller tier when busy.
    if (totalMB - cap >= DESKTOP_HEADROOM_MB && freeMB >= cap && fits(t, freeMB, artifact)) { tier = t; break; }
  }
  const viable = fits(tier, freeMB, artifact);
  return { tier, viable, freeMB, usedMB, reserveMB: Math.max(0, reservationMB(tier, freeMB, artifact)) };
}

/**
 * Resolve the effective concrete tier for a spawn. A user-picked concrete tier is
 * used verbatim; in auto mode we take the headroom-sized suggestion and clamp it to
 * the learned ceiling. (Viability is enforced separately by the GPU preflight.)
 */
export function resolveConcreteOrpheusTier(
  freeMB: number | null,
  totalMB: number | null,
  artifact: OrpheusServeArtifact = 'merged',
): ConcreteOrpheusTier {
  const cfg = readConfig();
  if (cfg.tier !== 'auto') return cfg.tier;
  const { tier } = orpheusAutoSuggestion(freeMB, totalMB, artifact);
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
  artifact: OrpheusServeArtifact = 'merged',
): { tier: ConcreteOrpheusTier; reserveMB: number | null; fits: boolean; steppedDown: boolean } {
  if (freeMB == null || totalMB == null) {
    return { tier: start, reserveMB: null, fits: true, steppedDown: false };
  }
  const startIdx = Math.max(0, TIER_ORDER.indexOf(start));
  for (let i = startIdx; i < TIER_ORDER.length; i++) {
    const t = TIER_ORDER[i];
    if (fits(t, freeMB, artifact)) {
      return { tier: t, reserveMB: Math.round(reservationMB(t, freeMB, artifact)), fits: true, steppedDown: i > startIdx };
    }
  }
  const t: ConcreteOrpheusTier = 'light';
  return { tier: t, reserveMB: Math.max(0, Math.round(reservationMB(t, freeMB, artifact))), fits: false, steppedDown: true };
}

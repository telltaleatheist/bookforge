/**
 * Folder-discovered custom Orpheus models, backed by a local manifest.
 *
 * Two artifact forms live side by side under `<orpheusModelsDir>/`:
 *
 *   <id>/                       MERGED voice — a full 6.6 GB fine-tune
 *                               (config.json + *.safetensors). The legacy layout.
 *   adapters/<id>/              ADAPTER voice — a ~0.4 GB LoRA
 *                               (adapter_config.json + adapter_model.safetensors)
 *                               that is served on top of…
 *   _base/<base-folder>/        …the ONE shared base model every adapter rides on
 *                               (config.json + *.safetensors), e.g.
 *                               `_base/orpheus-3b-0.1-ft`.
 *
 * All three are catalogued in a `models.json` manifest in that same dir. The
 * manifest is the source of truth for the things the filesystem can't tell us —
 * above all the **prompt token** the model was fine-tuned on (e.g. `owen:`), which
 * often differs from the folder name for third-party models. It also records the
 * source (HF repo / URL) so a voice can be re-pulled, plus label/format/sample-rate,
 * and (new) the `kind` / `artifact` / `base` discriminators described on
 * OrpheusManifestEntry.
 *
 * Discovery is manifest-first, with a reconcile fallback: any folder that is a
 * valid model (merged voice, adapter voice, or base) but missing from the manifest
 * is still offered, so manually-dropped folders — and a machine whose adapters were
 * rsync'd in by the deploy script — keep working with no re-download.
 *
 * BACKWARD COMPATIBILITY IS STRUCTURAL. A machine that only ever installed merged
 * voices has no `adapters/` and no `_base/`, so every predicate below sees exactly
 * what it saw before and every resolved model comes back `artifact: 'merged'` with
 * the same `dir`. Nothing about that path changed.
 *
 * The catalogue of what's *available to download* lives on HuggingFace (see
 * orpheus-hf-catalog.ts); installing a voice writes its files here and upserts a
 * manifest entry. This module only concerns what's installed locally.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig, getOrpheusStreamingArtifact } from './tool-paths';
import { isWslAliveCached, wslWedgedMessage, isWslWedged } from './wsl-lifecycle';

/** True when a path lives on a \\wsl$ / \\wsl.localhost UNC mount. */
function isWslUnc(p: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(p);
}

/**
 * Every fs call in this module is SYNCHRONOUS, and the models dir is typically a
 * \\wsl$ UNC path on Windows+WSL setups. When the WSL VM is wedged (kernel-stuck),
 * a sync fs touch of \\wsl$ blocks the Electron MAIN THREAD forever — the renderer's
 * invoke()s never return and the app white-screens. So every entry point below must
 * check this gate BEFORE touching the filesystem. Uses the cached liveness probe
 * (kicks a background refresh when stale) because these call sites can't await.
 */
function orpheusDirAccessible(): boolean {
  const dir = getOrpheusModelsDir();
  if (process.platform !== 'win32' || !isWslUnc(dir)) return true;
  return isWslAliveCached();
}

/**
 * The tunable Orpheus caps a voice can declare. Used both at the voice level (flat
 * on the manifest entry / model, applying to every backend) and inside the per-backend
 * `backends` overlay (see below), where a field overrides the flat value FOR THAT
 * BACKEND ONLY. Every field is optional and "absent means unset" — NO FALLBACK, we
 * never invent a default here; e2a's own default rules when a field is absent.
 */
export interface OrpheusVoiceCaps {
  /** PREP packing cap in chars (→ ORPHEUS_MAX_CHARS). */
  maxChars?: number;
  /** GENERATION truncation-guard rate in chars/sec (→ ORPHEUS_MAX_CHARS_PER_SEC). */
  maxCharsPerSec?: number;
  /**
   * Deterministic inter-clip silence baked onto each rendered chunk in seconds
   * (→ ORPHEUS_SENTENCE_GAP, read by orpheus.py `_classify_gap`).
   *
   * 0 means CONCATENATE: no pad is appended, so a chunk join is the model's own
   * trained tail. That is the wanted behaviour for any voice trained on verbatim
   * tails — e2a's 0.6 s default would otherwise be baked in at render time and
   * then detected-and-stripped again at assembly. An explicit `[pause:X]` in the
   * text is still honoured at 0.
   */
  sentenceGap?: number;
  /**
   * FLOOR on the trailing silence of every chunk, in seconds (assembly-time).
   * With no artificial pad, a chunk join IS the model's own trained tail, and
   * that tail VARIES — measured over 1151 chunks of The Mysterious Stranger it
   * ran median 0.81 s but p10 0.39 s and MIN 0.00 s, and the short ones collide
   * audibly. This tops a clip up to the floor and leaves longer tails untouched,
   * so it lifts only the collisions instead of stretching every join the way an
   * additive `sentenceGap` would. Absent/0 = no floor.
   */
  minChunkGap?: number;
  /** Repetition penalty (→ ORPHEUS_REP_PENALTY). */
  repPenalty?: number;
  /**
   * EOS logit boost in logit units (→ ORPHEUS_EOS_BOOST). vLLM-only (e2a ignores
   * it on MLX). For bed-free fine-tunes with a thin greedy end-of-speech margin:
   * once generation passes eosBoostStart x the chunk's expected token count, the
   * EOS logit gets this bias (ramping with overrun). 0/absent = off. Gate any
   * value with the greedy 20-chunk probe + an endings ear-check before deploy.
   */
  eosBoost?: number;
  /** Overrun threshold as a multiple of expected tokens (→ ORPHEUS_EOS_BOOST_START, e2a default 1.2). */
  eosBoostStart?: number;
}

/**
 * Which artifact form a voice is SERVED from.
 *
 *  - `merged`  — a full fine-tune folder loaded as the model itself
 *                (`--orpheus_model_dir`). The legacy, pre-adapter path.
 *  - `adapter` — a LoRA folder served on top of the shared base
 *                (`--orpheus_base_dir` + `--orpheus_adapter_dir`).
 *
 * ABSENT on a manifest/catalog entry means MERGED — that is what makes the
 * migration structurally backward-compatible.
 */
export type OrpheusArtifact = 'merged' | 'adapter';

/**
 * WHY a voice is being resolved, which is what decides the artifact form when BOTH are
 * installed. The two render paths want opposite defaults and both are right:
 *
 *   'batch'   the audiobook workers (parallel-tts-bridge). Always MERGED. One voice per
 *             worker process, hours of decode, no voice switching — so nothing is gained
 *             from the shared base and everything from skipping vLLM's LoRA path, which
 *             adds two rank-64 GEMMs per targeted projection per token (196 on this 3B).
 *   'stream'  the resident streaming server (orpheus-worker-pool) and every client of it
 *             — the /listen player, the TTS API server, the browser extension. CONFIGURABLE
 *             via `orpheusStreamingArtifact` in tool-paths.json, default MERGED.
 *
 *             This one is a judgement call rather than an obvious win, which is why it is
 *             a setting. The adapter buys warm voice switching (a LoRA registration
 *             instead of a ~6.2 GB reload plus CUDA-graph recapture) and per-request
 *             casting; merged buys ~10-20% fewer GEMMs on every token. Owen chose merged
 *             on 2026-08-10: a "warm" switch still waits ~20-30 s for the next sentence,
 *             so it was never the instant switch the shared base implied, while the
 *             per-token saving lands on every sentence of every session. Flip the setting
 *             to 'adapter' to get the old behaviour back — both forms stay installed, so
 *             nothing is re-downloaded.
 *
 * The two forms are the same model, not an approximation of each other: verified
 * 2026-08-09 by range-reading the deployed merged checkpoints and diffing them against a
 * local fuse of base+adapter — 28.3 M sampled elements per voice, zero differing. So
 * serving one when the other is absent is NOT the kind of substitution the NO-FALLBACK
 * rule forbids; what stays forbidden is serving a voice whose BASE is missing.
 */
export type OrpheusServePurpose = 'batch' | 'stream';

/** The shared base model an adapter voice rides on. */
export interface OrpheusBaseRef {
  /** Stable catalog id for the base, e.g. `orpheus-3b-base`. */
  id: string;
  /** HuggingFace repo the base is pulled from, e.g. `unsloth/orpheus-3b-0.1-ft`. */
  ref: string;
  /** Folder name under `<models>/_base/`. Absent ⇒ the short name of `ref`. */
  dir?: string;
}

/** The `adapters/` and `_base/` subdirs of the models root are LAYOUT, not voices. */
export const ADAPTERS_SUBDIR = 'adapters';
export const BASE_SUBDIR = '_base';
/**
 * Scratch root for the macOS fuse (`<models>/.fusework/<id>/`), where orpheus_fuse.py
 * BUILDS a fused voice before renaming it into place. It holds a full model shape mid-run
 * — config.json lands with the shards — which is exactly what isMergedModelFolder looks
 * for, so it must never be scanned: a killed fuse would otherwise be adopted as a voice
 * named `.fusework` and rendered with `--fine_tuned .fusework`, a token no model was
 * trained on. Kept OUT of the way by LOCATION (one dotted dir, skipped below) rather than
 * by a per-folder content check, so it stays inert no matter how complete the half-written
 * model inside it looks.
 */
export const FUSEWORK_SUBDIR = '.fusework';
/**
 * Suffix the SUPERSEDED copy of a voice wears for the few milliseconds of a crash-safe
 * promote (`<id>` → `<id>.previous` → deleted; see orpheus_fuse.py promote()). A kill in
 * that window leaves it on disk holding a complete, valid model — so it is skipped for
 * the same reason `.fusework` is: it is a real model that is not a real voice.
 */
export const PREVIOUS_SUFFIX = '.previous';
/**
 * Names the top-level merged-folder scan skips: the layout dirs (they hold adapters / the
 * base), the fuse scratch dir, and any leftover `.previous` backup.
 */
const LAYOUT_SUBDIRS = new Set<string>([ADAPTERS_SUBDIR, BASE_SUBDIR, FUSEWORK_SUBDIR]);
function isScannableVoiceFolder(name: string): boolean {
  return !LAYOUT_SUBDIRS.has(name) && !name.endsWith(PREVIOUS_SUFFIX);
}

/** A resolved, loadable custom voice. */
export interface OrpheusModel {
  /** Dropdown value / folder id. */
  id: string;
  /** Human label, e.g. "Owen Morgan". */
  label: string;
  /** The prompt token (`--fine_tuned`). From the manifest; may differ from id. */
  voice: string;
  /**
   * Absolute path to the voice's own folder. For `artifact: 'merged'` this is the
   * full model dir (`--orpheus_model_dir`) exactly as before; for
   * `artifact: 'adapter'` it is the LoRA folder (`--orpheus_adapter_dir`), which is
   * NOT loadable on its own — pair it with `baseDir`.
   */
  dir: string;
  /**
   * How this voice is served. ALWAYS set on a resolved model (never absent), so a
   * consumer that forgets to branch gets a value it can assert on rather than a
   * silent undefined. Legacy merged installs resolve to `'merged'`.
   */
  artifact: OrpheusArtifact;
  /**
   * Absolute path to the shared base model (`--orpheus_base_dir`). Present ONLY for
   * `artifact: 'adapter'`, and only when the base is actually installed — an adapter
   * voice whose base is missing THROWS out of resolveOrpheusModel rather than
   * resolving without it (see the resolution doc block).
   */
  baseDir?: string;
  /** The base reference this adapter declares. Present only for `artifact: 'adapter'`. */
  base?: OrpheusBaseRef;
  /**
   * LISTING-ONLY flag: this is an adapter voice whose base model is not installed, so
   * it cannot render. `listOrpheusModels` sets it instead of throwing (a broken voice
   * must stay VISIBLE so the UI can say "install the base model"); the RENDER path,
   * `resolveOrpheusModel`, throws for the same voice. Never set for merged voices.
   *
   * CONSUMED BY exactly one surface: the Settings Orpheus voices panel, which reads it
   * through `orpheusModels.list` and shows the voice as unusable ("Needs the base
   * model") with its install action pointing at the base. EVERY OTHER surface keeps the
   * loud throw and must not learn about this flag — starting an audiobook job
   * (pushVoiceArgs → resolveOrpheusModel) and loading a streaming voice both fail the
   * request with the base-missing message, which is the correct behaviour: the point of
   * the annotation is to explain a broken voice in a list, never to let one be USED.
   */
  baseMissing?: true;
  /**
   * Per-voice packing cap (chars) — the PREP-time sentence-packing limit for this
   * fine-tune (→ ORPHEUS_MAX_CHARS). Voice-level, ALL backends; a per-backend value
   * can override via `backends.<name>.maxChars`. Optional: absent means the voice
   * declares no cap and e2a's default applies. An EOS-weak fine-tune that runs away
   * past ~300 chars sets a smaller cap here. Only present when the manifest declares it.
   */
  maxChars?: number;
  /**
   * Per-voice generation guard threshold (chars/sec) — the truncation-guard rate
   * for this fine-tune (→ ORPHEUS_MAX_CHARS_PER_SEC). Voice-level, ALL backends;
   * override per-backend via `backends.<name>.maxCharsPerSec`. Optional: absent means
   * e2a's default (19.0) applies. A fast-reading voice (~20 ch/s natural rate) raises
   * this so honest fast reads aren't flagged as runaways. Only present when declared.
   */
  maxCharsPerSec?: number;
  /**
   * Per-voice repetition penalty (→ ORPHEUS_REP_PENALTY). Voice-level, ALL backends —
   * which is usually WRONG for this field: the silence-loop runaway it fixes is
   * vLLM-only, so prefer `backends.vllm.repPenalty` (see `backends` below). A flat
   * value here applies on MLX too and MLX pays prosody for a fix it doesn't need.
   * Optional: absent means e2a's default (1.1) applies. Probe-validated 1.15 for the
   * CoD deathstalker; 1.2+ risks early-EOS truncation instead.
   */
  repPenalty?: number;
  /**
   * Per-BACKEND cap overlay. Fields declared under the active backend override the
   * flat voice-level caps above FOR THAT BACKEND ONLY; undeclared fields fall through
   * to the flat value (and, absent that, to e2a's default). This is THE mechanism for
   * backend-scoped tuning — chiefly `backends.vllm.repPenalty`, since the silence-loop
   * runaway is vLLM-only (vLLM 0.7.3 applies repetition penalty over the WHOLE sequence
   * and locks into an infinite silence-frame loop at 1.1; MLX's 20-token window renders
   * clean at the 1.1 default — probe-proven 2026-07-14). Backend is chosen the same way
   * e2a's orpheus.py picks it: MLX on macOS, vLLM everywhere else. Only present when
   * declared. Replaces the old "keep repPenalty out of the Mac manifest" convention —
   * one manifest entry is now safely deployable to any machine.
   */
  backends?: { vllm?: OrpheusVoiceCaps; mlx?: OrpheusVoiceCaps };
  /**
   * An ffmpeg audio-filter chain (the `-filter:a` / `-af` value) applied to this
   * voice's audio during the FINAL assembly encode — a per-voice corrective pass
   * (notch/EQ/expander) for the artifacts THIS fine-tune reproduces (e.g. SNAC
   * hiss-comb notches, a firequalizer tone curve). Voice-level only (all backends);
   * there is no per-backend override — the artifacts are the model's, not the
   * backend's. Optional: absent means no post-render filtering (behavior unchanged).
   * The string may contain `|`, `:`, `/`, and single quotes; it is passed to e2a as
   * a single CLI argument (`--post_render_filter`), never interpolated into a shell
   * string. See parallel-tts-bridge (runAssembly) / reassembly-bridge (startReassembly).
   */
  postRenderFilter?: string;
  /**
   * Per-voice DEFAULT inter-sentence gap in seconds, applied at ASSEMBLY time (not at
   * render). e2a bakes an artificial trailing exact-zero pad onto every rendered
   * sentence; the assembly-time gap step strips that pad and re-applies exactly this
   * much silence, so the effective inter-sentence gap matches the human source. Absent
   * means the voice declares no gap default (assembly leaves the raw sentences unchanged
   * — legacy behavior, NO invented default). See reassembly-bridge (startReassembly) and
   * denoise-bridge (normalizeSentenceGaps).
   */
  sentenceGap?: number;
  /**
   * FLOOR on the trailing silence of every chunk, in seconds (assembly-time).
   * With no artificial pad, a chunk join IS the model's own trained tail, and
   * that tail VARIES — measured over 1151 chunks of The Mysterious Stranger it
   * ran median 0.81 s but p10 0.39 s and MIN 0.00 s, and the short ones collide
   * audibly. This tops a clip up to the floor and leaves longer tails untouched,
   * so it lifts only the collisions instead of stretching every join the way an
   * additive `sentenceGap` would. Absent/0 = no floor.
   */
  minChunkGap?: number;
  /**
   * Reference-only: the MEASURED natural inter-sentence gap (seconds) of this voice's
   * training source, recorded so a human can pick a sensible `sentenceGap`. Never
   * consumed by the pipeline — carried through verbatim for tooling/inspection.
   */
  measuredSentenceGapS?: number;
}

/** One installed-model record in models.json. */
export interface OrpheusManifestEntry {
  /** Folder id (and dropdown value). */
  id: string;
  /** Display label. */
  label: string;
  /** The prompt token the model was fine-tuned on — the thing we can't guess. */
  token: string;
  /**
   * What this record IS. Absent ⇒ `'voice'` (every pre-adapter entry, so the
   * discriminator is additive). `'base'` records the ONE shared base model under
   * `_base/<dir>`; base records are never offered as voices and never carry a token
   * that means anything.
   */
  kind?: 'voice' | 'base';
  /**
   * PIN of which artifact form this voice is served from, overriding the caller's
   * purpose. Absent is now the NORMAL state, not a default-to-one-form: both artifacts
   * are expected to be installed, and which one serves depends on WHY it is being
   * resolved (see OrpheusServePurpose).
   *
   * Having BOTH forms installed is the designed steady state, not a migration artifact:
   * the batch workers render from the merged copy and the resident streaming server
   * swaps adapters on a warm engine. There is still exactly ONE manifest entry per
   * voice; this field only pins it against the purpose:
   *
   *   both installed + `artifact: 'merged'`   → the merged folder (explicit pin)
   *   both installed + `artifact: 'adapter'`  → the adapter (explicit pin)
   *   both installed + artifact ABSENT        → purpose decides: batch→merged, stream→adapter
   *   only one installed                      → that one, whatever this field says
   *
   * The last line is NOT a fallback: a voice installed in exactly one form has only
   * one thing to serve, and the two forms are the same weights (verified 2026-08-09,
   * 28.3 M sampled elements, zero differing). What is explicitly forbidden is serving a
   * MERGED copy because an adapter's BASE is missing — that throws (see
   * resolveOrpheusModel).
   */
  artifact?: OrpheusArtifact;
  /** Folder name under the models dir for the MERGED install (defaults to id). */
  dir?: string;
  /** Folder name under `<models>/adapters/` for the ADAPTER install (defaults to id). */
  adapterDir?: string;
  /**
   * The shared base an ADAPTER voice rides on. Required to serve `artifact:'adapter'`
   * — an adapter entry with no base declaration fails resolution loudly rather than
   * guessing a base. Ignored for merged voices. On a `kind: 'base'` record this is
   * the base's own identity.
   */
  base?: OrpheusBaseRef;
  /** Model format. */
  format?: 'hf' | 'mlx';
  /** Native sample rate (Orpheus = 24000). */
  sampleRate?: number;
  /**
   * Per-voice PREP packing cap in chars (→ ORPHEUS_MAX_CHARS). Voice-level, all
   * backends; per-backend override via `backends.<name>.maxChars`. Optional — a lower
   * value for EOS-weak fine-tunes that run away on long chunks. Absent means "unset":
   * e2a's default applies (NO FALLBACK — we never invent one).
   */
  maxChars?: number;
  /**
   * Per-voice GENERATION truncation-guard threshold in chars/sec
   * (→ ORPHEUS_MAX_CHARS_PER_SEC). Voice-level, all backends; per-backend override via
   * `backends.<name>.maxCharsPerSec`. Optional — a higher value for genuinely
   * fast-reading voices. Absent means "unset": e2a's 19.0 default applies.
   */
  maxCharsPerSec?: number;
  /**
   * Per-voice repetition penalty (→ ORPHEUS_REP_PENALTY). Voice-level, all backends —
   * usually the WRONG scope for this field: the silence-loop runaway it fixes is
   * vLLM-only, so prefer `backends.vllm.repPenalty` instead. A flat value here applies
   * on MLX too, which doesn't need it and pays prosody for it. Optional — absent means
   * "unset": e2a's 1.1 default applies.
   */
  repPenalty?: number;
  /**
   * Per-BACKEND cap overlay: `{ vllm?: {...caps}, mlx?: {...caps} }`. Fields under the
   * active backend override the flat voice-level caps above FOR THAT BACKEND ONLY;
   * undeclared fields fall through to the flat value (and then e2a's default). This is
   * THE mechanism for backend-scoped tuning and REPLACES the old per-MACHINE manifest
   * split — one entry is now safely deployable to any machine, backend picked exactly
   * as e2a's orpheus.py picks it (MLX on macOS, vLLM everywhere else). The canonical
   * use is `backends.vllm.repPenalty`: vLLM 0.7.3's whole-sequence repetition penalty
   * locks an EOS-weak fine-tune into an infinite silence-frame loop at the 1.1 default
   * (1.15 breaks it for the CoD deathstalker; 1.2+ overshoots to early-EOS), while
   * MLX's 20-token window renders clean at 1.1 — probe-proven 2026-07-14, so MLX must
   * NOT inherit the higher value. Optional — absent fields stay unset (NO FALLBACK).
   */
  backends?: { vllm?: OrpheusVoiceCaps; mlx?: OrpheusVoiceCaps };
  /**
   * Per-voice ffmpeg audio-filter chain applied at the FINAL assembly encode
   * (→ e2a `--post_render_filter` → the export `-af` chain, before loudnorm). A
   * corrective pass for the artifacts THIS fine-tune reproduces (notch/EQ/expander).
   * Optional — absent means no post-render filtering (zero behavioral change). The
   * string may contain shell-special chars (`|`, `:`, `/`, single quotes) and is
   * always passed as a single spawn argument, never through a shell string.
   */
  postRenderFilter?: string;
  /**
   * Per-voice DEFAULT inter-sentence gap in seconds, applied at ASSEMBLY time
   * (→ the gap-normalize step in reassembly-bridge, which strips e2a's artificial
   * trailing exact-zero pad and re-applies this much silence). Optional — absent means
   * "unset": assembly leaves the raw sentences unchanged (NO FALLBACK, no invented gap).
   */
  sentenceGap?: number;
  /**
   * FLOOR on the trailing silence of every chunk, in seconds (assembly-time).
   * With no artificial pad, a chunk join IS the model's own trained tail, and
   * that tail VARIES — measured over 1151 chunks of The Mysterious Stranger it
   * ran median 0.81 s but p10 0.39 s and MIN 0.00 s, and the short ones collide
   * audibly. This tops a clip up to the floor and leaves longer tails untouched,
   * so it lifts only the collisions instead of stretching every join the way an
   * additive `sentenceGap` would. Absent/0 = no floor.
   */
  minChunkGap?: number;
  /**
   * Reference-only measured natural inter-sentence gap (seconds) of the training source.
   * Recorded to inform a human's `sentenceGap` choice; never consumed by the pipeline.
   */
  measuredSentenceGapS?: number;
  /** Where it came from, so it can be re-pulled / updated. */
  source?: { type: 'hf' | 'url' | 'local'; ref?: string };
  license?: string;
  /** ISO date string (stamped by the installer; we never call Date in tests). */
  addedAt?: string;
}

interface OrpheusManifest {
  version: number;
  models: OrpheusManifestEntry[];
}

const MANIFEST_NAME = 'models.json';
const MANIFEST_VERSION = 1;

/**
 * The custom-Orpheus models root.
 *
 * Resolution order: BOOKFORGE_ORPHEUS_MODELS_DIR env (dev seam) → the persisted
 * Settings value (Settings → Tools → "Orpheus models directory") → the default
 * <userData>/runtime/orpheus-models. On Windows+WSL the Settings value is typically
 * a \\wsl$\... UNC path so the model loads off WSL-native ext4; the WSL spawn
 * translates the UNC path to /home/... (see isWslUncPath/uncToWslPath in the bridge).
 */
export function getOrpheusModelsDir(): string {
  const override = process.env.BOOKFORGE_ORPHEUS_MODELS_DIR?.trim();
  if (override) return override;
  const configured = getConfig().orpheusModelsDir?.trim();
  if (configured) return configured;
  return path.join(app.getPath('userData'), 'runtime', 'orpheus-models');
}

function manifestPath(): string {
  return path.join(getOrpheusModelsDir(), MANIFEST_NAME);
}

/** Read models.json (tolerant: missing/corrupt → empty manifest). */
export function readManifest(): OrpheusManifest {
  if (!orpheusDirAccessible()) {
    console.warn('[ORPHEUS-MODELS] readManifest skipped — WSL not responding (models dir is \\\\wsl$)');
    return { version: MANIFEST_VERSION, models: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    if (parsed && Array.isArray(parsed.models)) {
      return { version: parsed.version || MANIFEST_VERSION, models: parsed.models };
    }
  } catch {
    /* no manifest yet, or unreadable (e.g. WSL down for a \\wsl$ path) */
  }
  return { version: MANIFEST_VERSION, models: [] };
}

/** Write models.json (creates the dir if needed). Throws when the models dir is a
 *  \\wsl$ path and WSL isn't responding — a sync mkdir there would hang the main
 *  thread forever (the white-screen bug), and silently skipping a write would lose
 *  the manifest update. */
export function writeManifest(models: OrpheusManifestEntry[]): void {
  if (!orpheusDirAccessible()) {
    throw new Error(isWslWedged() ? wslWedgedMessage() : 'WSL is not responding — cannot write to the Orpheus models directory (\\\\wsl$).');
  }
  fs.mkdirSync(getOrpheusModelsDir(), { recursive: true });
  const data: OrpheusManifest = { version: MANIFEST_VERSION, models };
  fs.writeFileSync(manifestPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** Insert or replace a manifest entry by id. */
export function upsertManifestEntry(entry: OrpheusManifestEntry): void {
  const models = readManifest().models;
  const i = models.findIndex((e) => e.id === entry.id);
  if (i >= 0) models[i] = entry;
  else models.push(entry);
  writeManifest(models);
}

/** Remove a manifest entry by id (does NOT delete the folder). */
export function removeManifestEntry(id: string): void {
  writeManifest(readManifest().models.filter((e) => e.id !== id));
}

/**
 * Load the repo-tracked CURATED tuning catalog (electron/data/orpheus-models.json), keyed
 * by voice id. Machine-independent tuning (label, token, caps, backends, postRenderFilter,
 * sentenceGap, measuredSentenceGapS, …) that OVERLAYS the per-machine runtime install
 * manifest, so a `git push` propagates identical tuning to every machine (Windows/WSL/Mac).
 * The file ships next to this module in the dist build (build:electron `shx cp -r
 * electron/data`), resolving relative to __dirname — the same way the voice-sources data
 * file and prompts do. It is a LOCAL repo file (never a \\wsl$ path), so unlike the runtime
 * manifest it reads even when WSL is down. A missing/malformed catalog is a PACKAGING bug
 * and MUST fail loud (no silent fallback to an inline default). Read fresh each call (the
 * file is tiny) so editing tuning + re-running takes effect without an app restart.
 */
function loadTuningCatalog(): Map<string, OrpheusManifestEntry> {
  const dataPath = path.join(__dirname, 'data', 'orpheus-models.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to load Orpheus model tuning catalog from ${dataPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error(`Orpheus model tuning catalog is malformed (expected {models:[...]}): ${dataPath}`);
  }
  const map = new Map<string, OrpheusManifestEntry>();
  for (const e of models) {
    if (e && typeof (e as OrpheusManifestEntry).id === 'string') {
      map.set((e as OrpheusManifestEntry).id, e as OrpheusManifestEntry);
    }
  }
  return map;
}

/**
 * The RENDER-BEHAVIOUR fields. These have exactly ONE source of truth at runtime:
 * the repo tuning catalog. They are deliberately NOT read from the per-machine
 * runtime install manifest — see applyTuning.
 */
const TUNING_KEYS = [
  'maxChars',
  'maxCharsPerSec',
  'repPenalty',
  'backends',
  'postRenderFilter',
  'sentenceGap',
  'minChunkGap',
  'measuredSentenceGapS',
] as const;

/** Warn once per (id, key) per process so a stale manifest doesn't spam every resolve. */
const warnedStaleTuning = new Set<string>();

/**
 * Combine a base entry (per-machine INVENTORY: which voices are installed, where the
 * folder is, where it came from) with the repo tuning catalog (machine-independent
 * RENDER BEHAVIOUR: caps, backends, filters, gaps).
 *
 * The two roles do not overlap and there is NO fallback between them. Tuning comes
 * from the catalog or nowhere:
 *
 *  - Catalogued voice  → the catalog's tuning, in full.
 *  - Uncatalogued voice (hand-dropped folder, or installed but not yet added to the
 *    repo) → NO tuning, so e2a applies its own documented defaults. "Absent means
 *    absent" is the stated contract for every cap; it is not a fallback.
 *  - Tuning fields sitting in the runtime manifest → IGNORED and reported. They are
 *    stale hand-edits (the installer writes inventory only, and upsertManifestEntry
 *    replaces entries wholesale, so it cannot preserve them anyway). Honouring them
 *    would resurrect exactly the bug this split removes: two copies of a measured
 *    rate on disk, disagreeing, with the loser invisible.
 *
 * A missing/malformed catalog already throws in loadTuningCatalog — it is a packaging
 * bug, never a reason to fall back to the other copy.
 */
function applyTuning<T extends { id: string }>(base: T, catalog: Map<string, OrpheusManifestEntry>): T {
  const stripped = { ...base } as Record<string, unknown>;
  for (const key of TUNING_KEYS) {
    if (stripped[key] === undefined) continue;
    const warnKey = `${base.id}.${key}`;
    if (!warnedStaleTuning.has(warnKey)) {
      warnedStaleTuning.add(warnKey);
      console.warn(
        `[ORPHEUS-MODELS] Ignoring '${key}' on the runtime manifest entry for '${base.id}': ` +
          `per-voice tuning is owned solely by the repo catalog (electron/data/orpheus-models.json). ` +
          `Remove it from the runtime models.json to silence this.`,
      );
    }
    delete stripped[key];
  }
  const cat = catalog.get(base.id);
  return (cat ? { ...stripped, ...cat } : stripped) as T;
}

/**
 * A folder holds a FULL model when it has config.json + at least one safetensors
 * shard. This is the original `isModelFolder` predicate, unchanged — it identifies
 * both a legacy MERGED voice folder and the shared BASE folder, which have the same
 * on-disk shape.
 */
function isFullModelFolder(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

/** A MERGED voice folder: a full fine-tune, loadable as the model itself. */
function isMergedModelFolder(dir: string): boolean {
  return isFullModelFolder(dir);
}

/**
 * The shared BASE folder — a full model, checked SHARD BY SHARD.
 *
 * The base is the one artifact whose download can be interrupted and leave something
 * that still looks valid: config.json lands first and the ~6.6 GB of weights arrive in
 * two shards, so a download killed between them satisfies "config.json + at least one
 * .safetensors". That half-install then reads as INSTALLED everywhere — the Settings
 * card says Installed, resolveOrpheusBase hands the path to a render, and the failure
 * finally surfaces as an opaque vLLM error deep inside a job, with no way to retry the
 * download from the UI because nothing thinks anything is missing.
 *
 * So when the model declares a shard index (`model.safetensors.index.json`, which every
 * sharded HF checkpoint including this base ships), every shard it names must be present
 * and non-empty. A single-file checkpoint has no index and keeps the original check, with
 * the size test added: a 0-byte weights file is never a finished download.
 *
 * Note this is only reachable when the folder can actually be READ. On Windows the base
 * is typically an untraversable `\\wsl$` symlink, which baseInstallState reports as
 * `unverifiable` without calling this at all — see its doc block.
 */
function isBaseModelFolder(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
    const nonEmpty = (name: string): boolean => {
      try {
        return fs.statSync(path.join(dir, name)).size > 0;
      } catch {
        return false;
      }
    };
    const indexPath = path.join(dir, 'model.safetensors.index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const weightMap = index?.weight_map;
      if (!weightMap || typeof weightMap !== 'object') return false;
      const shards = new Set<string>(Object.values(weightMap as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
      if (shards.size === 0) return false;
      return [...shards].every(nonEmpty);
    }
    return fs.readdirSync(dir).some((f) => f.endsWith('.safetensors') && nonEmpty(f));
  } catch {
    return false;
  }
}

/**
 * A LoRA ADAPTER folder: PEFT's adapter_config.json + the adapter weights. A folder
 * with only one of the two is a half-finished download, not an adapter, and must not
 * resolve — vLLM would fail deep inside engine start with an opaque error.
 */
function isAdapterFolder(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'adapter_config.json'))) return false;
    return fs.readdirSync(dir).some((f) => f === 'adapter_model.safetensors' || f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

/** The base repo an adapter folder declares (PEFT `base_model_name_or_path`), or null.
 *  Used ONLY to reconcile a hand-dropped adapter that has no catalog/manifest entry. */
function readAdapterBaseRef(dir: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'adapter_config.json'), 'utf-8'));
    const ref = cfg?.base_model_name_or_path;
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
}

/** The folder name a base ref occupies under `<models>/_base/`. */
export function orpheusBaseFolderName(base: OrpheusBaseRef): string {
  return base.dir || base.ref.split('/').pop()!;
}

/**
 * Is the shared base installed, and can we PROVE it from this process?
 *
 *  - `valid`        — a real directory we read, holding config.json + weights.
 *  - `unverifiable` — the entry exists as a SYMLINK we cannot traverse. This is the
 *                     normal, expected state on Windows: the deploy script points
 *                     `_base/orpheus-3b-0.1-ft` at the WSL HuggingFace cache
 *                     (`/home/…/.cache/huggingface/hub/models--unsloth--…/snapshots/…`),
 *                     and over the `\\wsl$` 9p mount Windows surfaces that WSL-native
 *                     symlink as a reparse point it refuses to resolve — readdir on
 *                     the parent reports `isSymbolicLink()`, while stat/readdir/
 *                     readlink of the link itself all fail (verified 2026-08-03:
 *                     ENOENT, ENOENT, EISDIR respectively). The consumer of this path
 *                     is the WSL-side spawn, where the link resolves natively, so we
 *                     treat it as installed and say so — while recording that we did
 *                     not verify it, so a genuinely broken link surfaces as a loud
 *                     e2a-side error rather than a wrong silent render.
 *  - `absent`       — no such entry, or a directory that isn't a model.
 */
export type OrpheusBaseState = 'valid' | 'unverifiable' | 'absent';

function baseInstallState(folder: string): { state: OrpheusBaseState; dir: string } {
  const dir = path.join(getOrpheusModelsDir(), BASE_SUBDIR, folder);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(path.join(getOrpheusModelsDir(), BASE_SUBDIR), { withFileTypes: true });
  } catch {
    return { state: 'absent', dir };
  }
  const found = dirents.find((d) => d.name === folder);
  if (!found) return { state: 'absent', dir };
  if (found.isDirectory()) return { state: isBaseModelFolder(dir) ? 'valid' : 'absent', dir };
  if (found.isSymbolicLink()) {
    // Traversable symlink (any real POSIX host, or a Windows junction): verify it.
    try {
      fs.statSync(dir);
      return { state: isBaseModelFolder(dir) ? 'valid' : 'absent', dir };
    } catch {
      // Untraversable. On win32 that is the \\wsl$ LX-symlink case described above.
      // Anywhere else an unstattable symlink is simply broken.
      return { state: process.platform === 'win32' ? 'unverifiable' : 'absent', dir };
    }
  }
  return { state: 'absent', dir };
}

/**
 * Resolve the shared base model an adapter needs: its absolute dir plus whether the
 * install could be verified from this process. Returns null when the base is NOT
 * installed — callers decide whether that is a listing annotation or a hard error.
 * WSL-gated like every other entry point here (a sync stat of `\\wsl$` on a wedged VM
 * hangs the main thread).
 */
export function resolveOrpheusBase(base: OrpheusBaseRef): { dir: string; verified: boolean } | null {
  if (!orpheusDirAccessible()) {
    throw new Error(isWslWedged() ? wslWedgedMessage() : `WSL is not responding — cannot resolve the Orpheus base model '${base.ref}' from the \\\\wsl$ models directory.`);
  }
  const { state, dir } = baseInstallState(orpheusBaseFolderName(base));
  if (state === 'absent') return null;
  return { dir, verified: state === 'valid' };
}

/** True when the shared base for `base` is installed (verified or symlink-present). */
export function isOrpheusBaseInstalled(base: OrpheusBaseRef): boolean {
  return resolveOrpheusBase(base) !== null;
}

/**
 * The base model the STOCK Orpheus voices are, as a base ref.
 *
 * `ref` mirrors e2a `Orpheus.TRANSFORMERS_MODEL` — the repo the stock vLLM path
 * loads when no local dir is given. A `_base/` install of that repo therefore holds
 * BYTE-IDENTICAL weights to what a stock load would fetch from the HuggingFace cache;
 * the only difference is where they are read from.
 *
 * `id` matches the base every adapter voice in the catalog declares, which is what
 * makes the two resolve to the same folder — and that identity is the whole point:
 * see resolveOrpheusStockBase.
 */
export const ORPHEUS_STOCK_BASE: OrpheusBaseRef = {
  id: 'orpheus-3b-base',
  ref: 'unsloth/orpheus-3b-0.1-ft',
};

/**
 * Where a stock Orpheus voice should be served from, or null when the shared base
 * isn't installed and it must come from the HuggingFace cache as before.
 *
 * This exists for the streaming server's engine cache key. That key is the pair
 * (merged dir, base dir), so a stock voice loaded WITHOUT a base dir keys as
 * (null, null) while an adapter voice keys as (null, `_base/…`) — two different
 * engines for weights that are the same file. Every stock↔adapter switch then tore
 * down a 6 GB engine for nothing, and worse, the stock half loaded by HF repo NAME,
 * so on a cold cache it could start a multi-GB download in the middle of a listening
 * session. Pointing stock at the installed base collapses both keys into one.
 *
 * Only meaningful on vLLM: MLX loads a DIFFERENT repo for stock
 * (`mlx-community/orpheus-3b-0.1-ft-bf16`, e2a `Orpheus.MLX_MODEL`), so handing it
 * this folder would be handing it the wrong artifact. Callers gate on the backend.
 */
export function resolveOrpheusStockBase(): { dir: string; verified: boolean } | null {
  return resolveOrpheusBase(ORPHEUS_STOCK_BASE);
}

/**
 * Which artifact form of a voice is installed, and where.
 *
 * Returns null when NEITHER form is on disk (i.e. "not an installed custom voice" —
 * exactly what the pre-adapter `isModelFolder` check returned false for).
 *
 * THROWS when the active form is an adapter that cannot be served: no base declared,
 * or a base that isn't installed. That is deliberate and is the whole point of the
 * NO-FALLBACK rule here — a machine mid-migration can easily have BOTH a merged copy
 * and an adapter for the same voice, and quietly serving the merged copy because the
 * base download failed would hide the failure behind subtly different audio.
 */
function resolveOrpheusInstall(
  entry: OrpheusManifestEntry,
  purpose: OrpheusServePurpose,
): { artifact: OrpheusArtifact; dir: string; baseDir?: string; base?: OrpheusBaseRef } | null {
  const root = getOrpheusModelsDir();
  const mergedDir = path.join(root, entry.dir || entry.id);
  const adapterDir = path.join(root, ADAPTERS_SUBDIR, entry.adapterDir || entry.id);
  const hasMerged = isMergedModelFolder(mergedDir);
  const hasAdapter = isAdapterFolder(adapterDir);
  if (!hasMerged && !hasAdapter) return null;

  // Both installed → an EXPLICIT `artifact` on the entry still pins the form (a curated
  // override survives everything); absent, the CALLER'S PURPOSE decides — merged for the
  // batch workers, and for the streaming server whatever `orpheusStreamingArtifact` says
  // (default merged). See OrpheusServePurpose for what each form costs and why neither
  // choice is a NO-FALLBACK breach.
  // One installed → that one (see the OrpheusManifestEntry.artifact doc block).
  //
  // ┌── CANONICAL: EVERY PLATFORM CAN SERVE A LoRA (stage B2, 2026-08-04) ─────────────┐
  // │ This is the ONE statement of how the two artifact forms relate on each platform; │
  // │ everything else that mentions the fuse (orpheus_fuse.py, runFuse + the install's  │
  // │ third phase in orpheus-hf-catalog.ts, the 'fuse' progress phase in preload.ts and │
  // │ the voices panel) points HERE instead of restating it.                            │
  // │                                                                                   │
  // │ There is no longer a darwin exception. e2a's orpheus.py applies a PEFT adapter to │
  // │ the resident MLX model by wrapping its projection modules (_apply_mlx_adapter —   │
  // │ stage B2 of ORPHEUS_ADAPTER_MIGRATION.md work area B), so the Mac CAN serve base +│
  // │ adapter directly. That capability is what makes the choice a SETTING rather than  │
  // │ a platform fact: nothing here branches on os any more.                            │
  // │                                                                                   │
  // │ What B2 bought — a voice switch that swaps wrappers instead of reloading 6.2 GB — │
  // │ is real but is deliberately NOT taken by default any more (2026-08-10). Measured  │
  // │ against how streaming actually behaves, a warm switch still waits ~20-30 s for    │
  // │ the next sentence, so the saving it delivers is far smaller than the ~10-20%      │
  // │ per-token cost the LoRA path adds to EVERY sentence. Set                          │
  // │ `orpheusStreamingArtifact: "adapter"` to take that trade the other way.           │
  // │                                                                                   │
  // │ The install-time fuse is NOT removed by B2 and its output is not dead: a fused    │
  // │ copy is what an explicit `artifact: 'merged'` pin selects, and it is the only     │
  // │ form that survives the shared base being uninstalled. Retiring the fuse phase is  │
  // │ a separate decision, recorded as owed in the migration doc.                       │
  // └───────────────────────────────────────────────────────────────────────────────────┘
  const preferred: OrpheusArtifact =
    entry.artifact !== undefined
      ? entry.artifact
      : purpose === 'stream'
        ? getOrpheusStreamingArtifact()
        : 'merged';
  const active: OrpheusArtifact =
    hasMerged && hasAdapter ? preferred : hasAdapter ? 'adapter' : 'merged';

  if (active === 'merged') return { artifact: 'merged', dir: mergedDir };

  const base = entry.base;
  if (!base) {
    throw new Error(
      `Orpheus voice '${entry.id}' is installed as a LoRA adapter (${adapterDir}) but declares no base model. ` +
        `Add a "base" reference to its catalog entry (electron/data/orpheus-models.json) or reinstall the voice.`,
    );
  }
  const resolvedBase = resolveOrpheusBase(base);
  if (!resolvedBase) {
    throw new Error(
      `Orpheus voice '${entry.id}' is a LoRA adapter and needs the shared base model '${base.ref}', ` +
        `which is not installed (expected ${path.join(root, BASE_SUBDIR, orpheusBaseFolderName(base))}). ` +
        `Install it from Settings → Orpheus Voices — refusing to render this voice without its base.`,
    );
  }
  return { artifact: 'adapter', dir: adapterDir, baseDir: resolvedBase.dir, base };
}

/** Prettify a folder name into a display label: "owen-morgan_v2" → "Owen Morgan V2". */
function prettyLabel(folder: string): string {
  return folder
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The per-voice tuning fields, spread onto a model only when actually declared. */
type OrpheusTuningFields = Pick<
  OrpheusModel,
  'maxChars' | 'maxCharsPerSec' | 'repPenalty' | 'backends' | 'postRenderFilter' | 'sentenceGap' | 'minChunkGap' | 'measuredSentenceGapS'
>;
function tuningFields(e: OrpheusManifestEntry): OrpheusTuningFields {
  return {
    ...(e.maxChars !== undefined ? { maxChars: e.maxChars } : {}),
    ...(e.maxCharsPerSec !== undefined ? { maxCharsPerSec: e.maxCharsPerSec } : {}),
    ...(e.repPenalty !== undefined ? { repPenalty: e.repPenalty } : {}),
    ...(e.backends !== undefined ? { backends: e.backends } : {}),
    ...(e.postRenderFilter !== undefined ? { postRenderFilter: e.postRenderFilter } : {}),
    ...(e.sentenceGap !== undefined ? { sentenceGap: e.sentenceGap } : {}),
    ...(e.minChunkGap !== undefined ? { minChunkGap: e.minChunkGap } : {}),
    ...(e.measuredSentenceGapS !== undefined ? { measuredSentenceGapS: e.measuredSentenceGapS } : {}),
  };
}

/**
 * Installed custom Orpheus models, sorted by label. Manifest-first (so the token
 * is authoritative), with valid-but-unlisted folders auto-imported (token guessed
 * as the folder name) so manually-dropped folders still appear.
 *
 * ADOPTION (how a hand-deployed adapter becomes visible with no re-download): the
 * reconcile pass now scans THREE places — top-level merged folders (skipping the
 * `adapters/` and `_base/` layout dirs), `adapters/<id>/`, and `_base/<name>/`. An
 * adapter folder whose id already has a manifest entry AUGMENTS that entry rather
 * than adding a second one: there is exactly one entry per voice, and its `artifact`
 * says which install is served. An adapter with no entry anywhere synthesises its
 * base ref from the adapter's own PEFT `base_model_name_or_path`. Reconcile is
 * read-only (in-memory) exactly as before — nothing here writes models.json, which
 * also keeps this safe to call while the models dir is a `\\wsl$` mount.
 *
 * `kind: 'base'` records and `_base/` folders are NOT voices and never appear in this
 * list; use listOrpheusBases().
 *
 * An adapter voice whose base is missing is listed with `baseMissing: true` instead
 * of throwing — a broken voice must stay visible so the UI can explain it. The RENDER
 * path (resolveOrpheusModel) throws for that same voice.
 */
export function listOrpheusModels(
  purpose: OrpheusServePurpose = 'batch',
): OrpheusModel[] {
  if (!orpheusDirAccessible()) {
    console.warn('[ORPHEUS-MODELS] listOrpheusModels skipped — WSL not responding (models dir is \\\\wsl$); returning no custom models');
    return [];
  }
  const root = getOrpheusModelsDir();
  const manifest = readManifest();
  const catalog = loadTuningCatalog();
  const out: OrpheusModel[] = [];
  const emitted = new Set<string>();

  // Build a picker entry, overlaying the repo tuning catalog (catalog wins) and
  // resolving which artifact form is installed. Returns null when nothing is on disk.
  // A base-missing adapter is annotated, not thrown (see the doc block).
  const build = (base: OrpheusManifestEntry): OrpheusModel | null => {
    const e = applyTuning<OrpheusManifestEntry>(base, catalog);
    if (e.kind === 'base') return null;
    try {
      const install = resolveOrpheusInstall(e, purpose);
      if (!install) return null;
      return {
        id: e.id, label: e.label || prettyLabel(e.id), voice: e.token || e.id,
        dir: install.dir, artifact: install.artifact,
        ...(install.baseDir !== undefined ? { baseDir: install.baseDir } : {}),
        ...(install.base !== undefined ? { base: install.base } : {}),
        ...tuningFields(e),
      };
    } catch (err) {
      // Adapter installed but unusable (no base declared / base not installed). Show it
      // as broken so the panel can say what to do; the render path still throws.
      const adapterDir = path.join(root, ADAPTERS_SUBDIR, e.adapterDir || e.id);
      if (!isAdapterFolder(adapterDir)) throw err;
      console.warn(`[ORPHEUS-MODELS] ${err instanceof Error ? err.message : String(err)}`);
      return {
        id: e.id, label: e.label || prettyLabel(e.id), voice: e.token || e.id,
        dir: adapterDir, artifact: 'adapter', baseMissing: true,
        ...(e.base !== undefined ? { base: e.base } : {}),
        ...tuningFields(e),
      };
    }
  };

  const push = (entry: OrpheusManifestEntry): void => {
    if (emitted.has(entry.id)) return;
    const m = build(entry);
    if (m) { out.push(m); emitted.add(m.id); }
  };

  // 1) Manifest VOICE entries with a real install (merged and/or adapter).
  for (const e of manifest.models) push(e);

  const listed = new Set(manifest.models.map((e) => e.id));
  const readDirents = (dir: string): fs.Dirent[] => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  };

  // 2) Reconcile top-level MERGED folders not in the manifest (dropped by hand). Still
  //    overlay the catalog so a catalogued-but-unlisted voice shows its curated
  //    label/token/tuning; an uncatalogued folder guesses token = folder name.
  //    `adapters/`, `_base/`, `.fusework/` and any `<id>.previous` are LAYOUT or scratch,
  //    never voices — skipped explicitly (isScannableVoiceFolder) so a full-model shape in
  //    any of them can never be mistaken for a voice folder. The two dotted ones matter
  //    most: both hold a COMPLETE model at some point, and adoption is by location.
  for (const d of readDirents(root)) {
    if (!d.isDirectory() || !isScannableVoiceFolder(d.name) || listed.has(d.name)) continue;
    if (!isMergedModelFolder(path.join(root, d.name))) continue;
    push({ id: d.name } as OrpheusManifestEntry);
  }

  // 3) Reconcile ADAPTER folders not in the manifest — this is how a machine whose
  //    adapters were rsync'd/deployed by hand sees them without re-downloading. An
  //    uncatalogued adapter takes its base ref from its own adapter_config.json.
  for (const d of readDirents(path.join(root, ADAPTERS_SUBDIR))) {
    if (!d.isDirectory() || emitted.has(d.name)) continue;
    const dir = path.join(root, ADAPTERS_SUBDIR, d.name);
    if (!isAdapterFolder(dir)) continue;
    const declaredRef = readAdapterBaseRef(dir);
    push({
      id: d.name,
      artifact: 'adapter',
      ...(declaredRef ? { base: { id: declaredRef, ref: declaredRef } } : {}),
    } as OrpheusManifestEntry);
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * Which artifact FORMS of a voice are on disk, independent of which one would be served.
 *
 * Exists because "is this voice installed?" stopped being one question the moment both
 * forms became the steady state. Two callers need the per-form answer and would both be
 * wrong asking listOrpheusModels (which reports the ONE form a given purpose resolves to):
 *
 *  - the HF catalog's per-repo Download button: the merged repo and the `-lora` repo of
 *    one voice share an id, so an id-level "installed" check marks the fused copy as
 *    already present the moment the adapter lands, and the Download that would actually
 *    fetch it is disabled.
 *  - the base's dependants list: a voice still NEEDS the shared base whenever its adapter
 *    is on disk, even when batch renders resolve to the merged copy and never touch it.
 *
 * Mirrors resolveOrpheusInstall's folder derivation exactly (catalog-overlaid `dir` /
 * `adapterDir`, defaulting to the id) so the two can never disagree about where a form
 * lives. Reports both false when the models dir is unreachable, matching what
 * listOrpheusModels does in that state — the caller renders "not installed", never a
 * claim that something IS installed.
 */
export function installedArtifactsFor(id: string): { merged: boolean; adapter: boolean } {
  if (!orpheusDirAccessible()) {
    console.warn(`[ORPHEUS-MODELS] installedArtifactsFor('${id}') skipped — WSL not responding`);
    return { merged: false, adapter: false };
  }
  const root = getOrpheusModelsDir();
  const runtime = readManifest().models.find((e) => e.id === id);
  const entry = applyTuning<OrpheusManifestEntry>(
    { id, ...(runtime ?? {}) } as OrpheusManifestEntry,
    loadTuningCatalog(),
  );
  return {
    merged: isMergedModelFolder(path.join(root, entry.dir || id)),
    adapter: isAdapterFolder(path.join(root, ADAPTERS_SUBDIR, entry.adapterDir || id)),
  };
}

/** One installed shared base model. */
export interface OrpheusBaseInstall {
  /** Folder name under `_base/`. */
  folder: string;
  /** Absolute path (`--orpheus_base_dir`). */
  dir: string;
  /** False when the install is an untraversable symlink (see baseInstallState). */
  verified: boolean;
}

/**
 * The shared base models installed under `_base/`. Manifest `kind: 'base'` records
 * first, then any `_base/<name>/` folder not already listed (the adoption path for a
 * base that was deployed/symlinked by hand — which is exactly how the dev machine's
 * base was set up, as a symlink into the WSL HuggingFace cache).
 */
export function listOrpheusBases(): OrpheusBaseInstall[] {
  if (!orpheusDirAccessible()) {
    console.warn('[ORPHEUS-MODELS] listOrpheusBases skipped — WSL not responding (models dir is \\\\wsl$)');
    return [];
  }
  const root = getOrpheusModelsDir();
  const out: OrpheusBaseInstall[] = [];
  const seen = new Set<string>();
  const add = (folder: string): void => {
    if (seen.has(folder)) return;
    const { state, dir } = baseInstallState(folder);
    if (state === 'absent') return;
    seen.add(folder);
    out.push({ folder, dir, verified: state === 'valid' });
  };
  for (const e of readManifest().models) {
    if (e.kind !== 'base') continue;
    add(e.base ? orpheusBaseFolderName(e.base) : e.dir || e.id);
  }
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(path.join(root, BASE_SUBDIR), { withFileTypes: true });
  } catch {
    dirents = [];
  }
  for (const d of dirents) {
    if (d.isDirectory() || d.isSymbolicLink()) add(d.name);
  }
  return out;
}

/**
 * Resolve a selected voice id to its model dir + prompt token, or null when the id
 * is not an installed custom model (i.e. it's a built-in voice). Uses the manifest
 * token when present, else falls back to id-as-token for an unlisted folder.
 *
 * `purpose` decides which artifact form a both-installed voice resolves to — merged for
 * the batch workers, adapter for the resident streaming server (see OrpheusServePurpose).
 * It is REQUIRED rather than defaulted: every caller knows which path it is, and a
 * default would silently hand one path the other's form.
 *
 * This is the RENDER path, so unlike listOrpheusModels it FAILS LOUDLY rather than
 * annotating: when the resolved form IS the adapter and its base model is missing (or it
 * declares no base), this throws.
 *
 * Note what that does and does not forbid, because the two look alike. Serving the merged
 * copy of a voice under `purpose: 'batch'` is now the INTENDED routing, and is safe
 * because the two forms are the same weights (verified 2026-08-09: 28.3 M sampled
 * elements per voice, zero differing). What stays forbidden is reaching the merged copy
 * as a CONSOLATION for an adapter that could not be served — a failed base download
 * silently producing a render nobody knows took a different path. Since the form is
 * chosen from `purpose` before the base is ever looked at, that substitution has no way
 * to happen: 'stream' resolves the adapter and throws, it never quietly retargets.
 */
export function resolveOrpheusModel(
  id: string | undefined | null,
  purpose: OrpheusServePurpose,
): OrpheusModel | null {
  if (!id) return null;
  // THROW rather than return null here: a null means "built-in voice", and silently
  // downgrading a custom voice to a built-in because WSL happens to be down would
  // render the whole book with the wrong voice. Fail loudly instead.
  if (!orpheusDirAccessible()) {
    throw new Error(isWslWedged() ? wslWedgedMessage() : `WSL is not responding — cannot resolve Orpheus voice '${id}' from the \\\\wsl$ models directory.`);
  }
  const runtime = readManifest().models.find((e) => e.id === id);
  // Overlay the repo tuning catalog (authoritative for tuning) onto the runtime install
  // entry. Catalog wins for any field it declares; install-specific fields (dir/addedAt/
  // source) fall through from the runtime entry. A catalogued-but-unlisted voice still
  // resolves (base {id} + catalog dir/token/tuning). An uncatalogued voice uses runtime.
  const entry = applyTuning<OrpheusManifestEntry>(
    { id, ...(runtime ?? {}) } as OrpheusManifestEntry,
    loadTuningCatalog(),
  );
  // A base record is not a voice: selecting one must read as "unknown id", not as a
  // voice that renders in the base model's stock timbre.
  if (entry.kind === 'base') return null;
  // Reconcile seam: an adapter deployed by hand has no manifest entry at all, so pick
  // its base ref off its own adapter_config.json — the same adoption listOrpheusModels
  // does, so the picker and the renderer agree on what is installed.
  if (!entry.base) {
    const adapterDir = path.join(getOrpheusModelsDir(), ADAPTERS_SUBDIR, entry.adapterDir || id);
    if (isAdapterFolder(adapterDir)) {
      const declaredRef = readAdapterBaseRef(adapterDir);
      if (declaredRef) entry.base = { id: declaredRef, ref: declaredRef };
    }
  }
  const install = resolveOrpheusInstall(entry, purpose);
  if (!install) return null;
  return {
    id, label: entry.label || prettyLabel(id), voice: entry.token || id,
    dir: install.dir, artifact: install.artifact,
    ...(install.baseDir !== undefined ? { baseDir: install.baseDir } : {}),
    ...(install.base !== undefined ? { base: install.base } : {}),
    // Optional per-voice caps ride along only when declared (catalog or manifest); an
    // unlisted, uncatalogued hand-dropped folder has none.
    ...tuningFields(entry),
  };
}

/**
 * Flatten a resolved model's per-voice caps for the backend that will actually
 * render: the flat voice-level fields, each overridden by the `backends.{mlx,vllm}`
 * overlay when that backend declares it. Absent stays absent (NO FALLBACK) so
 * callers can tell "voice declares nothing" (→ let e2a default) from a real value.
 *
 * Backend selection MUST mirror e2a orpheus.py `_detect_backend()`: MLX on Darwin,
 * vLLM everywhere else (including Windows-native and WSL/Linux CUDA).
 *
 * Single source of truth for BOTH consumers: the audiobook worker spawn env
 * (parallel-tts-bridge orpheusVoiceCaps) and the resident streaming server
 * (orpheus-worker-pool's voice load). Those used to disagree — the streaming
 * server set no caps at all, so a fast voice ran against e2a's 19.0 chars/sec
 * default and its previews tripped the truncation guard where the book render
 * (which does pass the catalog value) did not.
 */
export function orpheusVoiceCapsForModel(model: OrpheusModel): OrpheusVoiceCaps {
  const backend: 'mlx' | 'vllm' = process.platform === 'darwin' ? 'mlx' : 'vllm';
  const overlay = model.backends?.[backend] ?? {};
  const caps: OrpheusVoiceCaps = {};
  if (model.maxChars !== undefined) caps.maxChars = model.maxChars;
  if (model.maxCharsPerSec !== undefined) caps.maxCharsPerSec = model.maxCharsPerSec;
  if (model.repPenalty !== undefined) caps.repPenalty = model.repPenalty;
  if (model.sentenceGap !== undefined) caps.sentenceGap = model.sentenceGap;
  if (overlay.maxChars !== undefined) caps.maxChars = overlay.maxChars;
  if (overlay.maxCharsPerSec !== undefined) caps.maxCharsPerSec = overlay.maxCharsPerSec;
  if (overlay.repPenalty !== undefined) caps.repPenalty = overlay.repPenalty;
  // EOS boost is vLLM-only by nature — declared via backends.vllm, never flat.
  if (overlay.eosBoost !== undefined) caps.eosBoost = overlay.eosBoost;
  if (overlay.eosBoostStart !== undefined) caps.eosBoostStart = overlay.eosBoostStart;
  return caps;
}

/**
 * The FINAL-encode ffmpeg audio-filter chain declared on an Orpheus voice's manifest
 * entry, or undefined when the voice declares none (or is not a resolvable custom
 * voice — a stock/hand-dropped/unknown id). This is the SHARED read-path handler for
 * the post-render filter: both assembly sites call it (parallel-tts-bridge runAssembly
 * for the direct TTS→assemble path, reassembly-bridge startReassembly for the
 * reassembly/CLI-audiobook path) so the value is resolved identically everywhere.
 * Throws (via resolveOrpheusModel) if the models dir is a \\wsl$ path and WSL is down —
 * we never silently render an artifact-laden file because the manifest couldn't be read.
 */
export function resolveOrpheusPostRenderFilter(id: string | undefined | null): string | undefined {
  return resolveOrpheusModel(id, 'batch')?.postRenderFilter;
}

/**
 * The universal, user-VISIBLE inter-sentence gap default (seconds) for an Orpheus voice
 * whose manifest declares NO tuned `sentenceGap` — i.e. the gap tests haven't been run
 * for that model yet. It is surfaced pre-filled in the assembly-page gap field (not
 * hidden) so the user knows they're looking at the "untested model" default and can
 * override it. This is the SINGLE permitted default in the gap feature — no other code
 * path may invent one. 0.6s reproduces the historical baked gap Orpheus/e2a produced.
 */
export const DEFAULT_SENTENCE_GAP = 0.6;

/**
 * The per-voice DEFAULT assembly-time inter-sentence gap (seconds) declared on an
 * Orpheus voice's manifest entry, or undefined when the voice declares none (or is not
 * a resolvable custom voice). Mirrors resolveOrpheusPostRenderFilter — the SHARED
 * read-path handler so every assembly site resolves the value identically. Throws (via
 * resolveOrpheusModel) if the models dir is a \\wsl$ path and WSL is down — we never
 * silently skip the gap step because the manifest couldn't be read. Returns the RAW
 * manifest value (undefined when untested); callers apply DEFAULT_SENTENCE_GAP visibly.
 */
export function resolveOrpheusSentenceGap(id: string | undefined | null): number | undefined {
  return resolveOrpheusModel(id, 'batch')?.sentenceGap;
}

/**
 * The voice's assembly-time FLOOR on chunk trailing silence, in seconds.
 * Undefined = no floor (chunk joins are the model's bare trained tail).
 */
export function resolveOrpheusMinChunkGap(id: string | undefined | null): number | undefined {
  return resolveOrpheusModel(id, 'batch')?.minChunkGap;
}
